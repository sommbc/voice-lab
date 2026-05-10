import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  VoxcpmEndpointMode,
  VoxcpmGenerateOptions,
  VoxcpmProviderConfig,
  VoxcpmRequestPayload
} from "./types";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_CFG_VALUE = 2.0;
const DEFAULT_INFERENCE_TIMESTEPS = 10;
const DEFAULT_ENDPOINT_MODE: VoxcpmEndpointMode = "native-wrapper";

export function resolveVoxcpmProviderConfig(): VoxcpmProviderConfig {
  const endpointUrl = process.env.VOXCPM_ENDPOINT_URL?.trim();
  const apiKey = process.env.VOXCPM_API_KEY?.trim();

  if (process.env.VOXCPM_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error("VoxCPM2 is disabled. Set VOXCPM_ENABLED=true server-side.");
  }

  if (!endpointUrl) {
    throw new Error("Missing required env var: VOXCPM_ENDPOINT_URL");
  }

  if (!apiKey) {
    throw new Error("Missing required env var: VOXCPM_API_KEY");
  }

  return {
    endpointUrl,
    apiKey,
    endpointMode: resolveVoxcpmEndpointMode(process.env.VOXCPM_ENDPOINT_MODE),
    timeoutMs: readPositiveIntegerEnv(process.env.VOXCPM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}

export function resolveVoxcpmGenerationDefaults(): {
  cfgValue: number;
  inferenceTimesteps: number;
  normalize: boolean;
  denoise: boolean;
} {
  return {
    cfgValue: readNumberEnv(process.env.VOXCPM_CFG_VALUE, DEFAULT_CFG_VALUE),
    inferenceTimesteps: readPositiveIntegerEnv(
      process.env.VOXCPM_INFERENCE_TIMESTEPS,
      DEFAULT_INFERENCE_TIMESTEPS
    ),
    normalize: readBooleanEnv(process.env.VOXCPM_NORMALIZE_TEXT, true),
    denoise: readBooleanEnv(process.env.VOXCPM_DENOISE_REFERENCE, false)
  };
}

export async function generateVoxcpmSpeech(options: VoxcpmGenerateOptions): Promise<Buffer> {
  const config =
    options.endpointUrl && options.apiKey
      ? {
          endpointUrl: options.endpointUrl,
          apiKey: options.apiKey,
          endpointMode: options.endpointMode ?? DEFAULT_ENDPOINT_MODE,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        }
      : resolveVoxcpmProviderConfig();

  const referenceAudioDataUri = await readAudioFileAsDataUri(options.referenceAudioPath);
  const promptAudioDataUri = options.promptAudioPath
    ? await readAudioFileAsDataUri(options.promptAudioPath)
    : undefined;
  const payload = buildVoxcpmRequestPayload({
    text: options.text,
    referenceAudioDataUri,
    promptAudioDataUri,
    promptText: options.promptText,
    cfgValue: options.cfgValue,
    inferenceTimesteps: options.inferenceTimesteps,
    normalize: options.normalize,
    denoise: options.denoise,
    endpointMode: config.endpointMode
  });

  const response = await fetch(config.endpointUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `VoxCPM2 service returned ${response.status} ${response.statusText}.${errorBody ? ` ${truncate(errorBody, 260)}` : ""}`
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  if (audioBuffer.length === 0) {
    throw new Error("VoxCPM2 service returned empty audio.");
  }

  return audioBuffer;
}

export function buildVoxcpmRequestPayload({
  text,
  referenceAudioDataUri,
  promptAudioDataUri,
  promptText,
  cfgValue,
  inferenceTimesteps,
  normalize,
  denoise,
  endpointMode = DEFAULT_ENDPOINT_MODE
}: {
  text: string;
  referenceAudioDataUri?: string;
  promptAudioDataUri?: string;
  promptText?: string;
  cfgValue: number;
  inferenceTimesteps: number;
  normalize: boolean;
  denoise: boolean;
  endpointMode?: VoxcpmEndpointMode;
}): VoxcpmRequestPayload | Record<string, unknown> {
  if (endpointMode === "vllm-omni") {
    const payload: Record<string, unknown> = {
      model: process.env.VOXCPM_MODEL?.trim() || "voxcpm2",
      input: text,
      voice: "default",
      response_format: "wav"
    };

    if (referenceAudioDataUri) {
      payload.ref_audio = referenceAudioDataUri;
    }

    if (promptAudioDataUri && promptText) {
      payload.prompt_audio = promptAudioDataUri;
      payload.prompt_text = promptText;
    }

    return payload;
  }

  const payload: VoxcpmRequestPayload = {
    text,
    cfg_value: cfgValue,
    inference_timesteps: inferenceTimesteps,
    normalize,
    denoise
  };

  if (referenceAudioDataUri) {
    payload.reference_audio = referenceAudioDataUri;
  }

  if (promptAudioDataUri && promptText?.trim()) {
    payload.prompt_audio = promptAudioDataUri;
    payload.prompt_text = promptText.trim();
  }

  return payload;
}

export async function readAudioFileAsDataUri(filePath: string): Promise<string> {
  const audioBuffer = await readFile(filePath);
  const mimeType = getAudioMimeType(filePath);
  return `data:${mimeType};base64,${audioBuffer.toString("base64")}`;
}

function resolveVoxcpmEndpointMode(value: string | undefined | null): VoxcpmEndpointMode {
  return value?.trim().toLowerCase() === "vllm-omni" ? "vllm-omni" : DEFAULT_ENDPOINT_MODE;
}

function getAudioMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".flac":
      return "audio/flac";
    case ".ogg":
      return "audio/ogg";
    case ".webm":
      return "audio/webm";
    case ".wav":
    default:
      return "audio/wav";
  }
}

function readPositiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNumberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function truncate(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}
