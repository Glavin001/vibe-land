#include <cuda_runtime.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
__global__ void probe(const float* values,unsigned* results){
 const unsigned i=threadIdx.x;
 results[3*i]=values[i]!=0.f;
 results[3*i+1]=(__float_as_uint(values[i])&0x7fffffffu)!=0;
 results[3*i+2]=__float_as_uint(values[i]);
}
int main(){
 const unsigned bits[]={0u,0x80000000u,0x000116c2u,0x800116c2u,0x0da24260u,0x3f000000u};
 float *input;unsigned *output,results[18]{};
 #define CHECK(call) do {const auto e=(call);if(e!=cudaSuccess){std::fprintf(stderr,"%s\n",cudaGetErrorString(e));return 2;}} while(0)
 CHECK(cudaMalloc(&input,sizeof(bits)));CHECK(cudaMalloc(&output,sizeof(results)));
 CHECK(cudaMemcpy(input,bits,sizeof(bits),cudaMemcpyHostToDevice));
 probe<<<1,6>>>(input,output);CHECK(cudaGetLastError());CHECK(cudaDeviceSynchronize());
 CHECK(cudaMemcpy(results,output,sizeof(results),cudaMemcpyDeviceToHost));
 for(unsigned i=0;i<6;++i)std::printf("input=%08x float_nonzero=%u bits_nonzero=%u observed=%08x\n",bits[i],results[3*i],results[3*i+1],results[3*i+2]);
 CHECK(cudaFree(input));CHECK(cudaFree(output));
}
