/**
 * Browser-local LLM support via Transformers.js.
 *
 * We currently expose a single model (Qwen3-0.6B ONNX) that runs fully on the
 * user's device — no proxy, no API key. The ONNX artifacts (~570 MB for q4f16)
 * are fetched from the Hugging Face CDN on first use and cached by the browser,
 * so we wrap the loader with a consent step before starting the download.
 *
 * Tool-calling is not supported for local models — they're chat-only.
 */
import type { ChatMessage, ChatPart } from './chatTypes';

export const LOCAL_MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
export const LOCAL_MODEL_LABEL = 'Qwen3-0.6B';
export const LOCAL_MODEL_APPROX_SIZE_MB = 570;

export type LocalLoadProgress = {
  file?: string;
  progress: number; // 0..100
  loaded?: number;
  total?: number;
  status: 'initiate' | 'download' | 'progress' | 'done' | 'ready';
};

type Pipeline = (
  messages: unknown,
  options?: Record<string, unknown>,
) => Promise<unknown>;

type PipelineHandle = Pipeline & {
  tokenizer?: unknown;
};

type PipelineModule = {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<PipelineHandle>;
  TextStreamer: new (
    tokenizer: unknown,
    options: {
      skip_prompt?: boolean;
      skip_special_tokens?: boolean;
      callback_function?: (text: string) => void;
    },
  ) => unknown;
  InterruptableStoppingCriteria: new () => {
    interrupt: () => void;
    reset: () => void;
  };
};

let modulePromise: Promise<PipelineModule> | null = null;
let pipelinePromise: Promise<PipelineHandle> | null = null;

function loadModule(): Promise<PipelineModule> {
  if (!modulePromise) {
    modulePromise = import('@huggingface/transformers') as unknown as Promise<PipelineModule>;
  }
  return modulePromise;
}

/**
 * Whether WebGPU is advertised by the current browser. Transformers.js falls
 * back to CPU/WASM automatically when this is false, but we surface it to the
 * UI so users know what performance to expect.
 */
export function isWebGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export type LoadLocalModelOptions = {
  onProgress?: (progress: LocalLoadProgress) => void;
  signal?: AbortSignal;
};

/**
 * Load the Qwen3-0.6B pipeline. Subsequent calls return the same cached
 * instance. Progress events from the model files download are forwarded to
 * `onProgress` if provided.
 */
export async function loadLocalModel(
  options: LoadLocalModelOptions = {},
): Promise<PipelineHandle> {
  if (pipelinePromise) {
    return pipelinePromise;
  }
  const mod = await loadModule();
  const device = isWebGpuAvailable() ? 'webgpu' : 'wasm';
  pipelinePromise = mod
    .pipeline('text-generation', LOCAL_MODEL_ID, {
      device,
      dtype: 'q4f16',
      progress_callback: (progress: LocalLoadProgress) => {
        options.onProgress?.(progress);
      },
    })
    .catch((err) => {
      // Reset so a future retry can attempt the download again.
      pipelinePromise = null;
      throw err;
    });
  return pipelinePromise;
}

/** Returns true if the local pipeline has already been created in this session. */
export function isLocalModelReady(): boolean {
  return pipelinePromise !== null;
}

export type LocalGenerateOptions = {
  messages: ChatMessage[];
  systemPrompt: string;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
  maxNewTokens?: number;
};

type QwenMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function flattenParts(parts: ChatPart[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'reasoning') {
      if (part.text.length > 0) out.push(part.text);
    } else if (part.type === 'image') {
      // Qwen3-0.6B text-generation ONNX build is text-only. Attach a short
      // marker so the assistant at least acknowledges that images were sent.
      out.push('[image attachment omitted]');
    }
    // tool-call / tool-result parts are skipped: local provider doesn't do tools.
  }
  return out.join('\n').trim();
}

function toQwenMessages(messages: ChatMessage[], systemPrompt: string): QwenMessage[] {
  const out: QwenMessage[] = [];
  if (systemPrompt && systemPrompt.length > 0) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const msg of messages) {
    const text = flattenParts(msg.parts);
    const hidden = msg.role === 'user' && msg.hiddenContext ? `${msg.hiddenContext}\n\n` : '';
    const content = `${hidden}${text}`.trim();
    if (content.length === 0) continue;
    out.push({ role: msg.role, content });
  }
  return out;
}

/**
 * Stream a completion from the local Qwen3 pipeline. Calls `onDelta` with
 * each incremental token chunk decoded by the TextStreamer. The caller can
 * abort via `signal`.
 */
export async function generateLocal(options: LocalGenerateOptions): Promise<void> {
  const pipeline = await loadLocalModel();
  const mod = await loadModule();
  const stopper = new mod.InterruptableStoppingCriteria();

  const abortHandler = () => stopper.interrupt();
  if (options.signal) {
    if (options.signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    options.signal.addEventListener('abort', abortHandler, { once: true });
  }

  const streamer = new mod.TextStreamer(pipeline.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      if (options.signal?.aborted) return;
      if (text && text.length > 0) options.onDelta(text);
    },
  });

  try {
    await pipeline(toQwenMessages(options.messages, options.systemPrompt), {
      max_new_tokens: options.maxNewTokens ?? 512,
      do_sample: false,
      streamer,
      stopping_criteria: stopper,
    });
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }

  if (options.signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}
