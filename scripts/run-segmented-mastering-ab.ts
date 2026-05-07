import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import {
  DEFAULT_JOIN_PAUSE_MS,
  DEFAULT_VOLUME_BOOST,
  VOLUME_BOOST_SETTINGS,
  applySegmentSeamAdjustmentAudioFile,
  analyzeAudioFileOverTime,
  buildMultiTakePairwiseSeamScoreMatrix,
  buildSegmentBoundaryDiagnostics,
  buildSegmentJoinPlan,
  buildSegmentSeamAdjustmentFilter,
  collectSegmentDiagnosticsWarnings,
  computeMultiTakeCandidatePenalty,
  computeSegmentSeamAdjustments,
  evaluateSegmentedPublishability,
  extractAudioClip,
  formatAudioTimestamp,
  generateSilenceAudioFile,
  levelSegmentAudioFile,
  masterAudioFile,
  measureSegmentAudioFile,
  mergeAudioFiles,
  resolveMultiTakeCount,
  selectAcousticTrimPoint,
  selectSeamRegenerationTargets,
  selectBestMultiTakePath,
  standardizeSegmentAudioFile,
  SEGMENT_LEVELING_SETTINGS,
  type MultiTakeCandidateInput,
  type MultiTakeCandidateManifest,
  type MultiTakeOptimizationManifest,
  type MultiTakePathSelection,
  type SegmentBoundaryDiagnostic,
  type SegmentDiagnosticsManifest,
  type SegmentDiagnosticsManifestSegment,
  type SegmentJoinPlan
} from "../lib/audio";
import { parseMistralAudioResponse, postMistralSpeech } from "../lib/mistral";
import {
  buildSegmentContinuityPrompt,
  chunkText,
  extractFirstSentences,
  extractLastSentences,
  prepareTextForSpeech,
  type SegmentContinuityPrompt
} from "../lib/text";

loadEnvConfig(process.cwd());

const essayPath = path.resolve(
  process.cwd(),
  process.argv[2] ?? "test/fixtures/long-form-essay.md"
);
const voiceId = process.env.MISTRAL_VOICE_ID?.trim() ?? "";
const contextOverlapEnabled = readBooleanEnv(process.env.VOICEOVER_CONTEXT_OVERLAP, true);
const toneSeamScoringEnabled = readBooleanEnv(
  process.env.VOICEOVER_TONE_SEAM_SCORING,
  true
);
const takeCount = resolveMultiTakeCount(process.env.VOICEOVER_MULTI_TAKE_COUNT);

type ScriptProcessedSegment = {
  rawSegmentPath: string;
  standardizedSegmentPath: string;
  leveledSegmentPath: string;
  manifestSegment: SegmentDiagnosticsManifestSegment;
};

type ScriptSegmentCandidate = {
  candidateIndex: number;
  processedSegment: ScriptProcessedSegment;
  candidatePenaltyScore: number;
  candidatePenaltyReasons: string[];
};

void main();

async function main(): Promise<void> {
  if (!process.env.MISTRAL_API_KEY) {
    console.error("Missing required env var: MISTRAL_API_KEY");
    process.exit(1);
  }

  if (!voiceId) {
    console.error("Missing required env var: MISTRAL_VOICE_ID");
    process.exit(1);
  }

  const source = await readFile(essayPath, "utf8");
  const prepared = prepareTextForSpeech(source);
  const segments = chunkText(prepared.paragraphs);

  if (segments.length === 0) {
    console.error("Prepared text produced no segments.");
    process.exit(1);
  }

  const workspacePath = await mkdtemp(path.join(tmpdir(), "voiceover-segmented-ab-"));
  let leveledPaths: string[] = [];
  let manifestSegments: SegmentDiagnosticsManifestSegment[] = [];
  let multiTakeOptimization: MultiTakeOptimizationManifest;

  try {
    console.log(`Essay: ${essayPath}`);
    console.log(`Workspace: ${workspacePath}`);
    console.log(`Cleaned word count: ${prepared.wordCount}`);
    console.log(`Segments: ${segments.length}`);
    console.log(`Segment word counts: ${segments.map((segment) => segment.wordCount).join(", ")}`);
    console.log(`Multi-take count: ${takeCount}`);
    console.log("");

    const candidateGroups: ScriptSegmentCandidate[][] = [];

    for (let index = 0; index < segments.length; index += 1) {
      candidateGroups[index] = [];

      for (let candidateIndex = 0; candidateIndex < takeCount; candidateIndex += 1) {
        candidateGroups[index].push(
          await generateAndProcessScriptSegment({
            workspacePath,
            segments,
            segmentIndex: index,
            candidateIndex,
            attempt: candidateIndex === 0 ? 1 : 200 + candidateIndex
          })
        );
      }
    }

    const joinPlan = buildSegmentJoinPlan(
      segments.map((segment) => segment.text),
      true
    );
    const optimizationResult = buildScriptMultiTakeOptimization({
      candidateGroups,
      joinPlan,
      segments
    });
    leveledPaths = optimizationResult.selectedProcessedSegments.map(
      (segment) => segment.leveledSegmentPath
    );
    manifestSegments = optimizationResult.selectedProcessedSegments.map(
      (segment) => segment.manifestSegment
    );
    let boundaries = optimizationResult.boundaries;
    multiTakeOptimization = optimizationResult.multiTakeOptimization;
    boundaries = await applyScriptSeamAdjustments({
      workspacePath,
      leveledPaths,
      manifestSegments,
      boundaries,
      joinPlan,
      segments
    });
    multiTakeOptimization = finalizeScriptMultiTakeOptimizationManifest({
      multiTakeOptimization,
      boundaries,
      manifestSegments,
      joinPlan
    });
    const joinReadyPaths = await insertJoinGaps({
      workspacePath,
      segmentPaths: leveledPaths,
      joinPlan
    });
    const mergedPath = path.join(workspacePath, "segmented-merged-premaster.wav");

    await mergeWithWavFallback({
      inputPaths: joinReadyPaths,
      outputPath: mergedPath
    });

    await exportSeamClips({
      workspacePath,
      mergedPath,
      boundaries
    });
    const mp3Path = path.join(workspacePath, "segmented-final.mp3");
    const wavPath = path.join(workspacePath, "segmented-final.wav");

    await masterAudioFile({
      inputPath: mergedPath,
      outputPath: mp3Path,
      outputFormat: "mp3",
      volumeBoost: DEFAULT_VOLUME_BOOST,
      strategy: "current-static-master"
    });
    await masterAudioFile({
      inputPath: mergedPath,
      outputPath: wavPath,
      outputFormat: "wav",
      volumeBoost: DEFAULT_VOLUME_BOOST,
      strategy: "current-static-master"
    });

    const [mp3Analysis, wavAnalysis] = await Promise.all([
      analyzeAudioFileOverTime(mp3Path),
      analyzeAudioFileOverTime(wavPath)
    ]);
    const warnings = collectSegmentDiagnosticsWarnings({
      boundaries,
      segmentMetrics: manifestSegments.map((segment) => segment.leveledMetrics),
      finalMetrics: {
        integratedLoudness: mp3Analysis.integratedLoudness,
        truePeak: mp3Analysis.truePeak,
        maxVolume: null,
        measurementMode: "loudnorm"
      },
      finalTruePeakTarget: VOLUME_BOOST_SETTINGS[DEFAULT_VOLUME_BOOST].truePeak
    });

    console.log("");
    printBoundaries(boundaries);
    const regenerationTargets = selectSeamRegenerationTargets(
      boundaries,
      manifestSegments.map((segment) => segment.leveledMetrics)
    );
    console.log(
      `Regeneration targets if enabled: ${
        regenerationTargets.length ? regenerationTargets.join(", ") : "none"
      }`
    );
    console.log("");
    printFinalAnalysis("Segmented final MP3", mp3Path, mp3Analysis);
    printFinalAnalysis("Segmented final WAV", wavPath, wavAnalysis);
    console.log(`Diagnostics warnings: ${warnings.length}`);
    for (const warning of warnings) {
      console.log(`  ${warning.code}: ${warning.message}`);
    }
    console.log("");
    printMultiTakeSummary(multiTakeOptimization);

    const manifest: SegmentDiagnosticsManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      totalSegments: segments.length,
      smoothJoins: true,
      joinPauseMs: DEFAULT_JOIN_PAUSE_MS,
      joinPlan,
      segmentLeveling: SEGMENT_LEVELING_SETTINGS,
      segments: manifestSegments,
      boundaries,
      warnings,
      finalMetrics: {
        integratedLoudness: mp3Analysis.integratedLoudness,
        truePeak: mp3Analysis.truePeak,
        maxVolume: null,
        measurementMode: "loudnorm"
      },
      multiTakeOptimization
    };

    const manifestPath = path.join(workspacePath, "segmented-audio-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`Manifest: ${manifestPath}`);
  } finally {
    const keepWorkspace = /^(1|true|yes|on)$/i.test(process.env.VOICEOVER_KEEP_AB_TMP ?? "");

    if (keepWorkspace) {
      console.log(`Keeping workspace: ${workspacePath}`);
    } else {
      await rm(workspacePath, { force: true, recursive: true });
    }
  }
}

async function generateAndProcessScriptSegment({
  workspacePath,
  segments,
  segmentIndex,
  candidateIndex,
  attempt
}: {
  workspacePath: string;
  segments: Array<{ text: string; wordCount: number }>;
  segmentIndex: number;
  candidateIndex: number;
  attempt: number;
}): Promise<ScriptSegmentCandidate> {
  const segmentNumber = segmentIndex + 1;
  const segmentId = String(segmentNumber).padStart(3, "0");
  const attemptSuffix = attempt > 1 ? `-attempt-${attempt}` : "";
  const rawPath = path.join(workspacePath, `segment-${segmentId}${attemptSuffix}-raw.wav`);
  const standardizedPath = path.join(
    workspacePath,
    `segment-${segmentId}${attemptSuffix}-standardized.wav`
  );
  const leveledPath = path.join(
    workspacePath,
    `segment-${segmentId}${attemptSuffix}-leveled.wav`
  );
  const prompt = buildSegmentContinuityPrompt({
    previousText: segments[segmentIndex - 1]?.text,
    targetText: segments[segmentIndex].text,
    nextText: segments[segmentIndex + 1]?.text,
    enabled: false,
    instructionStrength: attempt > 1 ? "strong" : "standard"
  });
  const continuityContextPrompt = buildSegmentContinuityPrompt({
    previousText: segments[segmentIndex - 1]?.text,
    targetText: segments[segmentIndex].text,
    nextText: segments[segmentIndex + 1]?.text,
    enabled: contextOverlapEnabled,
    instructionStrength: attempt > 1 ? "strong" : "standard"
  });
  const spokenOverlapInput =
    contextOverlapEnabled && continuityContextPrompt.previousContext
      ? buildSpokenContextOverlapInput({
          previousContext: continuityContextPrompt.previousContext,
          targetText: segments[segmentIndex].text
        })
      : null;

  console.log(
    `Requesting segment ${segmentNumber} of ${segments.length}, take ${
      candidateIndex + 1
    } of ${takeCount}...`
  );
  const response = await postMistralSpeech({
    input: spokenOverlapInput?.input ?? prompt.input,
    voiceId,
    responseFormat: "wav",
    timeoutMs: 120_000
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Segment ${segmentNumber} failed: ${response.status} ${response.statusText}`);
    if (errorBody) {
      console.error(errorBody);
    }
    process.exit(1);
  }

  const rawBuffer = await parseMistralAudioResponse(response);
  await writeFile(rawPath, rawBuffer);
  let rawMetrics = await measureSegmentAudioFile(rawPath);
  let finalRawPath = rawPath;
  let finalPrompt: SegmentContinuityPrompt = spokenOverlapInput
    ? {
        ...continuityContextPrompt,
        input: spokenOverlapInput.input,
        nextContext: "",
        contextOverlapUsed: true,
        inputWordCount: spokenOverlapInput.inputWordCount
      }
    : prompt;
  const contextLikelySpoken = false;
  let contextFallbackUsed = false;
  let contextAudioTrimmed = false;
  let contextAudioTrimSeconds: number | null = null;
  let contextAudioTrimEstimatedSeconds: number | null = null;
  let contextAudioTrimSearch: Awaited<ReturnType<typeof selectAcousticTrimPoint>> | null = null;

  if (spokenOverlapInput && rawMetrics.durationSeconds !== null) {
    const estimatedTrimSeconds = estimateContextAudioTrimSeconds({
      durationSeconds: rawMetrics.durationSeconds,
      contextWordCount: spokenOverlapInput.contextWordCount,
      targetWordCount: segments[segmentIndex].wordCount
    });
    contextAudioTrimEstimatedSeconds = estimatedTrimSeconds;
    contextAudioTrimSearch = await selectAcousticTrimPoint({
      inputPath: rawPath,
      durationSeconds: rawMetrics.durationSeconds,
      estimatedTrimSeconds
    });
    const trimSeconds = contextAudioTrimSearch.selectedTrimSeconds;
    finalRawPath = path.join(
      workspacePath,
      `segment-${segmentId}${attemptSuffix}-raw-context-trimmed.wav`
    );
    await extractAudioClip({
      inputPath: rawPath,
      outputPath: finalRawPath,
      startSeconds: trimSeconds,
      durationSeconds: Math.max(0.5, rawMetrics.durationSeconds - trimSeconds)
    });
    rawMetrics = await measureSegmentAudioFile(finalRawPath);
    contextAudioTrimmed = true;
    contextAudioTrimSeconds = trimSeconds;
    console.log(
      `  trimmed ${trimSeconds.toFixed(2)} s of spoken continuity context (estimate ${estimatedTrimSeconds.toFixed(
        2
      )} s)`
    );

    if (isContextTrimLikelyBadTake(rawMetrics)) {
      console.log("  context-trimmed take failed quality guard; regenerating target passage only");
      finalPrompt = buildSegmentContinuityPrompt({
        targetText: segments[segmentIndex].text,
        enabled: false
      });
      const fallbackResponse = await postMistralSpeech({
        input: finalPrompt.input,
        voiceId,
        responseFormat: "wav",
        timeoutMs: 120_000
      });

      if (!fallbackResponse.ok) {
        const errorBody = await fallbackResponse.text();
        console.error(
          `Segment ${segmentNumber} target-only fallback failed: ${fallbackResponse.status} ${fallbackResponse.statusText}`
        );
        if (errorBody) {
          console.error(errorBody);
        }
        process.exit(1);
      }

      finalRawPath = path.join(
        workspacePath,
        `segment-${segmentId}${attemptSuffix}-raw-target-only.wav`
      );
      const fallbackRawBuffer = await parseMistralAudioResponse(fallbackResponse);
      await writeFile(finalRawPath, fallbackRawBuffer);
      rawMetrics = await measureSegmentAudioFile(finalRawPath);
      contextFallbackUsed = true;
      contextAudioTrimmed = false;
      contextAudioTrimSeconds = null;
      contextAudioTrimEstimatedSeconds = null;
      contextAudioTrimSearch = null;
    }
  }

  await standardizeSegmentAudioFile({
    inputPath: finalRawPath,
    outputPath: standardizedPath
  });
  const standardizedMetrics = await measureSegmentAudioFile(standardizedPath);

  const levelingResult = await levelSegmentAudioFile({
    inputPath: standardizedPath,
    outputPath: leveledPath,
    metrics: standardizedMetrics
  });
  const leveledMetrics = await measureSegmentAudioFile(leveledPath, {
    includeEdgeTone: true
  });

  console.log(
    `  gain ${levelingResult.appliedGainDb.toFixed(
      2
    )} dB, drift ramp ${levelingResult.driftCorrectionDb.toFixed(
      2
    )} dB, leveled ${formatMetric(
      leveledMetrics.integratedLoudness,
      "LUFS"
    )}, TP ${formatMetric(leveledMetrics.truePeak, "dBFS")}`
  );

  const processedSegment: ScriptProcessedSegment = {
    rawSegmentPath: finalRawPath,
    standardizedSegmentPath: standardizedPath,
    leveledSegmentPath: leveledPath,
    manifestSegment: {
      segmentIndex: segmentNumber,
      wordCount: segments[segmentIndex].wordCount,
      generationAttempt: attempt,
      generationInputWordCount: finalPrompt.inputWordCount,
      targetWordCount: finalPrompt.targetWordCount,
      contextOverlapUsed: finalPrompt.contextOverlapUsed,
      contextInstructionStrength: finalPrompt.instructionStrength,
      previousContext: finalPrompt.previousContext,
      nextContext: finalPrompt.nextContext,
      contextLikelySpoken,
      contextFallbackUsed,
      contextAudioTrimmed,
      contextAudioTrimSeconds,
      contextAudioTrimEstimatedSeconds,
      contextAudioTrimSearch,
      regenerationReason:
        candidateIndex === 0 ? undefined : `multi-take-candidate-${candidateIndex + 1}`,
      rawMetrics,
      standardizedMetrics,
      leveledMetrics,
      appliedGainDb: levelingResult.appliedGainDb,
      driftCorrectionDb: levelingResult.driftCorrectionDb,
      levelingFilter: levelingResult.filter
    }
  };

  return toScriptSegmentCandidate(processedSegment, candidateIndex);
}

function buildScriptMultiTakeOptimization({
  candidateGroups,
  joinPlan,
  segments
}: {
  candidateGroups: ScriptSegmentCandidate[][];
  joinPlan: SegmentJoinPlan[];
  segments: Array<{ text: string; wordCount: number }>;
}): {
  selectedProcessedSegments: ScriptProcessedSegment[];
  boundaries: SegmentBoundaryDiagnostic[];
  multiTakeOptimization: MultiTakeOptimizationManifest;
} {
  const candidateInputs = candidateGroups.map((group) =>
    group.map(
      (candidate): MultiTakeCandidateInput => ({
        segmentIndex: candidate.processedSegment.manifestSegment.segmentIndex,
        candidateIndex: candidate.candidateIndex,
        metrics: candidate.processedSegment.manifestSegment.leveledMetrics,
        generationAttempt: candidate.processedSegment.manifestSegment.generationAttempt,
        contextOverlapUsed: candidate.processedSegment.manifestSegment.contextOverlapUsed,
        contextFallbackUsed: candidate.processedSegment.manifestSegment.contextFallbackUsed,
        contextAudioTrimmed: candidate.processedSegment.manifestSegment.contextAudioTrimmed,
        contextAudioTrimSeconds:
          candidate.processedSegment.manifestSegment.contextAudioTrimSeconds,
        contextAudioTrimEstimatedSeconds:
          candidate.processedSegment.manifestSegment.contextAudioTrimEstimatedSeconds,
        contextAudioTrimSearch:
          candidate.processedSegment.manifestSegment.contextAudioTrimSearch
      })
    )
  );
  const pairwiseSeamScoreMatrix = buildMultiTakePairwiseSeamScoreMatrix({
    candidates: candidateInputs,
    joinPlan,
    wordCounts: segments.map((segment) => segment.wordCount),
    toneSeamScoringEnabled
  });
  const selection = selectBestMultiTakePath({
    candidatePenaltyScores: candidateGroups.map((group) =>
      group.map((candidate) => candidate.candidatePenaltyScore)
    ),
    pairwiseSeamScoreMatrix
  });
  const selectedProcessedSegments = selection.chosenPath.map((candidateIndex, segmentIndex) => {
    const candidate = candidateGroups[segmentIndex].find(
      (entry) => entry.candidateIndex === candidateIndex
    );

    if (!candidate) {
      throw new Error(
        `Missing selected candidate ${candidateIndex} for segment ${segmentIndex + 1}.`
      );
    }

    return candidate.processedSegment;
  });
  const boundaries = buildSegmentBoundaryDiagnostics(
    selectedProcessedSegments.map((segment) => segment.manifestSegment.leveledMetrics),
    joinPlan.map((join) => join.pauseMs / 1000),
    undefined,
    undefined,
    {
      wordCounts: segments.map((segment) => segment.wordCount),
      toneSeamScoringEnabled
    }
  );
  hydrateScriptBoundaryContext(
    boundaries,
    segments,
    selectedProcessedSegments.map((segment) => segment.manifestSegment)
  );

  return {
    selectedProcessedSegments,
    boundaries,
    multiTakeOptimization: buildScriptMultiTakeOptimizationManifest({
      candidateGroups,
      pairwiseSeamScoreMatrix,
      selection,
      enabled: takeCount > 1,
      takeCount
    })
  };
}

function buildScriptMultiTakeOptimizationManifest({
  candidateGroups,
  pairwiseSeamScoreMatrix,
  selection,
  enabled,
  takeCount
}: {
  candidateGroups: ScriptSegmentCandidate[][];
  pairwiseSeamScoreMatrix: MultiTakeOptimizationManifest["pairwiseSeamScoreMatrix"];
  selection: MultiTakePathSelection;
  enabled: boolean;
  takeCount: number;
}): MultiTakeOptimizationManifest {
  const candidates: MultiTakeCandidateManifest[][] = candidateGroups.map(
    (group, segmentIndex) =>
      group.map((candidate) => {
        const manifestSegment = candidate.processedSegment.manifestSegment;

        return {
          segmentIndex: manifestSegment.segmentIndex,
          candidateIndex: candidate.candidateIndex,
          generationAttempt: manifestSegment.generationAttempt,
          selected: selection.chosenPath[segmentIndex] === candidate.candidateIndex,
          candidatePenaltyScore: candidate.candidatePenaltyScore,
          candidatePenaltyReasons: candidate.candidatePenaltyReasons,
          contextOverlapUsed: manifestSegment.contextOverlapUsed,
          contextFallbackUsed: manifestSegment.contextFallbackUsed,
          contextAudioTrimmed: manifestSegment.contextAudioTrimmed,
          contextAudioTrimSeconds: manifestSegment.contextAudioTrimSeconds,
          contextAudioTrimEstimatedSeconds:
            manifestSegment.contextAudioTrimEstimatedSeconds ?? null,
          contextAudioTrimSearch: manifestSegment.contextAudioTrimSearch ?? null,
          leveledMetrics: manifestSegment.leveledMetrics
        };
      })
  );

  return {
    enabled,
    takeCount,
    candidateCounts: candidates.map((group) => group.length),
    candidates,
    pairwiseSeamScoreMatrix,
    baselinePath: selection.baselinePath,
    chosenPath: selection.chosenPath,
    baselineTotalScore: selection.baselineTotalScore,
    chosenTotalScore: selection.chosenTotalScore,
    chosenTotalScoreAfterAdjustments: selection.chosenTotalScore,
    improvementPercentage: selection.improvementPercentage,
    worstSeamBefore: selection.baselineWorstSeam,
    worstSeamAfter: selection.chosenWorstSeam,
    worstSeamImprovementPercentage: selection.worstSeamImprovementPercentage,
    finalPublishabilityVerdict: evaluateSegmentedPublishability({
      boundaries: [],
      multiTakeEnabled: enabled,
      improvementPercentage: selection.improvementPercentage,
      worstSeamImprovementPercentage: selection.worstSeamImprovementPercentage,
      durationSeconds: null
    })
  };
}

function finalizeScriptMultiTakeOptimizationManifest({
  multiTakeOptimization,
  boundaries,
  manifestSegments,
  joinPlan
}: {
  multiTakeOptimization: MultiTakeOptimizationManifest;
  boundaries: SegmentBoundaryDiagnostic[];
  manifestSegments: SegmentDiagnosticsManifestSegment[];
  joinPlan: SegmentJoinPlan[];
}): MultiTakeOptimizationManifest {
  const chosenTotalScoreAfterAdjustments = roundToTwoDecimals(
    multiTakeOptimization.chosenPath.reduce((total, candidateIndex, segmentIndex) => {
      const candidate = multiTakeOptimization.candidates[segmentIndex]?.find(
        (entry) => entry.candidateIndex === candidateIndex
      );
      return total + (candidate?.candidatePenaltyScore ?? 0);
    }, 0) + boundaries.reduce((total, boundary) => total + boundary.seamQualityScore, 0)
  );

  return {
    ...multiTakeOptimization,
    chosenTotalScoreAfterAdjustments,
    worstSeamAfter: findWorstFinalBoundaryForPath(
      boundaries,
      multiTakeOptimization.chosenPath
    ),
    finalPublishabilityVerdict: evaluateSegmentedPublishability({
      boundaries,
      multiTakeEnabled: multiTakeOptimization.enabled,
      improvementPercentage: multiTakeOptimization.improvementPercentage,
      worstSeamImprovementPercentage:
        multiTakeOptimization.worstSeamImprovementPercentage,
      durationSeconds: sumSegmentDurationSeconds(manifestSegments, joinPlan)
    })
  };
}

function findWorstFinalBoundaryForPath(
  boundaries: SegmentBoundaryDiagnostic[],
  chosenPath: number[]
): MultiTakeOptimizationManifest["worstSeamAfter"] {
  const worstBoundary = boundaries
    .slice()
    .sort((left, right) => right.seamQualityScore - left.seamQualityScore)[0];

  if (!worstBoundary) {
    return null;
  }

  return {
    boundaryIndex: worstBoundary.boundaryIndex,
    score: worstBoundary.seamQualityScore,
    seamFailureKind: worstBoundary.seamFailureKind,
    seamFailureReason: worstBoundary.seamFailureReason,
    leftCandidateIndex: chosenPath[worstBoundary.previousSegmentIndex - 1] ?? 0,
    rightCandidateIndex: chosenPath[worstBoundary.nextSegmentIndex - 1] ?? 0
  };
}

function toScriptSegmentCandidate(
  processedSegment: ScriptProcessedSegment,
  candidateIndex: number
): ScriptSegmentCandidate {
  const penalty = computeMultiTakeCandidatePenalty({
    metrics: processedSegment.manifestSegment.leveledMetrics,
    generationAttempt: processedSegment.manifestSegment.generationAttempt,
    contextFallbackUsed: processedSegment.manifestSegment.contextFallbackUsed,
    contextAudioTrimmed: processedSegment.manifestSegment.contextAudioTrimmed,
    contextAudioTrimSeconds: processedSegment.manifestSegment.contextAudioTrimSeconds
  });

  return {
    candidateIndex,
    processedSegment,
    candidatePenaltyScore: penalty.score,
    candidatePenaltyReasons: penalty.reasons
  };
}

function sumSegmentDurationSeconds(
  manifestSegments: SegmentDiagnosticsManifestSegment[],
  joinPlan: SegmentJoinPlan[]
): number | null {
  let durationSeconds = 0;

  for (const segment of manifestSegments) {
    const segmentDuration = segment.leveledMetrics.durationSeconds;

    if (segmentDuration === null) {
      return null;
    }

    durationSeconds += segmentDuration;
  }

  for (const join of joinPlan) {
    durationSeconds += join.pauseMs / 1000;
  }

  return roundToTwoDecimals(durationSeconds);
}

function printMultiTakeSummary(multiTakeOptimization: MultiTakeOptimizationManifest): void {
  const verdict = multiTakeOptimization.finalPublishabilityVerdict;

  console.log("Multi-take optimization:");
  console.log(`  Enabled: ${multiTakeOptimization.enabled}`);
  console.log(`  Take count: ${multiTakeOptimization.takeCount}`);
  console.log(`  Baseline path: ${multiTakeOptimization.baselinePath.join(", ")}`);
  console.log(`  Chosen path: ${multiTakeOptimization.chosenPath.join(", ")}`);
  console.log(`  Baseline score: ${multiTakeOptimization.baselineTotalScore.toFixed(2)}`);
  console.log(`  Chosen score: ${multiTakeOptimization.chosenTotalScore.toFixed(2)}`);
  console.log(
    `  Chosen score after edge adjustments: ${multiTakeOptimization.chosenTotalScoreAfterAdjustments.toFixed(
      2
    )}`
  );
  console.log(`  Improvement: ${multiTakeOptimization.improvementPercentage.toFixed(2)}%`);
  console.log(
    `  Worst seam before: ${
      multiTakeOptimization.worstSeamBefore
        ? `${multiTakeOptimization.worstSeamBefore.boundaryIndex} score ${multiTakeOptimization.worstSeamBefore.score.toFixed(
            2
          )}`
        : "none"
    }`
  );
  console.log(
    `  Worst seam after: ${
      multiTakeOptimization.worstSeamAfter
        ? `${multiTakeOptimization.worstSeamAfter.boundaryIndex} score ${multiTakeOptimization.worstSeamAfter.score.toFixed(
            2
          )}`
        : "none"
    }`
  );
  console.log(`  Publishable: ${verdict.publishable}`);
  console.log(`  Verdict reason: ${verdict.reason}`);
  console.log(
    `  Kill criteria failures: ${
      verdict.killCriteriaFailures.length ? verdict.killCriteriaFailures.join(", ") : "none"
    }`
  );
}

async function insertJoinGaps({
  workspacePath,
  segmentPaths,
  joinPlan
}: {
  workspacePath: string;
  segmentPaths: string[];
  joinPlan: Array<{ pauseMs: number }>;
}): Promise<string[]> {
  if (segmentPaths.length < 2) {
    return segmentPaths;
  }

  const paths: string[] = [];

  for (const [index, segmentPath] of segmentPaths.entries()) {
    paths.push(segmentPath);

    if (index >= segmentPaths.length - 1) {
      continue;
    }

    const pauseMs = joinPlan[index]?.pauseMs ?? DEFAULT_JOIN_PAUSE_MS;
    const gapPath = path.join(
      workspacePath,
      `join-gap-${String(index + 1).padStart(3, "0")}-${pauseMs}ms.wav`
    );

    await generateSilenceAudioFile({
      outputPath: gapPath,
      durationMs: pauseMs
    });

    paths.push(gapPath);
  }

  return paths;
}

async function applyScriptSeamAdjustments({
  workspacePath,
  leveledPaths,
  manifestSegments,
  boundaries,
  joinPlan,
  segments
}: {
  workspacePath: string;
  leveledPaths: string[];
  manifestSegments: SegmentDiagnosticsManifestSegment[];
  boundaries: SegmentBoundaryDiagnostic[];
  joinPlan: Array<{ pauseMs: number }>;
  segments: Array<{ text: string; wordCount: number }>;
}): Promise<SegmentBoundaryDiagnostic[]> {
  const adjustments = computeSegmentSeamAdjustments(boundaries, leveledPaths.length);
  const actionableAdjustments = adjustments.filter(
    (adjustment) =>
      adjustment.startCutDb >= 0.05 ||
      adjustment.endCutDb >= 0.05 ||
      adjustment.entrySmoothingCutDb >= 0.05
  );

  if (actionableAdjustments.length === 0) {
    return boundaries;
  }

  console.log("Applying boundary-aware edge adjustments:");

  for (const adjustment of actionableAdjustments) {
    const segmentArrayIndex = adjustment.segmentIndex - 1;
    const sourcePath = leveledPaths[segmentArrayIndex];
    const segment = manifestSegments[segmentArrayIndex];
    const segmentId = String(adjustment.segmentIndex).padStart(3, "0");
    const outputPath = path.join(workspacePath, `segment-${segmentId}-seam-adjusted.wav`);
    const durationSeconds = segment.leveledMetrics.durationSeconds;
    const filter = buildSegmentSeamAdjustmentFilter(adjustment, durationSeconds);

    if (!filter) {
      continue;
    }

    await applySegmentSeamAdjustmentAudioFile({
      inputPath: sourcePath,
      outputPath,
      adjustment: {
        ...adjustment,
        filter
      },
      durationSeconds
    });

    const adjustedMetrics = await measureSegmentAudioFile(outputPath, {
      includeEdgeTone: true
    });
    leveledPaths[segmentArrayIndex] = outputPath;
    segment.leveledMetrics = adjustedMetrics;
    segment.seamStartCutDb = adjustment.startCutDb;
    segment.seamEndCutDb = adjustment.endCutDb;
    segment.seamEntrySmoothingCutDb = adjustment.entrySmoothingCutDb;
    segment.seamEntrySmoothingReason = adjustment.entrySmoothingReason;
    segment.seamAdjustmentFilter = filter;

    console.log(
      `  segment ${adjustment.segmentIndex}: start -${adjustment.startCutDb.toFixed(
        2
      )} dB, end -${adjustment.endCutDb.toFixed(
        2
      )} dB, entry -${adjustment.entrySmoothingCutDb.toFixed(2)} dB`
    );
  }

  const adjustedBoundaries = buildSegmentBoundaryDiagnostics(
    manifestSegments.map((segment) => segment.leveledMetrics),
    joinPlan.map((join) => join.pauseMs / 1000),
    undefined,
    undefined,
    {
      wordCounts: segments.map((segment) => segment.wordCount),
      toneSeamScoringEnabled
    }
  );
  hydrateScriptBoundaryContext(adjustedBoundaries, segments, manifestSegments);
  hydrateScriptEntrySmoothingDiagnostics(adjustedBoundaries, adjustments);
  return adjustedBoundaries;
}

function hydrateScriptEntrySmoothingDiagnostics(
  diagnostics: SegmentBoundaryDiagnostic[],
  adjustments: ReturnType<typeof computeSegmentSeamAdjustments>
): void {
  for (const adjustment of adjustments) {
    if (
      adjustment.entrySmoothingBoundaryIndex === null ||
      adjustment.entrySmoothingCutDb < 0.05
    ) {
      continue;
    }

    const boundary = diagnostics.find(
      (entry) => entry.boundaryIndex === adjustment.entrySmoothingBoundaryIndex
    );

    if (!boundary) {
      continue;
    }

    boundary.entrySmoothingApplied = true;
    boundary.entrySmoothingCutDb = adjustment.entrySmoothingCutDb;
    boundary.entrySmoothingReason = adjustment.entrySmoothingReason;
  }
}

async function mergeWithWavFallback({
  inputPaths,
  outputPath
}: {
  inputPaths: string[];
  outputPath: string;
}): Promise<void> {
  try {
    await mergeAudioFiles({
      inputPaths,
      outputPath,
      outputFormat: "wav",
      strategy: "copy"
    });
  } catch {
    await mergeAudioFiles({
      inputPaths,
      outputPath,
      outputFormat: "wav",
      strategy: "reencode"
    });
  }
}

async function exportSeamClips({
  workspacePath,
  mergedPath,
  boundaries
}: {
  workspacePath: string;
  mergedPath: string;
  boundaries: SegmentBoundaryDiagnostic[];
}): Promise<void> {
  for (const boundary of boundaries) {
    if (boundary.boundaryTimestampSeconds === null) {
      continue;
    }

    const outputPath = path.join(
      workspacePath,
      `seam-${String(boundary.boundaryIndex).padStart(3, "0")}.wav`
    );

    await extractAudioClip({
      inputPath: mergedPath,
      outputPath,
      startSeconds: boundary.boundaryTimestampSeconds - 3,
      durationSeconds: 6 + boundary.gapDurationMs / 1000
    });

    boundary.seamClipPath = outputPath;
  }
}

function printBoundaries(boundaries: ReturnType<typeof buildSegmentBoundaryDiagnostics>): void {
  console.log("Boundary diagnostics:");

  if (boundaries.length === 0) {
    console.log("  (no boundaries)");
    return;
  }

  for (const boundary of boundaries) {
    console.log(
      `  ${boundary.boundaryIndex} @ ${
        boundary.boundaryTimestampSeconds === null
          ? "unknown"
          : formatAudioTimestamp(boundary.boundaryTimestampSeconds)
      }  gap ${boundary.gapDurationMs} ms  score ${boundary.seamQualityScore.toFixed(
        2
      )}  delta ${formatMetric(boundary.deltaLufs, "LU")}  rms ${formatMetric(
        boundary.rmsDeltaDb,
        "dB"
      )}  before ${formatMetric(
        boundary.beforeLoudness,
        "LUFS"
      )} after ${formatMetric(boundary.afterLoudness, "LUFS")}  tone ${boundary.toneMismatchScore.toFixed(
        2
      )} edge ${boundary.edgeToneMismatchScore.toFixed(2)} smooth ${
        boundary.entrySmoothingApplied
          ? `-${boundary.entrySmoothingCutDb.toFixed(2)}dB`
          : "none"
      } ${boundary.seamFailureKind}  clip ${
        boundary.seamClipPath ?? "none"
      }`
    );
  }
}

function hydrateScriptBoundaryContext(
  boundaries: SegmentBoundaryDiagnostic[],
  segments: Array<{ text: string }>,
  manifestSegments: SegmentDiagnosticsManifestSegment[]
): void {
  for (const boundary of boundaries) {
    const previous = segments[boundary.previousSegmentIndex - 1];
    const next = segments[boundary.nextSegmentIndex - 1];
    const nextManifest = manifestSegments[boundary.nextSegmentIndex - 1];

    boundary.previousContextTail = previous ? extractLastSentences(previous.text, 2) : null;
    boundary.nextContextHead = next ? extractFirstSentences(next.text, 1) : null;
    boundary.contextOverlapUsed = nextManifest?.contextOverlapUsed ?? false;
  }
}

function buildSpokenContextOverlapInput({
  previousContext,
  targetText
}: {
  previousContext: string;
  targetText: string;
}): {
  input: string;
  inputWordCount: number;
  contextWordCount: number;
} {
  const input = `${previousContext.trim()}\n\n${targetText.trim()}`.trim();

  return {
    input,
    inputWordCount: countScriptWords(input),
    contextWordCount: countScriptWords(previousContext)
  };
}

function estimateContextAudioTrimSeconds({
  durationSeconds,
  contextWordCount,
  targetWordCount
}: {
  durationSeconds: number;
  contextWordCount: number;
  targetWordCount: number;
}): number {
  const totalWords = Math.max(1, contextWordCount + targetWordCount);
  const estimated = durationSeconds * (contextWordCount / totalWords);
  return roundToThreeDecimals(
    Math.min(Math.max(0, estimated + 0.08), Math.max(0, durationSeconds - 0.5))
  );
}

function isContextTrimLikelyBadTake(
  metrics: Awaited<ReturnType<typeof measureSegmentAudioFile>>
): boolean {
  if (metrics.integratedLoudness === null || metrics.truePeak === null) {
    return false;
  }

  const desiredGainDb =
    SEGMENT_LEVELING_SETTINGS.integratedLoudness - metrics.integratedLoudness;
  const peakLimitedGainDb = SEGMENT_LEVELING_SETTINGS.truePeak - metrics.truePeak;
  const gainShortfallDb = desiredGainDb - peakLimitedGainDb;

  return gainShortfallDb > 4 || (metrics.internalDriftLufs ?? 0) > 8;
}

function countScriptWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function roundToThreeDecimals(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function readBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  return /^(1|true|yes|on)$/i.test(value);
}

function printFinalAnalysis(
  label: string,
  filePath: string,
  analysis: Awaited<ReturnType<typeof analyzeAudioFileOverTime>>
): void {
  console.log(label);
  console.log(`  File: ${filePath}`);
  console.log(`  Integrated loudness: ${formatMetric(analysis.integratedLoudness, "LUFS")}`);
  console.log(`  True peak: ${formatMetric(analysis.truePeak, "dBFS")}`);
  console.log(`  LRA: ${formatMetric(analysis.loudnessRange, "LU")}`);
  console.log("  Largest jumps:");

  for (const jump of analysis.largestJumps.slice(0, 5)) {
    console.log(
      `  ${formatAudioTimestamp(jump.fromSeconds)} -> ${formatAudioTimestamp(
        jump.toSeconds
      )}  delta ${jump.deltaLufs.toFixed(2)} LUFS`
    );
  }
}

function formatMetric(value: number | null, unit: string): string {
  return value === null ? "unavailable" : `${value.toFixed(2)} ${unit}`;
}
