// Where the ComfyUI server is and how its Qwen3-TTS nodes are set. Nothing
// about a machine is written in code: the caller names a JSON file and may
// pass a URL that goes over the file's (its environment's, usually — this
// package reads no environment).
//
// comfyui.json (every field optional):
//   {
//     "url": "http://127.0.0.1:8188",     the server, as reached from here
//     "model": "1.7B",                    model_choice of the Qwen3-TTS nodes
//     "device": "auto",                   auto | cuda | xpu | mps | cpu
//     "precision": "bf16",                bf16 | fp32
//     "attention": "auto",                auto | sage_attn | flash_attn | sdpa | eager
//     "unloadModelAfterGenerate": true,   free the VRAM after each sentence
//     "outputPrefix": "studio-speech",    folder under the server's output/
//     "inputSubfolder": "studio-speech",  folder under the server's input/ for uploaded references
//     "timeoutSeconds": 600               how long one sentence may take, queue included
//   }

import { existsSync, readFileSync } from "node:fs";
import { ComfyUiError } from "./errors.js";

export interface NodeSettings {
  model: string;
  device: string;
  precision: string;
  attention: string;
  unloadModelAfterGenerate: boolean;
}

export interface ComfyUiSpeechConfig extends Partial<NodeSettings> {
  url?: string;
  outputPrefix?: string;
  inputSubfolder?: string;
  timeoutSeconds?: number;
}

/**
 * The nodes' settings when the configuration names none. The model is
 * unloaded after each sentence because ComfyUI does not know this model and
 * will not free it before loading another: on a GPU shared with image and
 * video models that is the safe default, at a few seconds per sentence.
 */
export const DEFAULT_NODE_SETTINGS: NodeSettings = {
  model: "1.7B",
  device: "auto",
  precision: "bf16",
  attention: "auto",
  unloadModelAfterGenerate: true,
};
export const DEFAULT_OUTPUT_PREFIX = "studio-speech";
export const DEFAULT_INPUT_SUBFOLDER = "studio-speech";
export const DEFAULT_TIMEOUT_SECONDS = 600;

const STRING_FIELDS = ["url", "model", "device", "precision", "attention", "outputPrefix", "inputSubfolder"] as const;

/** The file's settings; {} when there is no file. */
export function readComfyUiConfig(file: string | undefined): ComfyUiSpeechConfig {
  if (!file || !existsSync(file)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new ComfyUiError("not-configured", `${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ComfyUiError("not-configured", `${file} is not an object`);
  const config = value as Record<string, unknown>;
  for (const field of STRING_FIELDS) {
    if (config[field] !== undefined && typeof config[field] !== "string") throw new ComfyUiError("not-configured", `${file}: ${field} is not a string`);
  }
  if (config.unloadModelAfterGenerate !== undefined && typeof config.unloadModelAfterGenerate !== "boolean") throw new ComfyUiError("not-configured", `${file}: unloadModelAfterGenerate is not true or false`);
  if (config.timeoutSeconds !== undefined && !(typeof config.timeoutSeconds === "number" && config.timeoutSeconds > 0)) throw new ComfyUiError("not-configured", `${file}: timeoutSeconds is not a positive number`);
  return config as ComfyUiSpeechConfig;
}

/** The file's settings with `url` over the file's, when given. */
export function resolveComfyUiConfig(options: { url?: string | undefined; file?: string | undefined }): ComfyUiSpeechConfig {
  const config = readComfyUiConfig(options.file);
  return options.url ? { ...config, url: options.url } : config;
}

export function nodeSettingsOf(config: ComfyUiSpeechConfig): NodeSettings {
  return {
    model: config.model ?? DEFAULT_NODE_SETTINGS.model,
    device: config.device ?? DEFAULT_NODE_SETTINGS.device,
    precision: config.precision ?? DEFAULT_NODE_SETTINGS.precision,
    attention: config.attention ?? DEFAULT_NODE_SETTINGS.attention,
    unloadModelAfterGenerate: config.unloadModelAfterGenerate ?? DEFAULT_NODE_SETTINGS.unloadModelAfterGenerate,
  };
}
