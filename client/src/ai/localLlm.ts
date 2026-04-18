/**
 * Browser-local LLM support via Transformers.js, exposed as a standard AI SDK
 * `LanguageModel` through `@browser-ai/transformers-js`. That adapter gives us
 * tool-calling, streaming, and download-progress on the same `streamText` path
 * the cloud providers use, so the chat hook doesn't need a special branch.
 *
 * The ONNX weights (~570 MB at q4f16) are fetched from the Hugging Face CDN on
 * first use and cached by the browser. We gate that download behind an
 * explicit user confirmation in the UI — `downloadLocalModel` is only called
 * after the user clicks the download button.
 */
import { transformersJS } from '@browser-ai/transformers-js';
import type { LanguageModel } from 'ai';

export const LOCAL_MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
export const LOCAL_MODEL_LABEL = 'Qwen3-0.6B';
export const LOCAL_MODEL_APPROX_SIZE_MB = 570;

type LocalLanguageModelWithLifecycle = LanguageModel & {
  availability: () => Promise<'unavailable' | 'downloadable' | 'available'>;
  createSessionWithProgress: (
    onProgress?: (progress: number) => void,
  ) => Promise<LocalLanguageModelWithLifecycle>;
};

let modelInstance: LocalLanguageModelWithLifecycle | null = null;
let downloadPromise: Promise<void> | null = null;
let isReady = false;

/**
 * Whether WebGPU is advertised by the current browser. We prefer it when
 * available; otherwise the adapter falls back to WASM.
 */
export function isWebGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Lazy-create (and cache) the local language model. Does NOT trigger the
 * weight download — that only starts when something actually calls
 * `doStream` / `doGenerate` on the model, or when `downloadLocalModel` runs.
 */
export function getLocalLanguageModel(): LanguageModel {
  if (!modelInstance) {
    const device = isWebGpuAvailable() ? 'webgpu' : 'wasm';
    modelInstance = transformersJS(LOCAL_MODEL_ID, {
      device,
      dtype: 'q4f16',
    }) as unknown as LocalLanguageModelWithLifecycle;
  }
  return modelInstance;
}

/** Returns true if the weights have been loaded in this session. */
export function isLocalModelReady(): boolean {
  return isReady;
}

export type DownloadLocalModelOptions = {
  onProgress?: (progressPct: number) => void;
};

/**
 * Fetch the model weights and initialize the pipeline. Idempotent — subsequent
 * calls return the cached load promise. `onProgress` receives values in 0..100.
 */
export async function downloadLocalModel(
  options: DownloadLocalModelOptions = {},
): Promise<void> {
  if (isReady) return;
  if (downloadPromise) return downloadPromise;

  const model = getLocalLanguageModel() as LocalLanguageModelWithLifecycle;
  downloadPromise = (async () => {
    try {
      const availability = await model.availability();
      if (availability === 'unavailable') {
        throw new Error(
          'This browser does not support Transformers.js (requires WebGPU or WebAssembly).',
        );
      }
      await model.createSessionWithProgress((progress) => {
        if (typeof progress === 'number' && Number.isFinite(progress)) {
          const pct = Math.max(0, Math.min(100, progress * 100));
          options.onProgress?.(pct);
        }
      });
      isReady = true;
    } catch (err) {
      downloadPromise = null;
      throw err;
    }
  })();
  return downloadPromise;
}
