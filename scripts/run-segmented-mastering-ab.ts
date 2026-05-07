import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import {
  DEFAULT_JOIN_PAUSE_MS,
  DEFAULT_VOLUME_BOOST,
  VOLUME_BOOST_SETTINGS,
  analyzeAudioFileOverTime,
  buildSegmentBoundaryDiagnostics,
  collectSegmentDiagnosticsWarnings,
  formatAudioTimestamp,
  generateSilenceAudioFile,
  levelSegmentAudioFile,
  masterAudioFile,
  measureSegmentAudioFile,
  mergeAudioFiles,
  standardizeSegmentAudioFile,
  type SegmentDiagnosticsManifestSegment
} from "../lib/audio";
import { parseMistralAudioResponse, postMistralSpeech } from "../lib/mistral";
import { chunkText, prepareTextForSpeech } from "../lib/text";

loadEnvConfig(process.cwd());

const essayPath = path.resolve(
  process.cwd(),
  process.argv[2] ?? "test/fixtures/long-form-essay.md"
);
const voiceId = process.env.MISTRAL_VOICE_ID?.trim() ?? "";

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
  const leveledPaths: string[] = [];
  const manifestSegments: SegmentDiagnosticsManifestSegment[] = [];

  try {
    console.log(`Essay: ${essayPath}`);
    console.log(`Workspace: ${workspacePath}`);
    console.log(`Cleaned word count: ${prepared.wordCount}`);
    console.log(`Segments: ${segments.length}`);
    console.log(`Segment word counts: ${segments.map((segment) => segment.wordCount).join(", ")}`);
    console.log("");

    for (let index = 0; index < segments.length; index += 1) {
      const segmentNumber = index + 1;
      const segmentId = String(segmentNumber).padStart(3, "0");
      const rawPath = path.join(workspacePath, `segment-${segmentId}-raw.wav`);
      const standardizedPath = path.join(workspacePath, `segment-${segmentId}-standardized.wav`);
      const leveledPath = path.join(workspacePath, `segment-${segmentId}-leveled.wav`);

      console.log(`Requesting segment ${segmentNumber} of ${segments.length}...`);
      const response = await postMistralSpeech({
        input: segments[index].text,
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
      const rawMetrics = await measureSegmentAudioFile(rawPath);

      await standardizeSegmentAudioFile({
        inputPath: rawPath,
        outputPath: standardizedPath
      });
      const standardizedMetrics = await measureSegmentAudioFile(standardizedPath);

      const levelingResult = await levelSegmentAudioFile({
        inputPath: standardizedPath,
        outputPath: leveledPath,
        metrics: standardizedMetrics
      });
      const leveledMetrics = await measureSegmentAudioFile(leveledPath);

      leveledPaths.push(leveledPath);
      manifestSegments.push({
        segmentIndex: segmentNumber,
        wordCount: segments[index].wordCount,
        rawMetrics,
        standardizedMetrics,
        leveledMetrics,
        appliedGainDb: levelingResult.appliedGainDb,
        driftCorrectionDb: levelingResult.driftCorrectionDb,
        levelingFilter: levelingResult.filter
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
    }

    const joinReadyPaths = await insertJoinGaps({
      workspacePath,
      segmentPaths: leveledPaths
    });
    const mergedPath = path.join(workspacePath, "segmented-merged-premaster.wav");

    await mergeWithWavFallback({
      inputPaths: joinReadyPaths,
      outputPath: mergedPath
    });

    const boundaries = buildSegmentBoundaryDiagnostics(
      manifestSegments.map((segment) => segment.leveledMetrics),
      DEFAULT_JOIN_PAUSE_MS / 1000
    );
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
    console.log("");
    printFinalAnalysis("Segmented final MP3", mp3Path, mp3Analysis);
    printFinalAnalysis("Segmented final WAV", wavPath, wavAnalysis);
    console.log(`Diagnostics warnings: ${warnings.length}`);
    for (const warning of warnings) {
      console.log(`  ${warning.code}: ${warning.message}`);
    }
  } finally {
    const keepWorkspace = /^(1|true|yes|on)$/i.test(process.env.VOICEOVER_KEEP_AB_TMP ?? "");

    if (keepWorkspace) {
      console.log(`Keeping workspace: ${workspacePath}`);
    } else {
      await rm(workspacePath, { force: true, recursive: true });
    }
  }
}

async function insertJoinGaps({
  workspacePath,
  segmentPaths
}: {
  workspacePath: string;
  segmentPaths: string[];
}): Promise<string[]> {
  if (segmentPaths.length < 2) {
    return segmentPaths;
  }

  const gapPath = path.join(workspacePath, "join-gap.wav");

  await generateSilenceAudioFile({
    outputPath: gapPath,
    durationMs: DEFAULT_JOIN_PAUSE_MS
  });

  return segmentPaths.flatMap((segmentPath, index) =>
    index < segmentPaths.length - 1 ? [segmentPath, gapPath] : [segmentPath]
  );
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
      }  delta ${formatMetric(boundary.deltaLufs, "LU")}  before ${formatMetric(
        boundary.beforeLoudness,
        "LUFS"
      )} after ${formatMetric(boundary.afterLoudness, "LUFS")}`
    );
  }
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
