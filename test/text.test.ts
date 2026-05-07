import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_MASTERING_STRATEGY,
  buildLinearMasteringFilter,
  buildMergeArgs,
  buildMasteringFilter,
  buildSegmentBoundaryDiagnostics,
  buildSegmentLevelingArgs,
  buildSegmentLevelingFilter,
  buildSegmentStandardizationArgs,
  buildStaticGainMasteringFilter,
  buildTranscodeArgs,
  canLinearLoudnormEngage,
  collectSegmentDiagnosticsWarnings,
  computeSegmentDriftCorrectionDb,
  computeSegmentLevelingGainDb,
  computeStaticMasteringGainDb,
  formatAudioTimestamp,
  LOUDNORM_FILTER,
  parseEbur128Analysis,
  resolveMasteringStrategy,
  SEGMENT_LEVELING_SETTINGS,
  SEGMENT_STANDARDIZATION_FILTER,
  SPEECH_PREMASTER_FILTER,
  SPEECH_LEVELER_FILTER,
  SPEECH_LEVELER_PREMASTER_FILTER,
  TRIM_SILENCE_FILTER,
  VOLUME_BOOST_SETTINGS,
  summarizeFfmpegStderr,
  type SegmentAudioMetrics,
  type SegmentDiagnosticsManifest
} from "../lib/audio";
import {
  DEFAULT_HARD_MAX_WORDS,
  DEFAULT_TARGET_MAX_WORDS,
  DEFAULT_TARGET_MIN_WORDS,
  chunkText,
  prepareTextForSpeech
} from "../lib/text";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "long-form-essay.md");

test("segmentation keeps Voxtral fallback chunks below the 300-word hard cap", async () => {
  const source = await readFile(fixturePath, "utf8");
  const prepared = prepareTextForSpeech(source);
  const segments = chunkText(prepared.paragraphs);

  assert.ok(segments.length > 1, "expected more than one narration section");
  assert.ok(segments.length >= 7, `expected smaller Mistral-safe sections, got ${segments.length}`);

  for (const [index, segment] of segments.entries()) {
    assert.ok(segment.text.trim().length > 0, "segment should not be empty");
    assert.ok(segment.wordCount > 0, "segment should contain words");

    if (index < segments.length - 1) {
      assert.ok(
        segment.wordCount >= DEFAULT_TARGET_MIN_WORDS,
        `non-final section should stay near target size, got ${segment.wordCount} words`
      );
      assert.ok(
        segment.wordCount <= DEFAULT_TARGET_MAX_WORDS,
        `non-final section should stay near target cap, got ${segment.wordCount} words`
      );
    }

    assert.ok(
      segment.wordCount <= DEFAULT_HARD_MAX_WORDS,
      `segment exceeded hard cap with ${segment.wordCount} words`
    );
  }
});

test("chunking splits oversized paragraphs on sentence boundaries before the hard cap", () => {
  const sentences = Array.from({ length: 22 }, (_, sentenceIndex) => {
    const words = Array.from(
      { length: 24 },
      (_unused, wordIndex) => `word${sentenceIndex}${wordIndex}`
    ).join(" ");

    return `Sentence ${sentenceIndex + 1} ${words}.`;
  });
  const segments = chunkText(sentences.join(" "));

  assert.ok(segments.length > 1, "expected long paragraph to split");

  for (const segment of segments) {
    assert.ok(
      segment.wordCount <= DEFAULT_HARD_MAX_WORDS,
      `segment exceeded hard cap with ${segment.wordCount} words`
    );
    assert.match(segment.text, /\.$/, "segment should end at a sentence boundary");
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

test("speech-leveler filters stay conservative and strategy parsing defaults safely", () => {
  assert.equal(SPEECH_LEVELER_PREMASTER_FILTER, "highpass=f=70");
  assert.match(SPEECH_LEVELER_FILTER, /^speechnorm=/);
  assert.match(SPEECH_LEVELER_FILTER, /acompressor=/);
  assert.equal(resolveMasteringStrategy("speech-leveler"), "speech-leveler");
  assert.equal(resolveMasteringStrategy("raw-debug-only"), "raw-debug-only");
  assert.equal(resolveMasteringStrategy("static"), DEFAULT_MASTERING_STRATEGY);
  assert.equal(resolveMasteringStrategy("unknown-value"), DEFAULT_MASTERING_STRATEGY);
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

test("segment leveling gain targets loudness and caps boost by true-peak headroom", () => {
  const quietWithHeadroom = computeSegmentLevelingGainDb(SEGMENT_LEVELING_SETTINGS, {
    integratedLoudness: -24,
    truePeak: -12
  });
  assert.equal(quietWithHeadroom, 6);

  const peakLimited = computeSegmentLevelingGainDb(SEGMENT_LEVELING_SETTINGS, {
    integratedLoudness: -24,
    truePeak: -5
  });
  assert.equal(peakLimited, 4);

  const veryQuiet = computeSegmentLevelingGainDb(SEGMENT_LEVELING_SETTINGS, {
    integratedLoudness: -32,
    truePeak: -20
  });
  assert.equal(veryQuiet, SEGMENT_LEVELING_SETTINGS.maxBoostDb);

  const tooLoud = computeSegmentLevelingGainDb(SEGMENT_LEVELING_SETTINGS, {
    integratedLoudness: -8,
    truePeak: -2
  });
  assert.equal(tooLoud, -SEGMENT_LEVELING_SETTINGS.maxCutDb);
});

test("segment drift correction applies a bounded deterministic ramp for fade-down", () => {
  const correction = computeSegmentDriftCorrectionDb(SEGMENT_LEVELING_SETTINGS, {
    firstWindowLoudness: -22,
    lastWindowLoudness: -29
  });
  assert.equal(correction, 7);

  const cappedCorrection = computeSegmentDriftCorrectionDb(SEGMENT_LEVELING_SETTINGS, {
    firstWindowLoudness: -20,
    lastWindowLoudness: -35
  });
  assert.equal(cappedCorrection, SEGMENT_LEVELING_SETTINGS.maxDriftCorrectionDb);

  const stable = computeSegmentDriftCorrectionDb(SEGMENT_LEVELING_SETTINGS, {
    firstWindowLoudness: -22,
    lastWindowLoudness: -23
  });
  assert.equal(stable, 0);
});

test("segment leveling filter stays deterministic and limiter-protected", () => {
  const boosted = buildSegmentLevelingFilter(SEGMENT_LEVELING_SETTINGS, 2.5);
  assert.equal(
    boosted,
    `volume=2.50dB,alimiter=limit=${SEGMENT_LEVELING_SETTINGS.limiter}:level=disabled`
  );

  const noGain = buildSegmentLevelingFilter(SEGMENT_LEVELING_SETTINGS, 0.01);
  assert.equal(noGain, `alimiter=limit=${SEGMENT_LEVELING_SETTINGS.limiter}:level=disabled`);

  const driftCorrected = buildSegmentLevelingFilter(SEGMENT_LEVELING_SETTINGS, 1.25, 4, 80);
  assert.match(driftCorrected, /^volume=1\.25dB,/);
  assert.match(driftCorrected, /volume='if\(isnan\(t\)\\,1\\,exp\(log\(10\)\*\(4\.00\*t\/80\.00\)\/20\)\)':eval=frame/);
  assert.match(driftCorrected, /,alimiter=limit=[0-9.]+:level=disabled$/);
});

test("segment standardization and leveling commands keep WAV PCM intermediates", () => {
  const standardizeArgs = buildSegmentStandardizationArgs({
    inputPath: "/tmp/raw.wav",
    outputPath: "/tmp/standardized.wav"
  });
  const levelingArgs = buildSegmentLevelingArgs({
    inputPath: "/tmp/standardized.wav",
    outputPath: "/tmp/leveled.wav",
    filter: buildSegmentLevelingFilter(SEGMENT_LEVELING_SETTINGS, 1.25)
  });

  assert.ok(standardizeArgs.includes(SEGMENT_STANDARDIZATION_FILTER));
  assert.ok(standardizeArgs.includes("-ac"));
  assert.ok(standardizeArgs.includes("1"));
  assert.ok(standardizeArgs.includes("-ar"));
  assert.ok(standardizeArgs.includes("24000"));
  assert.ok(standardizeArgs.includes("pcm_s16le"));
  assert.equal(standardizeArgs.includes("libmp3lame"), false);

  assert.ok(levelingArgs.includes("pcm_s16le"));
  assert.equal(levelingArgs.includes("libmp3lame"), false);
});

test("boundary diagnostics detect loudness jumps between leveled segments", () => {
  const boundaries = buildSegmentBoundaryDiagnostics(
    [
      makeSegmentMetrics({ durationSeconds: 10, firstWindowLoudness: -18, lastWindowLoudness: -21 }),
      makeSegmentMetrics({ durationSeconds: 12, firstWindowLoudness: -17.4, lastWindowLoudness: -18 })
    ],
    0.3
  );

  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].boundaryTimestampSeconds, 10);
  assert.equal(boundaries[0].nextSpeechTimestampSeconds, 10.3);
  assert.equal(boundaries[0].deltaLufs, 3.6);
  assert.equal(boundaries[0].exceedsThreshold, true);
  assert.equal(boundaries[0].nearBoundaryJumpExceedsThreshold, true);
});

test("diagnostic warnings expose boundary, drift, and final-peak failures", () => {
  const segmentMetrics = [
    makeSegmentMetrics({ durationSeconds: 10, firstWindowLoudness: -17, lastWindowLoudness: -22 }),
    makeSegmentMetrics({ durationSeconds: 11, firstWindowLoudness: -18, lastWindowLoudness: -18.5 })
  ];
  const boundaries = buildSegmentBoundaryDiagnostics(segmentMetrics, 0.3);
  const warnings = collectSegmentDiagnosticsWarnings({
    boundaries,
    segmentMetrics,
    finalMetrics: {
      integratedLoudness: -14,
      truePeak: -0.7,
      maxVolume: null,
      measurementMode: "loudnorm"
    },
    finalTruePeakTarget: -1
  });

  assert.ok(warnings.some((warning) => warning.code === "boundary-delta"));
  assert.ok(warnings.some((warning) => warning.code === "near-boundary-jump"));
  assert.ok(warnings.some((warning) => warning.code === "segment-internal-drift"));
  assert.ok(warnings.some((warning) => warning.code === "final-true-peak"));
});

test("segmented diagnostics manifest keeps metrics and gain shape serializable", () => {
  const metrics = makeSegmentMetrics({
    durationSeconds: 10,
    firstWindowLoudness: -18.2,
    lastWindowLoudness: -18.4
  });
  const manifest: SegmentDiagnosticsManifest = {
    version: 1,
    createdAt: "2026-05-07T00:00:00.000Z",
    totalSegments: 1,
    smoothJoins: true,
    joinPauseMs: 300,
    segmentLeveling: SEGMENT_LEVELING_SETTINGS,
    segments: [
      {
        segmentIndex: 1,
        wordCount: 240,
        rawMetrics: metrics,
        standardizedMetrics: metrics,
        leveledMetrics: metrics,
        appliedGainDb: 1.25,
        driftCorrectionDb: 3.5,
        levelingFilter: buildSegmentLevelingFilter(SEGMENT_LEVELING_SETTINGS, 1.25)
      }
    ],
    boundaries: [],
    warnings: [],
    finalMetrics: {
      integratedLoudness: -14,
      truePeak: -1,
      maxVolume: null,
      measurementMode: "loudnorm"
    }
  };
  const serialized = JSON.parse(JSON.stringify(manifest)) as SegmentDiagnosticsManifest;

  assert.equal(serialized.version, 1);
  assert.equal(serialized.segments[0].wordCount, 240);
  assert.equal(serialized.segments[0].appliedGainDb, 1.25);
  assert.equal(serialized.segments[0].driftCorrectionDb, 3.5);
  assert.equal(serialized.segments[0].leveledMetrics.firstWindowLoudness, -18.2);
  assert.equal(serialized.finalMetrics?.truePeak, -1);
});

test("segmented route no longer falls back to MP3 intermediates while merging", async () => {
  const routeSource = await readFile(path.join(__dirname, "../app/api/generate/route.ts"), "utf8");

  assert.match(routeSource, /merged-reencoded\.wav/);
  assert.doesNotMatch(routeSource, /fallbackFormat\s*=\s*outputFormat\s*===\s*"mp3"/);
  assert.doesNotMatch(routeSource, /merged-reencoded\.\$\{getFileExtension\(fallbackFormat\)\}/);
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

test("ebur128 parser exposes summary metrics, a timestamped short-term view, and largest jumps", () => {
  const analysis = parseEbur128Analysis(`
Duration: 00:04:32.25, start: 0.000000, bitrate: 384 kb/s
[Parsed_ebur128_0 @ 0x1] t: 269.999 TARGET:-23 LUFS    M: -18.2 S: -17.9     I: -17.6 LUFS       LRA:   4.1 LU  FTPK:  -1.2 dBFS  TPK:  -1.2 dBFS
[Parsed_ebur128_0 @ 0x1] t: 270.999 TARGET:-23 LUFS    M: -15.0 S: -14.1     I: -17.5 LUFS       LRA:   4.4 LU  FTPK:  -1.0 dBFS  TPK:  -1.0 dBFS
[Parsed_ebur128_0 @ 0x1] t: 271.999 TARGET:-23 LUFS    M: -15.4 S: -14.6     I: -17.4 LUFS       LRA:   4.6 LU  FTPK:  -1.0 dBFS  TPK:  -1.0 dBFS
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -17.4 LUFS
    Threshold: -27.4 LUFS

  Loudness range:
    LRA:         4.6 LU
    Threshold: -37.4 LUFS
    LRA low:    -19.2 LUFS
    LRA high:   -14.6 LUFS

  True peak:
    Peak:       -1.0 dBFS
  `);

  assert.equal(analysis.durationSeconds, 272.25);
  assert.equal(analysis.integratedLoudness, -17.4);
  assert.equal(analysis.truePeak, -1.0);
  assert.equal(analysis.loudnessRange, 4.6);
  assert.deepEqual(analysis.shortTermByTimestamp, [
    { seconds: 269, shortTermLufs: -17.9 },
    { seconds: 270, shortTermLufs: -14.1 },
    { seconds: 271, shortTermLufs: -14.6 }
  ]);
  assert.equal(analysis.largestJumps[0]?.deltaLufs, 3.8);
  assert.equal(formatAudioTimestamp(270), "04:30");
});

function makeSegmentMetrics({
  durationSeconds,
  firstWindowLoudness,
  lastWindowLoudness
}: {
  durationSeconds: number;
  firstWindowLoudness: number;
  lastWindowLoudness: number;
}): SegmentAudioMetrics {
  const internalDriftLufs = Number(
    Math.abs(lastWindowLoudness - firstWindowLoudness).toFixed(2)
  );

  return {
    durationSeconds,
    integratedLoudness: -18,
    truePeak: -3,
    maxVolume: -3.2,
    loudnessRange: 2,
    shortTermByTimestamp: [
      { seconds: 0, shortTermLufs: firstWindowLoudness },
      { seconds: Math.max(0, durationSeconds - 1), shortTermLufs: lastWindowLoudness }
    ],
    firstWindowLoudness,
    lastWindowLoudness,
    largestInternalJump: {
      fromSeconds: 0,
      toSeconds: Math.max(0, durationSeconds - 1),
      fromShortTermLufs: firstWindowLoudness,
      toShortTermLufs: lastWindowLoudness,
      deltaLufs: internalDriftLufs
    },
    internalDriftLufs
  };
}
