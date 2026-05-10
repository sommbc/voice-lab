import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVoxcpmRequestPayload,
  resolveVoxcpmConfig,
  resolveVoxcpmGenerationDefaults
} from "../lib/voxcpm";
import type { VoxcpmRequestPayload } from "../lib/voxcpm";
import {
  DEFAULT_VOICE_REFERENCE_ID,
  getVoiceReferenceStoragePaths,
  resolveStoragePath,
  sanitizeStorageId
} from "../lib/storage";
import {
  toClientVoiceReferenceMetadata,
  validateReferenceTranscript,
  type VoiceReferenceMetadata
} from "../lib/voice-reference-store";
import {
  createVoxcpmSegmentPromptPlan,
  VOXCPM_CHUNK_OPTIONS
} from "../lib/voxcpm-generation";

test("VoxCPM native payload carries reference and prompt audio without local paths", () => {
  const payload = buildVoxcpmRequestPayload({
    text: "Generate this narration.",
    referenceAudioDataUri: "data:audio/wav;base64,REFERENCE",
    promptAudioDataUri: "data:audio/wav;base64,PROMPT",
    promptText: "The exact prompt transcript.",
    cfgValue: 2,
    inferenceTimesteps: 10,
    normalize: true,
    denoise: false
  }) as VoxcpmRequestPayload;

  assert.equal(payload.text, "Generate this narration.");
  assert.equal(payload.reference_audio, "data:audio/wav;base64,REFERENCE");
  assert.equal(payload.prompt_audio, "data:audio/wav;base64,PROMPT");
  assert.equal(payload.prompt_text, "The exact prompt transcript.");
  assert.equal(payload.cfg_value, 2);
  assert.equal(payload.inference_timesteps, 10);
  assert.equal(payload.normalize, true);
  assert.equal(payload.denoise, false);
  assert.equal(JSON.stringify(payload).includes("/Users/"), false);
});

test("VoxCPM env parsing requires explicit enablement and bearer token", () => {
  withEnv(
    {
      VOXCPM_ENABLED: "true",
      VOXCPM_ENDPOINT_URL: "http://127.0.0.1:8809/generate",
      VOXCPM_API_KEY: "local-test-token",
      VOXCPM_ENDPOINT_MODE: "vllm-omni",
      VOXCPM_TIMEOUT_MS: "45000",
      VOXCPM_CFG_VALUE: "2.5",
      VOXCPM_INFERENCE_TIMESTEPS: "12",
      VOXCPM_NORMALIZE_TEXT: "false",
      VOXCPM_DENOISE_REFERENCE: "true"
    },
    () => {
      const config = resolveVoxcpmConfig();
      const defaults = resolveVoxcpmGenerationDefaults();

      assert.equal(config.endpointUrl, "http://127.0.0.1:8809/generate");
      assert.equal(config.apiKey, "local-test-token");
      assert.equal(config.endpointMode, "vllm-omni");
      assert.equal(config.timeoutMs, 45000);
      assert.equal(defaults.cfgValue, 2.5);
      assert.equal(defaults.inferenceTimesteps, 12);
      assert.equal(defaults.normalize, false);
      assert.equal(defaults.denoise, true);
    }
  );

  withEnv({ VOXCPM_ENABLED: "false", VOXCPM_API_KEY: "x", VOXCPM_ENDPOINT_URL: "x" }, () => {
    assert.throws(() => resolveVoxcpmConfig(), /VoxCPM2 is disabled/);
  });
});

test("reference transcript validation requires real exact transcript text", () => {
  assert.throws(() => validateReferenceTranscript(""), /Reference transcript is required/);
  assert.throws(() => validateReferenceTranscript("too short"), /too short/);
  assert.equal(
    validateReferenceTranscript("  This is the exact transcript for the reference voice clip.  "),
    "This is the exact transcript for the reference voice clip."
  );
});

test("voice reference client metadata stays sanitized", () => {
  const metadata: VoiceReferenceMetadata = {
    id: DEFAULT_VOICE_REFERENCE_ID,
    updatedAt: "2026-05-10T00:00:00.000Z",
    referenceFilename: "reference.wav",
    transcriptFilename: "transcript.txt",
    audioSha256: "a".repeat(64),
    transcriptSha256: "b".repeat(64),
    audioBytes: 1000,
    transcriptCharacters: 80
  };
  const clientMetadata = toClientVoiceReferenceMetadata(metadata);
  const serialized = JSON.stringify(clientMetadata);

  assert.equal(clientMetadata.referenceFilename, "reference.wav");
  assert.equal(clientMetadata.transcriptFilename, "transcript.txt");
  assert.equal(serialized.includes("/Users/"), false);
  assert.equal(serialized.includes("exact transcript"), false);
});

test("VoxCPM long-form prompt plan uses previous generated chunk transcript after the first chunk", () => {
  const segments = [
    { text: "First generated chunk text.", wordCount: 4 },
    { text: "Second generated chunk text.", wordCount: 4 },
    { text: "Third generated chunk text.", wordCount: 4 }
  ];
  const plan = createVoxcpmSegmentPromptPlan({
    segments,
    referenceTranscript: "This is the exact reference transcript for voice cloning tests.",
    cloneMode: "reference",
    forceFirstPrompt: true
  });

  assert.equal(VOXCPM_CHUNK_OPTIONS.hardMaxWords, 170);
  assert.equal(plan[0].promptSource, "reference");
  assert.equal(plan[0].promptText, "This is the exact reference transcript for voice cloning tests.");
  assert.equal(plan[1].promptSource, "previous-segment");
  assert.equal(plan[1].promptText, "First generated chunk text.");
  assert.equal(plan[2].promptSource, "previous-segment");
  assert.equal(plan[2].promptText, "Second generated chunk text.");
});

test("VoxCPM short reference clone can omit prompt transcript", () => {
  const plan = createVoxcpmSegmentPromptPlan({
    segments: [{ text: "Short cloned generation.", wordCount: 3 }],
    referenceTranscript: "This is the exact reference transcript for voice cloning tests.",
    cloneMode: "reference",
    forceFirstPrompt: false
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0].promptSource, "none");
  assert.equal(plan[0].promptText, null);
});

test("storage helpers keep reference paths inside the configured data directory", () => {
  const root = "/tmp/voice-lab-test-storage";
  const paths = getVoiceReferenceStoragePaths({
    dataDir: root,
    referenceId: "../Reference Voice"
  });

  assert.equal(paths.directoryPath, "/tmp/voice-lab-test-storage/references/reference-voice");
  assert.equal(paths.referenceAudioPath.endsWith("/reference.wav"), true);
  assert.equal(sanitizeStorageId(" Reference Voice! ", "fallback"), "reference-voice");
  assert.throws(() => resolveStoragePath(root, "../outside.wav"), /escapes/);
});

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();

  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    const value = values[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
