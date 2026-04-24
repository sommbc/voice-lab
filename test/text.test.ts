import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildMergeArgs, buildTranscodeArgs, LOUDNORM_FILTER } from "../lib/audio";
import { chunkText, prepareTextForSpeech } from "../lib/text";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "long-form-essay.md");

test("segmentation keeps narration segments populated and under 300 words", async () => {
  const source = await readFile(fixturePath, "utf8");
  const prepared = prepareTextForSpeech(source);
  const segments = chunkText(prepared.paragraphs);

  assert.ok(segments.length > 1, "expected more than one narration segment");

  for (const segment of segments) {
    assert.ok(segment.text.trim().length > 0, "segment should not be empty");
    assert.ok(segment.wordCount > 0, "segment should contain words");
    assert.ok(segment.wordCount <= 300, `segment exceeded cap with ${segment.wordCount} words`);
  }
});

test("cleanup strips markdown junk and preserves paragraph boundaries", async () => {
  const source = await readFile(fixturePath, "utf8");
  const prepared = prepareTextForSpeech(source);

  assert.match(
    prepared.cleanedText,
    /The Quiet Discipline of Making a Body of Work\.\n\nMost people say they want to publish more/
  );
  assert.ok(prepared.cleanedText.includes("\n\n"), "paragraph boundaries should remain");
  assert.doesNotMatch(prepared.cleanedText, /https?:\/\//);
  assert.doesNotMatch(prepared.cleanedText, /\bRead in app\b/i);
  assert.doesNotMatch(prepared.cleanedText, /\bShare\b/);
  assert.doesNotMatch(prepared.cleanedText, /\bPhoto:/);
  assert.doesNotMatch(prepared.cleanedText, /\bCaption:/);
  assert.doesNotMatch(prepared.cleanedText, /\[\^1\]/);
});

test("speech cleanup converts common symbols and abbreviations into spoken-friendly text", () => {
  const prepared = prepareTextForSpeech(
    "# AI, API, CEO, and US\nRevenue hit $25 and 12% growth 😄 -- see https://example.com"
  );

  assert.match(prepared.cleanedText, /A\.I\., A\.P\.I\., C\.E\.O\., and U\.S\./);
  assert.match(prepared.cleanedText, /25 dollars/);
  assert.match(prepared.cleanedText, /12 percent/);
  assert.doesNotMatch(prepared.cleanedText, /https?:\/\//);
  assert.doesNotMatch(prepared.cleanedText, /😄/);
});

test("audio command helpers expose the loudnorm normalization path", () => {
  const mp3Args = buildTranscodeArgs({
    inputPath: "/tmp/in.wav",
    outputPath: "/tmp/out.mp3",
    outputFormat: "mp3",
    applyLoudnorm: true
  });
  const wavArgs = buildTranscodeArgs({
    inputPath: "/tmp/in.wav",
    outputPath: "/tmp/out.wav",
    outputFormat: "wav",
    applyLoudnorm: true
  });
  const mergeArgs = buildMergeArgs({
    listFilePath: "/tmp/concat.txt",
    outputPath: "/tmp/merged.wav",
    copyAudio: true
  });

  assert.deepEqual(mp3Args.slice(0, 5), ["-y", "-i", "/tmp/in.wav", "-vn", "-af"]);
  assert.equal(mp3Args[5], LOUDNORM_FILTER);
  assert.ok(mp3Args.includes("libmp3lame"));
  assert.ok(wavArgs.includes("pcm_s16le"));
  assert.ok(mergeArgs.includes("-c"));
  assert.ok(mergeArgs.includes("copy"));
});
