import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildLinearMasteringFilter,
  buildMergeArgs,
  buildMasteringFilter,
  buildStaticGainMasteringFilter,
  buildTranscodeArgs,
  canLinearLoudnormEngage,
  computeStaticMasteringGainDb,
  LOUDNORM_FILTER,
  SPEECH_PREMASTER_FILTER,
  TRIM_SILENCE_FILTER,
  VOLUME_BOOST_SETTINGS,
  summarizeFfmpegStderr
} from "../lib/audio";
import { chunkText, prepareTextForSpeech } from "../lib/text";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "long-form-essay.md");

test("segmentation keeps narration sections populated and materially larger than before", async () => {
  const source = await readFile(fixturePath, "utf8");
  const prepared = prepareTextForSpeech(source);
  const segments = chunkText(prepared.paragraphs);

  assert.ok(segments.length > 1, "expected more than one narration section");
  assert.ok(segments.length <= 5, `expected fewer joins, got ${segments.length} sections`);

  for (const [index, segment] of segments.entries()) {
    assert.ok(segment.text.trim().length > 0, "segment should not be empty");
    assert.ok(segment.wordCount > 0, "segment should contain words");

    if (index < segments.length - 1) {
      assert.ok(
        segment.wordCount >= 350,
        `non-final section should stay large enough, got ${segment.wordCount} words`
      );
    }

    assert.ok(segment.wordCount <= 650, `segment exceeded cap with ${segment.wordCount} words`);
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

test("audio command helpers expose the mastering path and correction gain hook", () => {
  const mp3Args = buildTranscodeArgs({
    inputPath: "/tmp/in.wav",
    outputPath: "/tmp/out.mp3",
    outputFormat: "mp3",
    applyLoudnorm: true,
    volumeBoost: "louder"
  });
  const wavArgs = buildTranscodeArgs({
    inputPath: "/tmp/in.wav",
    outputPath: "/tmp/out.wav",
    outputFormat: "wav",
    applyLoudnorm: true,
    trimSilence: true,
    sampleRate: 24000,
    channels: 1,
    volumeBoost: "normal"
  });
  const mergeArgs = buildMergeArgs({
    listFilePath: "/tmp/concat.txt",
    outputPath: "/tmp/merged.wav",
    outputFormat: "wav",
    strategy: "copy"
  });
  const mergeReencodeArgs = buildMergeArgs({
    listFilePath: "/tmp/concat.txt",
    outputPath: "/tmp/merged.mp3",
    outputFormat: "mp3",
    strategy: "reencode"
  });
  const correctedFilter = buildMasteringFilter("louder", 1.25);
  const tinyCorrectionFilter = buildMasteringFilter("louder", 0.04);

  assert.deepEqual(mp3Args.slice(0, 5), ["-y", "-i", "/tmp/in.wav", "-vn", "-af"]);
  assert.equal(LOUDNORM_FILTER, buildMasteringFilter("normal"));
  assert.equal(mp3Args[5], buildMasteringFilter("louder"));
  assert.match(correctedFilter, /volume=1\.25dB/);
  assert.doesNotMatch(tinyCorrectionFilter, /volume=/);
  assert.ok(mp3Args.includes("libmp3lame"));
  assert.ok(wavArgs[5].includes(TRIM_SILENCE_FILTER));
  assert.ok(wavArgs[5].includes(buildMasteringFilter("normal")));
  assert.ok(wavArgs.includes("pcm_s16le"));
  assert.ok(mergeArgs.includes("-c"));
  assert.ok(mergeArgs.includes("copy"));
  assert.ok(mergeReencodeArgs.includes("libmp3lame"));
  assert.ok(mergeReencodeArgs.includes("192k"));
});

test("linear mastering filter embeds the measured loudness stats and requests linear mode", () => {
  const filter = buildLinearMasteringFilter(VOLUME_BOOST_SETTINGS.louder, {
    input_i: "-23.17",
    input_tp: "-4.52",
    input_lra: "9.80",
    input_thresh: "-33.42",
    target_offset: "0.21"
  });

  assert.match(filter, /^loudnorm=I=-14:TP=-1:LRA=11:/);
  assert.match(filter, /measured_I=-23\.17/);
  assert.match(filter, /measured_TP=-4\.52/);
  assert.match(filter, /measured_LRA=9\.80/);
  assert.match(filter, /measured_thresh=-33\.42/);
  assert.match(filter, /offset=0\.21/);
  assert.match(filter, /linear=true/);
  assert.match(filter, /print_format=json/);
  assert.match(filter, /,alimiter=limit=[0-9.]+:level=disabled$/);
});

test("speech pre-master filter chains highpass, compressor, and limiter for crest reduction", () => {
  assert.equal(
    SPEECH_PREMASTER_FILTER,
    "highpass=f=70,acompressor=threshold=0.063:ratio=4:attack=2:release=120:makeup=2.51,alimiter=limit=0.708:level=disabled"
  );
});

test("linear loudnorm feasibility predicate matches loud-quiet input crest constraints", () => {
  const easy = canLinearLoudnormEngage(
    {
      input_i: "-19.50",
      input_tp: "-7.20",
      input_lra: "8.00",
      input_thresh: "-29.50",
      target_offset: "0.00"
    },
    VOLUME_BOOST_SETTINGS.normal
  );
  assert.equal(easy, true);

  const hot = canLinearLoudnormEngage(
    {
      input_i: "-28.00",
      input_tp: "-4.00",
      input_lra: "12.50",
      input_thresh: "-39.00",
      target_offset: "0.00"
    },
    VOLUME_BOOST_SETTINGS.louder
  );
  assert.equal(hot, false);
});

test("static gain mastering filter caps gain at peak headroom and ends with limiter", () => {
  const measurement = {
    input_i: "-22.00",
    input_tp: "-6.00",
    input_lra: "9.00",
    input_thresh: "-32.00",
    target_offset: "0.00"
  } as const;

  const gain = computeStaticMasteringGainDb(VOLUME_BOOST_SETTINGS.louder, measurement);
  assert.equal(gain, 5);

  const filter = buildStaticGainMasteringFilter(VOLUME_BOOST_SETTINGS.louder, measurement);
  assert.match(filter, /^volume=5\.00dB,/);
  assert.match(filter, /,alimiter=limit=[0-9.]+:level=disabled$/);

  const tooHotMeasurement = {
    input_i: "-10.00",
    input_tp: "-0.50",
    input_lra: "9.00",
    input_thresh: "-20.00",
    target_offset: "0.00"
  } as const;

  const tooHot = computeStaticMasteringGainDb(
    VOLUME_BOOST_SETTINGS.louder,
    tooHotMeasurement
  );
  assert.equal(tooHot, -4);
  const tooHotFilter = buildStaticGainMasteringFilter(
    VOLUME_BOOST_SETTINGS.louder,
    tooHotMeasurement
  );
  assert.match(tooHotFilter, /^volume=-4\.00dB,/);
});

test("ffmpeg stderr summarizer strips banners and keeps actionable lines", () => {
  const summary = summarizeFfmpegStderr(`
ffmpeg version 7.0.2-static johnvansickle.com
built with gcc 8
configuration: --enable-gpl
libavutil      59.  8.100 / 59.  8.100
[concat @ 0x123] Impossible to open '/tmp/voiceover/segment-001.wav'
/tmp/voiceover/concat.txt: Invalid data found when processing input
Conversion failed!
  `);

  assert.doesNotMatch(summary, /ffmpeg version/i);
  assert.match(summary, /Impossible to open/);
  assert.match(summary, /Invalid data found/);
});
