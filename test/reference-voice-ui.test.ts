import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canGenerateMp3, canSaveVoiceReference } from "../app/page";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("saved reference enables generation without a new upload", () => {
  assert.equal(
    canGenerateMp3({
      hasSavedReference: true,
      sourceText: "Narrate this essay."
    }),
    true
  );
});

test("no saved reference blocks generation", () => {
  assert.equal(
    canGenerateMp3({
      hasSavedReference: false,
      sourceText: "Narrate this essay."
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

  assert.match(pageSource, /Saved voice reference ready/);
  assert.match(pageSource, /Voice Lab will reuse this reference for every generation/);
  assert.match(pageSource, /Replace it only when you want to update your voice sample/);
  assert.match(pageSource, /Create this once/);
  assert.doesNotMatch(pageSource, /record\/upload a voice file every time/i);
});
