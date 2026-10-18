// A GPU load of known intensity, for the GPU-contention experiment
// (scripts/perf/gpu-contention/ab.sh): stands in for a browser that
// renders at a fixed rate, without the browser.
//
//   metal-load --kind render|compute --busy-ms 8 --hz 60 --seconds 60 \
//              [--width 2560 --height 2048] [--out frames.csv] [--ready FILE] [--stop FILE]
//
// Every 1/hz seconds it submits one command buffer whose GPU time is about
// --busy-ms when the GPU is otherwise idle (calibrated at start-up). `render`
// is a full-screen fragment pass into an offscreen texture, like a browser
// frame; `compute` is one dispatch, like a CUDA kernel. Each frame's
// scheduled time, GPU start/end and completion are written to --out, so the
// load also measures how much the other GPU client delayed IT. At most two
// frames are in flight, as with a browser's swap chain: a frame that is not
// done blocks the next submission rather than queueing without bound.
// Public Metal API only.
import Foundation
import Metal
import QuartzCore

func arg(_ name: String, _ fallback: String) -> String {
  let a = CommandLine.arguments
  if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
  return fallback
}

let kind = arg("--kind", "render")
let busyMs = Double(arg("--busy-ms", "8"))!
let hz = Double(arg("--hz", "60"))!
let seconds = Double(arg("--seconds", "60"))!
let width = Int(arg("--width", "2560"))!
let height = Int(arg("--height", "2048"))!
let outPath = arg("--out", "")
let readyPath = arg("--ready", "")
let stopPath = arg("--stop", "")

guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
  fatalError("no Metal device")
}

let source = """
#include <metal_stdlib>
using namespace metal;
struct VOut { float4 pos [[position]]; };
vertex VOut vs(uint vid [[vertex_id]]) {
  float2 p = float2((vid << 1) & 2, vid & 2);
  VOut o; o.pos = float4(p * 2.0 - 1.0, 0.0, 1.0); return o;
}
static float burn(float x, uint iters) {
  float a = x, b = 1.0001;
  for (uint i = 0; i < iters; ++i) { a = fma(a, b, 0.0001); b = fma(b, 0.99999, 0.00001); }
  return a;
}
fragment float4 fs(VOut in [[stage_in]], constant uint& iters [[buffer(0)]]) {
  float v = burn(in.pos.x * 0.001 + in.pos.y * 0.0007, iters);
  return float4(fract(v), 0.0, 0.0, 1.0);
}
kernel void cs(device float* out [[buffer(0)]], constant uint& iters [[buffer(1)]], uint gid [[thread_position_in_grid]]) {
  out[gid] = burn(float(gid) * 0.0001, iters);
}
"""
let library = try! device.makeLibrary(source: source, options: nil)
let pixelCount = width * height
let outBuffer = device.makeBuffer(length: pixelCount * 4, options: .storageModePrivate)!
var renderPipeline: MTLRenderPipelineState? = nil
var computePipeline: MTLComputePipelineState? = nil
var target: MTLTexture? = nil
if kind == "render" {
  let desc = MTLRenderPipelineDescriptor()
  desc.vertexFunction = library.makeFunction(name: "vs")
  desc.fragmentFunction = library.makeFunction(name: "fs")
  desc.colorAttachments[0].pixelFormat = .bgra8Unorm
  renderPipeline = try! device.makeRenderPipelineState(descriptor: desc)
  let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
  td.usage = [.renderTarget]
  td.storageMode = .private
  target = device.makeTexture(descriptor: td)
} else {
  computePipeline = try! device.makeComputePipelineState(function: library.makeFunction(name: "cs")!)
}

func encode(_ iters: UInt32) -> MTLCommandBuffer {
  var it = iters
  let cb = queue.makeCommandBuffer()!
  if let pipeline = renderPipeline, let tex = target {
    let rp = MTLRenderPassDescriptor()
    rp.colorAttachments[0].texture = tex
    rp.colorAttachments[0].loadAction = .dontCare
    rp.colorAttachments[0].storeAction = .store
    let enc = cb.makeRenderCommandEncoder(descriptor: rp)!
    enc.setRenderPipelineState(pipeline)
    enc.setFragmentBytes(&it, length: 4, index: 0)
    enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    enc.endEncoding()
  } else if let pipeline = computePipeline {
    let enc = cb.makeComputeCommandEncoder()!
    enc.setComputePipelineState(pipeline)
    enc.setBuffer(outBuffer, offset: 0, index: 0)
    enc.setBytes(&it, length: 4, index: 1)
    enc.dispatchThreads(MTLSize(width: pixelCount, height: 1, depth: 1),
                        threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
    enc.endEncoding()
  }
  return cb
}

func gpuMs(_ iters: UInt32) -> Double {
  let cb = encode(iters)
  cb.commit()
  cb.waitUntilCompleted()
  return (cb.gpuEndTime - cb.gpuStartTime) * 1000.0
}

// Calibrate: GPU time is linear in iterations; take the median of a few.
_ = gpuMs(8)
func median(_ v: [Double]) -> Double { v.sorted()[v.count / 2] }
let probeIters: UInt32 = 64
let probe = median((0..<5).map { _ in gpuMs(probeIters) })
var iters = UInt32(max(1.0, Double(probeIters) * busyMs / max(probe, 0.001)))
for _ in 0..<3 {
  let m = median((0..<5).map { _ in gpuMs(iters) })
  iters = UInt32(max(1.0, Double(iters) * busyMs / max(m, 0.001)))
}
let calibrated = median((0..<7).map { _ in gpuMs(iters) })
FileHandle.standardError.write("metal-load kind=\(kind) \(width)x\(height) iters=\(iters) busy=\(String(format: "%.2f", calibrated)) ms at \(hz) Hz\n".data(using: .utf8)!)

final class Rec { var rows: [String] = []; let lock = NSLock() }
let rec = Rec()
let t0 = CACurrentMediaTime()
let wall0 = Date().timeIntervalSince1970
if !readyPath.isEmpty { FileManager.default.createFile(atPath: readyPath, contents: nil) }
let period = 1.0 / hz
var next = CACurrentMediaTime()
var frame = 0
let inFlight = DispatchSemaphore(value: 2)
while CACurrentMediaTime() - t0 < seconds {
  if !stopPath.isEmpty && FileManager.default.fileExists(atPath: stopPath) { break }
  let scheduled = next
  inFlight.wait()
  let submitted = CACurrentMediaTime()
  let cb = encode(iters)
  let index = frame
  cb.addCompletedHandler { b in
    let done = CACurrentMediaTime()
    // Everything on the host clock (CACurrentMediaTime = mach_absolute_time, the
    // same timebase as the GPU timestamps and CLOCK_UPTIME_RAW), in ms.
    let row = String(format: "%d,%.3f,%.3f,%.3f,%.3f,%.3f", index, scheduled * 1000, submitted * 1000,
                     b.gpuStartTime * 1000, b.gpuEndTime * 1000, done * 1000)
    rec.lock.lock(); rec.rows.append(row); rec.lock.unlock()
    inFlight.signal()
  }
  cb.commit()
  frame += 1
  next += period
  let now = CACurrentMediaTime()
  if next > now { Thread.sleep(forTimeInterval: next - now) } else { next = now }
}
queue.makeCommandBuffer().map { $0.commit(); $0.waitUntilCompleted() }
Thread.sleep(forTimeInterval: 0.2)
if !outPath.isEmpty {
  rec.lock.lock()
  let header = "# kind=\(kind) width=\(width) height=\(height) iters=\(iters) calibrated_ms=\(calibrated) hz=\(hz) wall0=\(wall0) host0_ms=\(t0 * 1000)\n"
  let body = "frame,scheduled_ms,submitted_ms,gpu_start_ms,gpu_end_ms,completed_ms\n" + rec.rows.joined(separator: "\n") + "\n"
  rec.lock.unlock()
  try! (header + body).write(toFile: outPath, atomically: true, encoding: .utf8)
}
FileHandle.standardError.write("metal-load done: \(frame) frames\n".data(using: .utf8)!)
