import assert from "node:assert/strict";
import test from "node:test";
import { buildVoxcpmRequestPayload } from "../lib/providers/voxcpm";
import type { VoxcpmRequestPayload } from "../lib/providers/types";
import {
  toClientVoiceReferenceMetadata,
  validateReferenceTranscript,
  type VoiceReferenceMetadata
} from "../lib/voice-reference-store";
import {
  createVoxcpmSegmentPromptPlan,
  VOXCPM_CHUNK_OPTIONS
} from "../lib/voxcpm-generation";

test("VoxCPM native payload carries reference and prompt audio without provider-side paths", () => {
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

test("reference transcript validation requires real exact transcript text", () => {
  assert.throws(() => validateReferenceTranscript(""), /Reference transcript is required/);
  assert.throws(() => validateReferenceTranscript("too short"), /too short/);
  assert.equal(
    validateReferenceTranscript("  This is the exact transcript for the Brandon reference clip.  "),
    "This is the exact transcript for the Brandon reference clip."
  );
});

test("voice reference client metadata stays sanitized", () => {
  const metadata: VoiceReferenceMetadata = {
    id: "brandon",
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
    referenceTranscript: "This is Brandon's exact reference transcript for cloning.",
    cloneMode: "reference",
    forceFirstPrompt: true
  });

  assert.equal(VOXCPM_CHUNK_OPTIONS.hardMaxWords, 170);
  assert.equal(plan[0].promptSource, "reference");
  assert.equal(plan[0].promptText, "This is Brandon's exact reference transcript for cloning.");
  assert.equal(plan[1].promptSource, "previous-segment");
  assert.equal(plan[1].promptText, "First generated chunk text.");
  assert.equal(plan[2].promptSource, "previous-segment");
  assert.equal(plan[2].promptText, "Second generated chunk text.");
});

test("VoxCPM short reference clone can omit prompt transcript", () => {
  const plan = createVoxcpmSegmentPromptPlan({
    segments: [{ text: "Short cloned generation.", wordCount: 3 }],
    referenceTranscript: "This is Brandon's exact reference transcript for cloning.",
    cloneMode: "reference",
    forceFirstPrompt: false
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0].promptSource, "none");
  assert.equal(plan[0].promptText, null);
});
