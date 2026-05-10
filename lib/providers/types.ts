export type VoxcpmCloneMode = "reference" | "ultimate";

export type VoxcpmEndpointMode = "native-wrapper" | "vllm-omni";

export type VoxcpmRequestPayload = {
  text: string;
  reference_audio?: string;
  prompt_audio?: string;
  prompt_text?: string;
  cfg_value: number;
  inference_timesteps: number;
  normalize: boolean;
  denoise: boolean;
};

export type VoxcpmGenerateOptions = {
  text: string;
  referenceAudioPath: string;
  promptAudioPath?: string;
  promptText?: string;
  cfgValue: number;
  inferenceTimesteps: number;
  normalize: boolean;
  denoise: boolean;
  endpointUrl?: string;
  apiKey?: string;
  endpointMode?: VoxcpmEndpointMode;
  timeoutMs?: number;
};

export type VoxcpmProviderConfig = {
  endpointUrl: string;
  apiKey: string;
  endpointMode: VoxcpmEndpointMode;
  timeoutMs: number;
};
