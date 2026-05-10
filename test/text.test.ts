import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_MASTERING_STRATEGY,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_VOLUME_BOOST,
  buildLinearMasteringFilter,
  buildMergeArgs,
  buildMasteringFilter,
  buildMultiTakePairwiseSeamScoreMatrix,
  buildSegmentBoundaryDiagnostics,
  buildSegmentJoinPlan,
  buildSegmentLevelingArgs,
  buildSegmentLevelingFilter,
  buildSegmentSeamAdjustmentFilter,
  buildSegmentStandardizationArgs,
  buildStaticGainMasteringFilter,
  buildTranscodeArgs,
  canLinearLoudnormEngage,
  collectSegmentDiagnosticsWarnings,
  computeEdgeToneDelta,
  computeEdgeToneMismatchScore,
  computeMultiTakeCandidatePenalty,
  computeSegmentDriftCorrectionDb,
  computeSegmentLevelingGainDb,
  computeSegmentSeamAdjustments,
  computeSeamQualityScore,
  computeToneMismatchScore,
  computeStaticMasteringGainDb,
  evaluateSegmentedPublishability,
  formatAudioTimestamp,
  getAdaptiveJoinPauseMs,
  LOUDNORM_FILTER,
  parseEbur128Analysis,
  resolveMultiTakeCount,
  resolveMasteringStrategy,
  SEGMENT_LEVELING_SETTINGS,
  SEGMENT_STANDARDIZATION_FILTER,
  SEGMENT_TONE_MISMATCH_WARNING,
  SPEECH_PREMASTER_FILTER,
  SPEECH_LEVELER_FILTER,
  SPEECH_LEVELER_PREMASTER_FILTER,
  TRIM_SILENCE_FILTER,
  VOLUME_BOOST_SETTINGS,
  scoreMultiTakePath,
  selectBestAcousticTrimSearchCandidate,
  selectSeamRegenerationTargets,
  selectBestMultiTakePath,
  sanitizeFfmpegArgumentsForLog,
  summarizeFfmpegStderr,
  type SegmentAudioMetrics,
  type SegmentDiagnosticsManifest,
  type MultiTakeOptimizationManifest
} from "../lib/audio";
import {
  DEFAULT_HARD_MAX_WORDS,
  DEFAULT_TARGET_MAX_WORDS,
  DEFAULT_TARGET_MIN_WORDS,
  buildSegmentContinuityPrompt,
  chunkText,
  extractFirstSentences,
  extractLastSentences,
  repairChunkBoundary,
  prepareTextForSpeech
} from "../lib/text";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "long-form-essay.md");

test("segmentation keeps long-form narration chunks below the hard cap", async () => {
  const source = await readFile(fixturePath, "utf8");
  const prepared = prepareTextForSpeech(source);
  const segments = chunkText(prepared.paragraphs);

  assert.ok(segments.length > 1, "expected more than one narration section");
  assert.ok(segments.length >= 7, `expected smaller narration sections, got ${segments.length}`);

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

test("continuity prompts separate context from the target passage", () => {
  const previous =
    "The old work had a rhythm. It asked for patience. The narrator should carry that energy forward.";
  const target =
    "The next paragraph is the part that should be spoken in the final output.";
  const next = "Then the essay turns toward the practical consequences.";
  const prompt = buildSegmentContinuityPrompt({
    previousText: previous,
    targetText: target,
    nextText: next,
    enabled: true
  });

  assert.equal(
    extractLastSentences(previous, 2),
    "It asked for patience. The narrator should carry that energy forward."
  );
  assert.equal(
    extractFirstSentences(next, 1),
    "Then the essay turns toward the practical consequences."
  );
  assert.equal(prompt.contextOverlapUsed, true);
  assert.equal(prompt.targetText, target);
  assert.equal(prompt.instructionStrength, "standard");
  assert.match(prompt.input, /Previous context for continuity only, do not read aloud:/);
  assert.match(prompt.input, /Target passage to read aloud:/);
  assert.match(prompt.input, /Next context for pacing only, do not read aloud:/);
  assert.equal(prompt.input.split(target).length - 1, 1);
  assert.ok(prompt.inputWordCount > prompt.targetWordCount);

  const disabled = buildSegmentContinuityPrompt({
    previousText: previous,
    targetText: target,
    nextText: next,
    enabled: false
  });
  assert.equal(disabled.input, target);
  assert.equal(disabled.contextOverlapUsed, false);
  assert.equal(disabled.instructionStrength, "none");
});

test("boundary repair moves sensitive transitions away from stitch points", () => {
  const previous = {
    text: `${Array.from({ length: 228 }, (_, index) => `steady${index}`).join(" ")}. The problem is:`,
    wordCount: 231
  };
  const next = {
    text: `This is where the tone should not restart. ${Array.from(
      { length: 40 },
      (_unused, index) => `follow${index}`
    ).join(" ")}.`,
    wordCount: 49
  };
  const repair = repairChunkBoundary([previous, next], 1);

  assert.equal(repair.applied, true);
  assert.equal(repair.strategy, "merge");
  assert.equal(repair.chunks.length, 1);
  assert.ok(repair.chunks[0].wordCount <= DEFAULT_HARD_MAX_WORDS);

  const neutral = repairChunkBoundary(
    [
      {
        text: "The section ends cleanly with a complete thought that does not invite a reset.",
        wordCount: 13
      },
      { text: "Another section begins cleanly too.", wordCount: 5 }
    ],
    1
  );
  assert.equal(neutral.applied, false);
  assert.equal(neutral.reason, "boundary-not-sensitive");
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

test("default narration delivery is podcast-ready normal MP3 without private voice defaults", async () => {
  assert.equal(DEFAULT_OUTPUT_FORMAT, "mp3");
  assert.equal(DEFAULT_VOLUME_BOOST, "normal");
  assert.equal(VOLUME_BOOST_SETTINGS.normal.integratedLoudness, -16);
  assert.equal(VOLUME_BOOST_SETTINGS.normal.truePeak, -1.5);

  const filter = buildMasteringFilter(DEFAULT_VOLUME_BOOST);
  assert.match(filter, /^loudnorm=I=-16:TP=-1\.5:LRA=11/);

  const mp3Args = buildTranscodeArgs({
    inputPath: "/tmp/in.wav",
    outputPath: "/tmp/out.mp3",
    outputFormat: DEFAULT_OUTPUT_FORMAT,
    applyLoudnorm: false
  });
  assert.ok(mp3Args.includes("libmp3lame"));
  assert.ok(mp3Args.includes("192k"));

  const pageSource = await readFile(path.join(__dirname, "../app/page.tsx"), "utf8");
  assert.match(pageSource, /const DEFAULT_VOLUME_BOOST = "normal"/);
  assert.match(pageSource, /Normal \/ podcast MP3/);
  assert.match(pageSource, /Generate MP3/);
  const oldServicePattern = new RegExp(["Mis", "tral", "|Vox", "tral"].join(""));
  assert.doesNotMatch(pageSource, oldServicePattern);
  assert.doesNotMatch(pageSource, /DEFAULT_VOICE_ID/);
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
  assert.equal(boundaries[0].gapDurationMs, 300);
  assert.equal(boundaries[0].rmsDeltaDb, 3.6);
  assert.equal(boundaries[0].seamPassed, false);
});

test("adaptive join planning shortens ordinary stitch gaps and preserves section pauses", () => {
  const sentencePause = getAdaptiveJoinPauseMs({
    previousText: "The standard rises.",
    nextText: "The future belongs to people who can think clearly."
  });
  const softPause = getAdaptiveJoinPauseMs({
    previousText: "The machine reaches into those rooms with me,",
    nextText: "and the specialist now has a new kind of leverage."
  });
  const sectionPause = getAdaptiveJoinPauseMs({
    previousText: "The old monopoly is over.",
    nextText: "New Tools\nThis is where the fake version explodes."
  });
  const disabledPause = getAdaptiveJoinPauseMs({
    previousText: "One.",
    nextText: "Two.",
    smoothJoins: false
  });
  const plan = buildSegmentJoinPlan(["First section.", "Second section:", "and then"], true);

  assert.equal(sentencePause, 220);
  assert.equal(softPause, 120);
  assert.equal(sectionPause, 320);
  assert.equal(disabledPause, 0);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].pauseMs, 220);
  assert.equal(plan[1].pauseMs, 120);
});

test("seam quality scoring and regeneration target selection catch bad patch points", () => {
  const score = computeSeamQualityScore({
    loudnessDeltaLufs: 4.2,
    rmsDeltaDb: 5.3,
    gapDurationMs: 360,
    spectralDifferenceScore: 19,
    speechCutoffRiskBefore: false,
    speechCutoffRiskAfter: false,
    highTruePeakNearBoundary: false
  });

  assert.ok(score >= 35, `expected bad seam score, got ${score}`);

  const boundaries = buildSegmentBoundaryDiagnostics(
    [
      makeSegmentMetrics({
        durationSeconds: 10,
        firstWindowLoudness: -18,
        lastWindowLoudness: -22,
        lastTwoSecondZeroCrossingRate: 0.31
      }),
      makeSegmentMetrics({
        durationSeconds: 10,
        firstWindowLoudness: -16.8,
        lastWindowLoudness: -17,
        firstTwoSecondZeroCrossingRate: 0.07
      })
    ],
    [0.36]
  );
  const targets = selectSeamRegenerationTargets(
    boundaries,
    boundaries.length
      ? [
          makeSegmentMetrics({ durationSeconds: 10, firstWindowLoudness: -18, lastWindowLoudness: -22 }),
          makeSegmentMetrics({ durationSeconds: 10, firstWindowLoudness: -16.8, lastWindowLoudness: -17 })
        ]
      : []
  );

  assert.equal(boundaries[0].suddenToneMismatch, true);
  assert.equal(boundaries[0].seamPassed, false);
  assert.deepEqual(targets, [2]);
});

test("tonal seam scoring can fail a mechanically clean boundary", () => {
  const toneScore = computeToneMismatchScore({
    spectralDifferenceScore: 22,
    speakingRateDeltaWps: 0.52
  });
  assert.ok(toneScore > SEGMENT_TONE_MISMATCH_WARNING);

  const boundaries = buildSegmentBoundaryDiagnostics(
    [
      makeSegmentMetrics({
        durationSeconds: 100,
        firstWindowLoudness: -18.2,
        lastWindowLoudness: -18.1,
        lastTwoSecondZeroCrossingRate: 0.36
      }),
      makeSegmentMetrics({
        durationSeconds: 74,
        firstWindowLoudness: -18,
        lastWindowLoudness: -18.1,
        firstTwoSecondZeroCrossingRate: 0.12
      })
    ],
    [0.22],
    undefined,
    undefined,
    {
      wordCounts: [230, 230],
      toneSeamScoringEnabled: true
    }
  );
  const targets = selectSeamRegenerationTargets(
    boundaries,
    [
      makeSegmentMetrics({ durationSeconds: 100, firstWindowLoudness: -18.2, lastWindowLoudness: -18.1 }),
      makeSegmentMetrics({ durationSeconds: 74, firstWindowLoudness: -18, lastWindowLoudness: -18.1 })
    ]
  );
  const warnings = collectSegmentDiagnosticsWarnings({
    boundaries,
    segmentMetrics: [
      makeSegmentMetrics({ durationSeconds: 100, firstWindowLoudness: -18.2, lastWindowLoudness: -18.1 }),
      makeSegmentMetrics({ durationSeconds: 74, firstWindowLoudness: -18, lastWindowLoudness: -18.1 })
    ],
    finalMetrics: {
      integratedLoudness: -16,
      truePeak: -1.5,
      maxVolume: null,
      measurementMode: "loudnorm"
    },
    finalTruePeakTarget: -1.5
  });

  assert.equal(boundaries[0].deltaLufs, 0.1);
  assert.equal(boundaries[0].rmsDeltaDb, 0.1);
  assert.equal(boundaries[0].seamFailureKind, "tonal");
  assert.equal(boundaries[0].seamPassed, false);
  assert.deepEqual(targets, [2]);
  assert.ok(warnings.some((warning) => warning.code === "tonal-mismatch"));
});

test("edge-tone scoring favors perceptual continuity across clean seams", () => {
  const delta = computeEdgeToneDelta(
    { lowDb: -32, midDb: -36, highDb: -50 },
    { lowDb: -31, midDb: -28, highDb: -37 }
  );
  const edgeToneScore = computeEdgeToneMismatchScore(delta);
  const toneScore = computeToneMismatchScore({
    spectralDifferenceScore: null,
    speakingRateDeltaWps: null,
    edgeToneMismatchScore: edgeToneScore
  });

  assert.equal(delta.highDeltaDb, 13);
  assert.equal(delta.brightnessExcessDb, 13);
  assert.ok(edgeToneScore > 8, `expected edge-tone mismatch, got ${edgeToneScore}`);
  assert.ok(toneScore > SEGMENT_TONE_MISMATCH_WARNING);

  const boundaries = buildSegmentBoundaryDiagnostics(
    [
      makeSegmentMetrics({
        durationSeconds: 90,
        firstWindowLoudness: -18,
        lastWindowLoudness: -18,
        lastTwoSecondEdgeTone: { lowDb: -32, midDb: -36, highDb: -50 }
      }),
      makeSegmentMetrics({
        durationSeconds: 90,
        firstWindowLoudness: -18,
        lastWindowLoudness: -18,
        firstTwoSecondEdgeTone: { lowDb: -31, midDb: -28, highDb: -37 }
      })
    ],
    [0.22],
    undefined,
    undefined,
    {
      wordCounts: [230, 230],
      toneSeamScoringEnabled: true
    }
  );

  assert.equal(boundaries[0].seamFailureKind, "tonal");
  assert.equal(boundaries[0].edgeToneDelta.highDeltaDb, 13);
  assert.ok(boundaries[0].edgeToneMismatchScore > 8);
});

test("acoustic trim search chooses a quiet valley near the estimate", () => {
  const result = selectBestAcousticTrimSearchCandidate({
    estimatedTrimSeconds: 1,
    searchRadiusSeconds: 0.4,
    candidates: [
      {
        trimSeconds: 0.6,
        offsetSeconds: -0.4,
        beforeRmsDb: -42,
        afterRmsDb: -18,
        combinedRmsDb: -30
      },
      {
        trimSeconds: 1,
        offsetSeconds: 0,
        beforeRmsDb: -37,
        afterRmsDb: -38,
        combinedRmsDb: -37.5
      },
      {
        trimSeconds: 1.4,
        offsetSeconds: 0.4,
        beforeRmsDb: -44,
        afterRmsDb: -20,
        combinedRmsDb: -32
      }
    ]
  });

  assert.equal(result.selectedTrimSeconds, 1);
  assert.equal(result.candidates.filter((candidate) => candidate.selected).length, 1);
});

test("tonal entry smoothing is right-side only and hard capped", () => {
  const boundaries = buildSegmentBoundaryDiagnostics(
    [
      makeSegmentMetrics({
        durationSeconds: 20,
        firstWindowLoudness: -18,
        lastWindowLoudness: -18,
        lastTwoSecondEdgeTone: { lowDb: -32, midDb: -37, highDb: -52 }
      }),
      makeSegmentMetrics({
        durationSeconds: 20,
        firstWindowLoudness: -17.8,
        lastWindowLoudness: -18,
        firstTwoSecondEdgeTone: { lowDb: -31, midDb: -27, highDb: -36 }
      })
    ],
    [0.22],
    undefined,
    undefined,
    {
      wordCounts: [230, 230],
      toneSeamScoringEnabled: true
    }
  );
  const adjustments = computeSegmentSeamAdjustments(boundaries, 2);

  assert.equal(adjustments[0].entrySmoothingCutDb, 0);
  assert.ok(adjustments[1].entrySmoothingCutDb > 0);
  assert.ok(adjustments[1].entrySmoothingCutDb <= 1.25);
  assert.equal(adjustments[1].entrySmoothingBoundaryIndex, 1);

  const filter = buildSegmentSeamAdjustmentFilter(adjustments[1], 20);
  assert.match(filter ?? "", /1\.50/);
  assert.match(filter ?? "", /alimiter=limit=/);
});

test("boundary-aware edge adjustments attenuate the louder side of a seam", () => {
  const boundaries = buildSegmentBoundaryDiagnostics(
    [
      makeSegmentMetrics({
        durationSeconds: 20,
        firstWindowLoudness: -18,
        lastWindowLoudness: -18
      }),
      makeSegmentMetrics({
        durationSeconds: 20,
        firstWindowLoudness: -23,
        lastWindowLoudness: -22
      })
    ],
    [0.22]
  );
  const adjustments = computeSegmentSeamAdjustments(boundaries, 2);

  assert.equal(adjustments[0].startCutDb, 0);
  assert.equal(adjustments[0].endCutDb, 3);
  assert.equal(adjustments[1].startCutDb, 0);

  const filter = buildSegmentSeamAdjustmentFilter(adjustments[0], 20);
  assert.match(filter ?? "", /volume='if\(lt\(t\\,17\.00\)\\,1\\,exp/);
  assert.match(filter ?? "", /alimiter=limit=/);
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
  assert.ok(warnings.some((warning) => warning.code === "seam-quality"));
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
    joinPauseMs: 180,
    joinPlan: [],
    segmentLeveling: SEGMENT_LEVELING_SETTINGS,
    segments: [
      {
        segmentIndex: 1,
        wordCount: 240,
        generationAttempt: 1,
        generationInputWordCount: 276,
        targetWordCount: 240,
        contextOverlapUsed: true,
        contextInstructionStrength: "standard",
        previousContext: "Previous context sentence.",
        nextContext: "Next context sentence.",
        contextLikelySpoken: false,
        contextFallbackUsed: false,
        contextAudioTrimmed: true,
        contextAudioTrimSeconds: 1.25,
        contextAudioTrimEstimatedSeconds: 1.1,
        contextAudioTrimSearch: {
          estimatedTrimSeconds: 1.1,
          selectedTrimSeconds: 1.25,
          searchRadiusSeconds: 0.4,
          candidates: [
            {
              trimSeconds: 1.25,
              offsetSeconds: 0.15,
              beforeRmsDb: -38,
              afterRmsDb: -39,
              combinedRmsDb: -38.5,
              score: -38.13,
              selected: true
            }
          ]
        },
        rawMetrics: metrics,
        standardizedMetrics: metrics,
        leveledMetrics: metrics,
        appliedGainDb: 1.25,
        driftCorrectionDb: 3.5,
        levelingFilter: buildSegmentLevelingFilter(SEGMENT_LEVELING_SETTINGS, 1.25),
        seamEntrySmoothingCutDb: 0.75,
        seamEntrySmoothingReason: "boundary-1-kind-tonal"
      }
    ],
    boundaries: [],
    warnings: [],
    finalMetrics: {
      integratedLoudness: -14,
      truePeak: -1,
      maxVolume: null,
      measurementMode: "loudnorm"
    },
    multiTakeOptimization: makeMultiTakeOptimizationManifest()
  };
  const serialized = JSON.parse(JSON.stringify(manifest)) as SegmentDiagnosticsManifest;

  assert.equal(serialized.version, 1);
  assert.equal(serialized.segments[0].wordCount, 240);
  assert.equal(serialized.segments[0].generationAttempt, 1);
  assert.equal(serialized.segments[0].contextOverlapUsed, true);
  assert.equal(serialized.segments[0].contextInstructionStrength, "standard");
  assert.equal(serialized.segments[0].contextLikelySpoken, false);
  assert.equal(serialized.segments[0].contextAudioTrimmed, true);
  assert.equal(serialized.segments[0].contextAudioTrimSeconds, 1.25);
  assert.equal(serialized.segments[0].contextAudioTrimEstimatedSeconds, 1.1);
  assert.equal(serialized.segments[0].contextAudioTrimSearch?.selectedTrimSeconds, 1.25);
  assert.equal(serialized.segments[0].seamEntrySmoothingCutDb, 0.75);
  assert.equal(serialized.segments[0].appliedGainDb, 1.25);
  assert.equal(serialized.segments[0].driftCorrectionDb, 3.5);
  assert.equal(serialized.segments[0].leveledMetrics.firstWindowLoudness, -18.2);
  assert.deepEqual(serialized.joinPlan, []);
  assert.equal(serialized.finalMetrics?.truePeak, -1);
  assert.equal(serialized.multiTakeOptimization.enabled, false);
  assert.deepEqual(serialized.multiTakeOptimization.chosenPath, [0]);
});

test("multi-take count env parsing defaults safely and clamps expensive runs", () => {
  assert.equal(resolveMultiTakeCount(undefined), 1);
  assert.equal(resolveMultiTakeCount(""), 1);
  assert.equal(resolveMultiTakeCount("0"), 1);
  assert.equal(resolveMultiTakeCount("3"), 3);
  assert.equal(resolveMultiTakeCount("9"), 5);
  assert.equal(resolveMultiTakeCount("bad"), 1);
});

test("multi-take pairwise seam matrix records every candidate pair per boundary", () => {
  const matrix = buildMultiTakePairwiseSeamScoreMatrix({
    candidates: [
      [
        { segmentIndex: 1, candidateIndex: 0, metrics: makeSegmentMetrics({ durationSeconds: 10, firstWindowLoudness: -18, lastWindowLoudness: -18 }) },
        { segmentIndex: 1, candidateIndex: 1, metrics: makeSegmentMetrics({ durationSeconds: 10, firstWindowLoudness: -18, lastWindowLoudness: -22 }) }
      ],
      [
        { segmentIndex: 2, candidateIndex: 0, metrics: makeSegmentMetrics({ durationSeconds: 11, firstWindowLoudness: -18.2, lastWindowLoudness: -18 }) },
        { segmentIndex: 2, candidateIndex: 1, metrics: makeSegmentMetrics({ durationSeconds: 11, firstWindowLoudness: -25, lastWindowLoudness: -18 }) }
      ]
    ],
    joinPlan: [{ pauseMs: 220 }],
    wordCounts: [220, 230],
    toneSeamScoringEnabled: true
  });

  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].boundaryIndex, 1);
  assert.equal(matrix[0].scores.length, 4);
  assert.ok(matrix[0].scores.every((score) => score.edgeToneDelta !== undefined));
  assert.ok(matrix[0].scores.every((score) => score.edgeToneMismatchScore >= 0));
  assert.ok(
    matrix[0].scores.some(
      (score) => score.leftCandidateIndex === 1 && score.rightCandidateIndex === 1
    )
  );
});

test("multi-take Viterbi selection chooses the globally best path", () => {
  const pairwiseSeamScoreMatrix = [
    makeSyntheticPairwiseBoundary(1, [
      [1, 5],
      [6, 6]
    ]),
    makeSyntheticPairwiseBoundary(2, [
      [100, 100],
      [1, 1]
    ])
  ];
  const selection = selectBestMultiTakePath({
    candidatePenaltyScores: [
      [0, 0],
      [0, 0],
      [0, 0]
    ],
    pairwiseSeamScoreMatrix
  });

  assert.deepEqual(selection.baselinePath, [0, 0, 0]);
  assert.deepEqual(selection.chosenPath, [0, 1, 0]);
  assert.equal(selection.baselineTotalScore, 101);
  assert.equal(selection.chosenTotalScore, 6);
  assert.equal(
    scoreMultiTakePath({
      path: selection.chosenPath,
      candidatePenaltyScores: [
        [0, 0],
        [0, 0],
        [0, 0]
      ],
      pairwiseSeamScoreMatrix
    }),
    6
  );
  assert.ok(selection.improvementPercentage > 90);
});

test("multi-take candidate penalties include drift and fallback quality signals", () => {
  const penalty = computeMultiTakeCandidatePenalty({
    generationAttempt: 201,
    contextFallbackUsed: true,
    contextAudioTrimmed: true,
    contextAudioTrimSeconds: null,
    metrics: makeSegmentMetrics({
      durationSeconds: 20,
      firstWindowLoudness: -18,
      lastWindowLoudness: -25
    })
  });

  assert.ok(penalty.score > 0);
  assert.ok(penalty.reasons.includes("internal-drift"));
  assert.ok(penalty.reasons.includes("context-fallback"));
  assert.ok(penalty.reasons.includes("invalid-context-trim"));
  assert.ok(penalty.reasons.includes("regenerated-take"));
});

test("publishability verdict exposes take reset kill criteria", () => {
  const boundaries = buildSegmentBoundaryDiagnostics(
    [
      makeSegmentMetrics({
        durationSeconds: 100,
        firstWindowLoudness: -18.2,
        lastWindowLoudness: -18.1,
        lastTwoSecondZeroCrossingRate: 0.36
      }),
      makeSegmentMetrics({
        durationSeconds: 74,
        firstWindowLoudness: -18,
        lastWindowLoudness: -18.1,
        firstTwoSecondZeroCrossingRate: 0.12
      })
    ],
    [0.22],
    undefined,
    undefined,
    {
      wordCounts: [230, 230],
      toneSeamScoringEnabled: true
    }
  );
  const verdict = evaluateSegmentedPublishability({
    boundaries,
    multiTakeEnabled: true,
    improvementPercentage: 10,
    worstSeamImprovementPercentage: 5,
    durationSeconds: 600
  });

  assert.equal(verdict.publishable, false);
  assert.equal(verdict.reason, "take_reset");
  assert.ok(verdict.killCriteriaFailures.includes("average_improvement_below_threshold"));
  assert.ok(verdict.killCriteriaFailures.includes("mechanically_clean_tonal_mismatch"));
  assert.ok(verdict.killCriteriaFailures.includes("metrics_improved_but_tonal_mismatch_remains"));
});

test("generation route keeps WAV intermediates and MP3 delivery", async () => {
  const routeSource = await readFile(path.join(__dirname, "../app/api/generate/route.ts"), "utf8");

  assert.match(routeSource, /segment-\$\{segmentId\}-raw\.wav/);
  assert.match(routeSource, /merged-premaster\.wav/);
  assert.match(routeSource, /DEFAULT_OUTPUT_FORMAT/);
  assert.match(routeSource, /resolveVoxcpmConfig/);
  const oldRoutePattern = new RegExp(["Mis", "tral", "|Vox", "tral", "|voiceId|continuousRead"].join(""));
  assert.doesNotMatch(routeSource, oldRoutePattern);
});

test("ffmpeg stderr summarizer strips banners and keeps actionable lines", () => {
  const summary = summarizeFfmpegStderr(`
ffmpeg version 7.0.2-static johnvansickle.com
built with gcc 8
configuration: --enable-gpl
libavutil      59.  8.100 / 59.  8.100
[concat @ 0x123] Impossible to open '/tmp/voice-lab/segment-001.wav'
/tmp/voice-lab/concat.txt: Invalid data found when processing input
Conversion failed!
  `);

  assert.doesNotMatch(summary, /ffmpeg version/i);
  assert.match(summary, /Impossible to open/);
  assert.match(summary, /Invalid data found/);
});

test("ffmpeg command logging redacts private paths", () => {
  const sanitized = sanitizeFfmpegArgumentsForLog([
    "-i",
    "/tmp/voice-lab/reference.mp3",
    "/Users/brandon/private/reference.wav"
  ]);
  const serialized = JSON.stringify(sanitized);

  assert.equal(serialized.includes("/tmp/voice-lab"), false);
  assert.equal(serialized.includes("/Users/brandon/private"), false);
  assert.deepEqual(sanitized, ["-i", "[path:reference.mp3]", "[path:reference.wav]"]);
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

function makeMultiTakeOptimizationManifest(): MultiTakeOptimizationManifest {
  return {
    enabled: false,
    takeCount: 1,
    candidateCounts: [1],
    candidates: [
      [
        {
          segmentIndex: 1,
          candidateIndex: 0,
          generationAttempt: 1,
          selected: true,
          candidatePenaltyScore: 0,
          candidatePenaltyReasons: [],
          contextOverlapUsed: false,
          contextFallbackUsed: false,
          contextAudioTrimmed: false,
          contextAudioTrimSeconds: null,
          contextAudioTrimEstimatedSeconds: null,
          contextAudioTrimSearch: null,
          leveledMetrics: makeSegmentMetrics({
            durationSeconds: 10,
            firstWindowLoudness: -18,
            lastWindowLoudness: -18
          })
        }
      ]
    ],
    pairwiseSeamScoreMatrix: [],
    baselinePath: [0],
    chosenPath: [0],
    baselineTotalScore: 0,
    chosenTotalScore: 0,
    chosenTotalScoreAfterAdjustments: 0,
    improvementPercentage: 0,
    worstSeamBefore: null,
    worstSeamAfter: null,
    worstSeamImprovementPercentage: 0,
    finalPublishabilityVerdict: {
      publishable: true,
      reason: "passed",
      killCriteriaFailures: [],
      thresholds: {
        seamScoreWarning: 35,
        minimumAverageImprovementPercentage: 25,
        minimumWorstSeamImprovementPercentage: 20,
        tonalMixedSeamsPerTenMinutes: 1
      }
    }
  };
}

function makeSyntheticPairwiseBoundary(
  boundaryIndex: number,
  scores: number[][]
): MultiTakeOptimizationManifest["pairwiseSeamScoreMatrix"][number] {
  return {
    boundaryIndex,
    previousSegmentIndex: boundaryIndex,
    nextSegmentIndex: boundaryIndex + 1,
    scores: scores.flatMap((row, leftCandidateIndex) =>
      row.map((score, rightCandidateIndex) => ({
        boundaryIndex,
        previousSegmentIndex: boundaryIndex,
        nextSegmentIndex: boundaryIndex + 1,
        leftCandidateIndex,
        rightCandidateIndex,
        score,
        seamQualityScore: score,
        seamFailureKind: score >= 35 ? "tonal" : "passed",
        seamFailureReason: score >= 35 ? "tonal:synthetic" : "passed",
        deltaLufs: null,
        rmsDeltaDb: null,
        gapDurationMs: 220,
        spectralDifferenceScore: null,
        previousEdgeTone: { lowDb: null, midDb: null, highDb: null },
        nextEdgeTone: { lowDb: null, midDb: null, highDb: null },
        edgeToneDelta: {
          lowDeltaDb: null,
          midDeltaDb: null,
          highDeltaDb: null,
          averageDeltaDb: null,
          weightedDeltaDb: null,
          brightnessExcessDb: null,
          presenceExcessDb: null
        },
        edgeToneMismatchScore: 0,
        toneMismatchScore: 0,
        speakingRateDeltaWps: null,
        speechCutoffRiskBefore: false,
        speechCutoffRiskAfter: false,
        highTruePeakNearBoundary: false,
        seamPassed: score < 35
      }))
    )
  };
}

function makeSegmentMetrics({
  durationSeconds,
  firstWindowLoudness,
  lastWindowLoudness,
  firstTwoSecondZeroCrossingRate = 0.12,
  lastTwoSecondZeroCrossingRate = 0.12,
  firstTwoSecondEdgeTone = { lowDb: -32, midDb: -34, highDb: -45 },
  lastTwoSecondEdgeTone = { lowDb: -32, midDb: -34, highDb: -45 }
}: {
  durationSeconds: number;
  firstWindowLoudness: number;
  lastWindowLoudness: number;
  firstTwoSecondZeroCrossingRate?: number;
  lastTwoSecondZeroCrossingRate?: number;
  firstTwoSecondEdgeTone?: SegmentAudioMetrics["firstTwoSecondEdgeTone"];
  lastTwoSecondEdgeTone?: SegmentAudioMetrics["lastTwoSecondEdgeTone"];
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
    firstFiveSecondLoudness: firstWindowLoudness,
    lastFiveSecondLoudness: lastWindowLoudness,
    firstTwoSecondRmsDb: firstWindowLoudness,
    lastTwoSecondRmsDb: lastWindowLoudness,
    firstTwoSecondPeakDb: -3,
    lastTwoSecondPeakDb: -3,
    firstTwoSecondZeroCrossingRate,
    lastTwoSecondZeroCrossingRate,
    firstTwoSecondEdgeTone,
    lastTwoSecondEdgeTone,
    leadingEdgeRmsDb: -45,
    trailingEdgeRmsDb: -45,
    leadingSpeechCutoffRisk: false,
    trailingSpeechCutoffRisk: false,
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
