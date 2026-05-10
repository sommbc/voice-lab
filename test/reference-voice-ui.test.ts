import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canGenerateMp3,
  canSaveVoiceReference,
  getRecordingExtensionForMimeType,
  shouldShowReferenceSetup
} from "../app/page";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("saved reference hides setup by default and enables generation", () => {
  assert.equal(
    shouldShowReferenceSetup({
      hasSavedReference: true
    }),
    false
  );
  assert.equal(
    canGenerateMp3({
      hasSavedReference: true,
      sourceText: "Narrate this essay."
    }),
    true
  );
});

test("no saved reference shows first-run setup and blocks generation", () => {
  assert.equal(
    shouldShowReferenceSetup({
      hasSavedReference: false
    }),
    true
  );
  assert.equal(
    canGenerateMp3({
      hasSavedReference: false,
      sourceText: "Narrate this essay."
    }),
    false
  );
});

test("replace reference flow is intentionally expanded", () => {
  assert.equal(
    shouldShowReferenceSetup({
      hasSavedReference: true,
      isReplacingReference: true
    }),
    true
  );
  assert.equal(
    shouldShowReferenceSetup({
      hasSavedReference: false,
      isLoadingVoiceReference: true
    }),
    false
  );
});

test("save reference requires new audio and transcript", () => {
  assert.equal(canSaveVoiceReference({ hasNewAudio: false, transcript: "" }), false);
  assert.equal(canSaveVoiceReference({ hasNewAudio: true, transcript: "" }), false);
  assert.equal(canSaveVoiceReference({ hasNewAudio: false, transcript: "Exact words spoken." }), false);
  assert.equal(canSaveVoiceReference({ hasNewAudio: true, transcript: "Exact words spoken." }), true);
  assert.equal(
    canSaveVoiceReference({
      hasNewAudio: true,
      transcript: "Exact words spoken.",
      isRecordingReference: true
    }),
    false
  );
});

test("reference voice copy presents saved reference as reusable", async () => {
  const pageSource = await readFile(path.join(__dirname, "../app/page.tsx"), "utf8");

  assert.match(pageSource, /Voice configured/);
  assert.match(pageSource, /No voice configured yet/);
  assert.match(pageSource, /Voice Lab uses your saved local voice reference automatically/);
  assert.match(pageSource, /Voice settings/);
  assert.match(pageSource, /Replace saved voice reference/);
  assert.match(pageSource, /Add a reference once to enable generation/);
  assert.match(pageSource, /<details[\s\S]*className="advanced-panel voice-settings"/);
  assert.match(pageSource, /Voice settings[\s\S]*Replace saved voice reference[\s\S]*Record[\s\S]*Upload[\s\S]*Exact Transcript/);
  assert.doesNotMatch(pageSource, /record\/upload a voice file every time/i);
});

test("README puts normal use before one-time voice setup", async () => {
  const readme = await readFile(path.join(__dirname, "../README.md"), "utf8");
  const normalUseIndex = readme.indexOf("## Normal Use");
  const setupIndex = readme.indexOf("## One-Time Voice Setup");

  assert.ok(normalUseIndex > -1);
  assert.ok(setupIndex > -1);
  assert.ok(normalUseIndex < setupIndex);
  assert.match(readme, /npm run local[\s\S]*http:\/\/localhost:3000[\s\S]*paste text[\s\S]*generate MP3/);
  assert.match(readme, /reference-based cloning, not fine-tuning or training/i);
});

test("browser recording filename extension follows the actual mime type", () => {
  assert.equal(getRecordingExtensionForMimeType("audio/webm;codecs=opus"), "webm");
  assert.equal(getRecordingExtensionForMimeType("audio/mp4"), "m4a");
  assert.equal(getRecordingExtensionForMimeType("audio/m4a"), "m4a");
  assert.equal(getRecordingExtensionForMimeType("audio/ogg"), "ogg");
  assert.equal(getRecordingExtensionForMimeType("audio/wav"), "wav");
});
