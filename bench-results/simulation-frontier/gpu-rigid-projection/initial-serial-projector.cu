#include "NvBlastExtStressGpuRigidProjector.h"
#include <cub/device/device_radix_sort.cuh>
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>

namespace Nv { namespace Blast { namespace Multilevel {
namespace {
constexpr uint32_t Invalid=UINT32_MAX, Threads=256;
void checked(cudaError_t e){if(e!=cudaSuccess)throw std::runtime_error(std::string("GPU rigid projector: ")+cudaGetErrorString(e));}
void require(bool ok,const char* text){if(!ok)throw std::runtime_error(text);}
template<class T> struct Buffer {
    T* data=nullptr;size_t count;
    explicit Buffer(size_t n):count(n){if(n)checked(cudaMalloc(&data,n*sizeof(T)));}
    ~Buffer(){cudaFree(data);}
    Buffer(const Buffer&)=delete;Buffer&operator=(const Buffer&)=delete;
    void upload(const std::vector<T>& v,cudaStream_t s){require(v.size()==count,"GPU rigid upload dimensions");if(count)checked(cudaMemcpyAsync(data,v.data(),count*sizeof(T),cudaMemcpyHostToDevice,s));}
};
struct Node {double position[3],angular,linear;}; // inverse D, not physical velocities
struct Edge {uint32_t a,b;};
struct Component {uint32_t begin,end,anchored;double center[3],factor[36];};
__device__ uint32_t rootOf(uint32_t* parents,uint32_t node){
    for(;;){const uint32_t next=atomicAdd(parents+node,0u);if(next==node)return node;node=next;}
}
__global__ void initialize(uint32_t n,uint32_t* parents,uint32_t* indices,Component* components){
    const auto i=blockIdx.x*blockDim.x+threadIdx.x;if(i>=n)return;
    parents[i]=indices[i]=i;components[i].begin=components[i].end=components[i].anchored=0;
}
__global__ void unite(uint32_t count,const Edge* edges,const uint8_t* live,uint32_t* parents){
    const auto i=blockIdx.x*blockDim.x+threadIdx.x;if(i>=count||!live[i])return;
    auto a=edges[i].a,b=edges[i].b;if(a==Invalid||b==Invalid)return;
    // Strictly decreasing root links cannot form a cycle. CAS retries a root
    // that another edge already changed; successful links never lose a union.
    for(;;){a=rootOf(parents,a);b=rootOf(parents,b);if(a==b)return;
        const auto high=max(a,b),low=min(a,b);
        if(atomicCAS(parents+high,high,low)==high)return;
    }
}
__global__ void compress(uint32_t n,uint32_t* parents){
    const auto i=blockIdx.x*blockDim.x+threadIdx.x;if(i<n)atomicMin(parents+i,rootOf(parents,i));
}
__global__ void anchors(uint32_t count,const Edge* edges,const uint8_t* live,const uint32_t* roots,Component* components){
    const auto i=blockIdx.x*blockDim.x+threadIdx.x;if(i>=count||!live[i])return;
    const auto a=edges[i].a,b=edges[i].b;
    if(a==Invalid)atomicOr(&components[roots[b]].anchored,1u);
    else if(b==Invalid)atomicOr(&components[roots[a]].anchored,1u);
}
__global__ void ranges(uint32_t n,const uint32_t* sortedRoots,Component* components){
    const auto i=blockIdx.x*blockDim.x+threadIdx.x;if(i>=n)return;const auto root=sortedRoots[i];
    if(i==0||sortedRoots[i-1]!=root)components[root].begin=i;
    if(i+1==n||sortedRoots[i+1]!=root)components[root].end=i+1;
}
__device__ double blockSum(double value,double* scratch){
    scratch[threadIdx.x]=value;__syncthreads();
    for(unsigned offset=Threads/2;offset;offset/=2){if(threadIdx.x<offset)scratch[threadIdx.x]+=scratch[threadIdx.x+offset];__syncthreads();}
    const double sum=scratch[0];__syncthreads();return sum;
}
__device__ void basis(const Node& node,const Node& origin,const Component& component,double length,double* r){
    for(unsigned i=0;i<36;++i)r[i]=0;
    const double x=((node.position[0]-origin.position[0])-component.center[0])/length;
    const double y=((node.position[1]-origin.position[1])-component.center[1])/length;
    const double z=((node.position[2]-origin.position[2])-component.center[2])/length;
    for(unsigned i=0;i<3;++i){r[i*6+i]=node.angular;r[(i+3)*6+i+3]=node.linear;}
    r[3*6+1]=-z*node.linear;r[3*6+2]=y*node.linear;
    r[4*6+0]=z*node.linear;r[4*6+2]=-x*node.linear;
    r[5*6+0]=-y*node.linear;r[5*6+1]=x*node.linear;
}
__global__ void centers(const Node* nodes,const uint32_t* sortedNodes,Component* components,int* failed){
    const auto root=blockIdx.x;auto& c=components[root];if(c.begin==c.end||c.anchored||c.end-c.begin==1)return;
    __shared__ double scratch[Threads];double sum[4]{};
    for(uint64_t i=uint64_t(c.begin)+threadIdx.x;i<c.end;i+=Threads){const auto& n=nodes[sortedNodes[i]];const double w=n.linear*n.linear;
        sum[0]+=w;for(unsigned k=0;k<3;++k)sum[k+1]+=(n.position[k]-nodes[root].position[k])*w;
    }
    for(unsigned k=0;k<4;++k)sum[k]=blockSum(sum[k],scratch);
    if(!threadIdx.x){if(!(sum[0]>0)||!isfinite(sum[0]))atomicExch(failed,1);
        for(unsigned k=0;k<3;++k){c.center[k]=sum[k+1]/sum[0];if(!isfinite(c.center[k]))atomicExch(failed,1);}
    }
}
__global__ void factors(const Node* nodes,const uint32_t* sortedNodes,Component* components,double length,int* failed){
    const auto root=blockIdx.x;auto& c=components[root];if(c.begin==c.end||c.anchored||c.end-c.begin==1)return;
    __shared__ double scratch[Threads];double sums[21]{};
    for(uint64_t i=uint64_t(c.begin)+threadIdx.x;i<c.end;i+=Threads){double r[36];basis(nodes[sortedNodes[i]],nodes[root],c,length,r);
        unsigned k=0;for(unsigned row=0;row<6;++row)for(unsigned col=0;col<=row;++col){
            double v=0;for(unsigned j=0;j<6;++j)v+=r[j*6+row]*r[j*6+col];sums[k++]+=v;
        }
    }
    unsigned k=0;for(unsigned row=0;row<6;++row)for(unsigned col=0;col<=row;++col){
        const double sum=blockSum(sums[k++],scratch);if(!threadIdx.x)c.factor[row*6+col]=sum;
    }
    if(threadIdx.x)return;
    // Centered 6x6 rigid Gram matrix, including the residual rotation/translation
    // cross terms. No assumption that floating-point centering made them zero.
    for(unsigned row=0;row<6;++row)for(unsigned col=0;col<=row;++col){
        double v=c.factor[row*6+col];for(unsigned j=0;j<col;++j)v-=c.factor[row*6+j]*c.factor[col*6+j];
        if(row==col){if(!(v>0)||!isfinite(v)){atomicExch(failed,1);return;}v=sqrt(v);}
        else v/=c.factor[col*6+col];
        if(!isfinite(v)){atomicExch(failed,1);return;}c.factor[row*6+col]=v;
    }
}
__global__ void coefficients(const Node* nodes,const uint32_t* sortedNodes,const Component* components,double length,
    const double* input,const double* subtract,double* coefficients,const int* failed,const int* skip){
    if((skip&&*skip)||*failed)return;const auto root=blockIdx.x;const auto& c=components[root];
    if(c.begin==c.end||c.anchored||c.end-c.begin==1)return;
    __shared__ double scratch[Threads];double sums[6]{};
    for(uint64_t i=uint64_t(c.begin)+threadIdx.x;i<c.end;i+=Threads){const auto id=sortedNodes[i];double r[36];basis(nodes[id],nodes[root],c,length,r);
        for(unsigned row=0;row<6;++row){const auto index=size_t(id)*6+row;const double value=input[index]-(subtract?subtract[index]:0.);
            for(unsigned k=0;k<6;++k)sums[k]+=r[row*6+k]*value;
        }
    }
    for(unsigned k=0;k<6;++k)sums[k]=blockSum(sums[k],scratch);
    if(threadIdx.x)return;
    for(unsigned i=0;i<6;++i){for(unsigned j=0;j<i;++j)sums[i]-=c.factor[i*6+j]*sums[j];sums[i]/=c.factor[i*6+i];}
    for(int i=5;i>=0;--i){for(unsigned j=i+1;j<6;++j)sums[i]-=c.factor[j*6+i]*sums[j];sums[i]/=c.factor[i*6+i];}
    for(unsigned k=0;k<6;++k)coefficients[size_t(root)*6+k]=sums[k];
}
__global__ void writeProjection(uint32_t n,const Node* nodes,const uint32_t* roots,const Component* components,double length,
    const double* input,const double* subtract,const double* coefficients,const double* base,double alpha,double* output,const int* failed,const int* skip){
    if(skip&&*skip)return;const auto id=blockIdx.x*blockDim.x+threadIdx.x;if(id>=n)return;
    const auto root=roots[id];const auto& c=components[root];double r[36];
    if(!c.anchored&&c.end-c.begin>1)basis(nodes[id],nodes[root],c,length,r);
    for(unsigned row=0;row<6;++row){const auto index=size_t(id)*6+row;double value=0;
        if(!c.anchored){if(c.end-c.begin==1)value=input[index]-(subtract?subtract[index]:0.);
            else for(unsigned k=0;k<6;++k)value+=r[row*6+k]*coefficients[size_t(root)*6+k];}
        output[index]=*failed?nan(""):(base?base[index]:0.)+alpha*value;
    }
}
}
struct GpuRigidProjector::Impl {
    cudaStream_t stream;uint32_t n,nb;double length;
    Buffer<Node> nodes;Buffer<Edge> edges;Buffer<uint8_t> live;
    Buffer<uint32_t> roots,sortedRoots,indices,sortedNodes;
    Buffer<Component> components;Buffer<double> coeff;Buffer<int> failed;
    std::unique_ptr<Buffer<uint8_t>> sortScratch;size_t sortBytes=0;
    Impl(const PhysicalGraph& graph,const std::vector<PhysicalBond>& bonds,cudaStream_t s):stream(s),n(uint32_t(graph.activeNodes.size())),nb(uint32_t(bonds.size())),length(graph.units.length),
        nodes(n),edges(nb),live(nb),roots(n),sortedRoots(n),indices(n),sortedNodes(n),components(n),coeff(size_t(n)*6),failed(1){
        require(graph.activeNodes.size()<=UINT32_MAX/6 && bonds.size()<=UINT32_MAX/6,"GPU projector index range");
        require(std::isfinite(length)&&length>0 && graph.scaling.size()==size_t(n)*6,"GPU projector normalization");
        std::vector<Node> host(n);std::vector<uint32_t> mapping(graph.nodes.size(),Invalid);
        for(uint32_t i=0;i<n;++i){const auto id=graph.activeNodes[i];require(id<graph.nodes.size() && mapping[id]==Invalid,"GPU projector active node mapping");mapping[id]=i;
            for(unsigned k=0;k<3;++k){host[i].position[k]=graph.nodes[id].position[k];require(std::isfinite(host[i].position[k]),"GPU projector node position");}
            for(unsigned k=0;k<6;++k)require(graph.scaling[i*6+k]==graph.scaling[i*6+(k<3?0:3)],"GPU projector requires scalar node inertia/mass scaling");
            host[i].angular=1/graph.scaling[i*6];host[i].linear=1/graph.scaling[i*6+3];
            require(host[i].angular>0 && host[i].linear>0 && std::isfinite(host[i].angular) && std::isfinite(host[i].linear),"GPU projector scaling range");
        }
        std::vector<Edge> hostEdges(nb);
        for(uint32_t i=0;i<nb;++i){const auto& b=bonds[i];require(b.node0<mapping.size()&&b.node1<mapping.size()&&b.node0!=b.node1,"GPU projector bond endpoints");
            hostEdges[i]={mapping[b.node0],mapping[b.node1]};require(hostEdges[i].a!=Invalid||hostEdges[i].b!=Invalid,"GPU projector bond has no dynamic endpoint");}
        nodes.upload(host,stream);edges.upload(hostEdges,stream);
        if(nb)checked(cudaMemsetAsync(live.data,1,nb,stream));
        if(n)checked(cub::DeviceRadixSort::SortPairs(nullptr,sortBytes,roots.data,sortedRoots.data,indices.data,sortedNodes.data,n,0,32,stream));
        sortScratch=std::make_unique<Buffer<uint8_t>>(sortBytes);
        checked(cudaStreamSynchronize(stream));
    }
    void update(){
        checked(cudaMemsetAsync(failed.data,0,sizeof(int),stream));if(!n)return;
        initialize<<<(n+Threads-1)/Threads,Threads,0,stream>>>(n,roots.data,indices.data,components.data);
        if(nb)unite<<<(nb+Threads-1)/Threads,Threads,0,stream>>>(nb,edges.data,live.data,roots.data);
        compress<<<(n+Threads-1)/Threads,Threads,0,stream>>>(n,roots.data);
        if(nb)anchors<<<(nb+Threads-1)/Threads,Threads,0,stream>>>(nb,edges.data,live.data,roots.data,components.data);
        checked(cub::DeviceRadixSort::SortPairs(sortScratch->data,sortBytes,roots.data,sortedRoots.data,indices.data,sortedNodes.data,n,0,32,stream));
        ranges<<<(n+Threads-1)/Threads,Threads,0,stream>>>(n,sortedRoots.data,components.data);
        centers<<<n,Threads,0,stream>>>(nodes.data,sortedNodes.data,components.data,failed.data);
        factors<<<n,Threads,0,stream>>>(nodes.data,sortedNodes.data,components.data,length,failed.data);
        checked(cudaGetLastError());
    }
};
GpuRigidProjector::GpuRigidProjector(const PhysicalGraph& graph,const std::vector<PhysicalBond>& bonds,cudaStream_t stream):impl(std::make_unique<Impl>(graph,bonds,stream)){impl->update();check();}
GpuRigidProjector::~GpuRigidProjector()=default;
uint32_t GpuRigidProjector::rows()const{return impl->n*6;}
uint32_t GpuRigidProjector::bonds()const{return impl->nb;}
void GpuRigidProjector::enqueueTopology(const uint8_t* live){
    require(live||!bonds(),"Missing GPU projector membership");
    if(bonds())checked(cudaMemcpyAsync(impl->live.data,live,bonds(),cudaMemcpyDeviceToDevice,impl->stream));impl->update();
}
void GpuRigidProjector::setLiveBonds(const std::vector<uint8_t>& live){
    require(live.size()==bonds()&&std::all_of(live.begin(),live.end(),[](uint8_t v){return v<=1;}),"GPU projector membership dimensions/values");
    impl->live.upload(live,impl->stream);impl->update();check();
}
void GpuRigidProjector::project(const double* input,double* output,const double* base,double alpha,const double* subtract,const int* skip){
    require((input&&output)||!rows(),"Missing GPU projection array");require(std::isfinite(alpha),"Invalid projection scale");if(!impl->n)return;
    coefficients<<<impl->n,Threads,0,impl->stream>>>(impl->nodes.data,impl->sortedNodes.data,impl->components.data,impl->length,input,subtract,impl->coeff.data,impl->failed.data,skip);
    writeProjection<<<(impl->n+Threads-1)/Threads,Threads,0,impl->stream>>>(impl->n,impl->nodes.data,impl->roots.data,impl->components.data,impl->length,input,subtract,impl->coeff.data,base,alpha,output,impl->failed.data,skip);
    checked(cudaGetLastError());
}
const int* GpuRigidProjector::deviceFailure()const{return impl->failed.data;}
void GpuRigidProjector::check()const{int failed;checked(cudaMemcpyAsync(&failed,impl->failed.data,sizeof(failed),cudaMemcpyDeviceToHost,impl->stream));checked(cudaStreamSynchronize(impl->stream));require(!failed,"GPU rigid basis factorization failed");}
std::vector<uint32_t> GpuRigidProjector::componentRoots()const{std::vector<uint32_t> roots(impl->n);if(impl->n)checked(cudaMemcpyAsync(roots.data(),impl->roots.data,roots.size()*sizeof(uint32_t),cudaMemcpyDeviceToHost,impl->stream));check();return roots;}

}}}
