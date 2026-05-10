import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import {
  DEFAULT_VOLUME_BOOST,
  analyzeAudioFileOverTime,
  formatAudioTimestamp,
  masterAudioFile,
  type AudioLoudnessTimeline
} from "../lib/audio";
import { parseMistralAudioResponse, postMistralSpeech } from "../lib/mistral";
import { prepareTextForSpeech } from "../lib/text";

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

  if (!prepared.cleanedText) {
    console.error("Prepared text is empty after cleanup.");
    process.exit(1);
  }

  const workspacePath = await mkdtemp(path.join(tmpdir(), "voice-lab-ab-"));
  const rawPath = path.join(workspacePath, "raw-mistral-output.wav");
  const staticPath = path.join(workspacePath, "current-static-master.mp3");
  const speechLevelerPath = path.join(workspacePath, "speech-leveler.mp3");

  try {
    console.log(`Essay: ${essayPath}`);
    console.log(`Workspace: ${workspacePath}`);
    console.log(`Cleaned word count: ${prepared.cleanedText.split(/\s+/).filter(Boolean).length}`);
    console.log("");
    console.log("Requesting raw Mistral output...");

    const response = await postMistralSpeech({
      input: prepared.cleanedText,
      voiceId,
      responseFormat: "wav",
      timeoutMs: 180_000
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Mistral request failed: ${response.status} ${response.statusText}`);
      if (errorBody) {
        console.error(errorBody);
      }
      process.exit(1);
    }

    const rawBuffer = await parseMistralAudioResponse(response);
    await writeFile(rawPath, rawBuffer);

    console.log("Running current static mastering...");
    await masterAudioFile({
      inputPath: rawPath,
      outputPath: staticPath,
      outputFormat: "mp3",
      volumeBoost: DEFAULT_VOLUME_BOOST,
      strategy: "current-static-master",
      debugArtifactDirectoryPath: path.join(workspacePath, "debug-static")
    });

    console.log("Running speech-leveler mastering...");
    await masterAudioFile({
      inputPath: rawPath,
      outputPath: speechLevelerPath,
      outputFormat: "mp3",
      volumeBoost: DEFAULT_VOLUME_BOOST,
      strategy: "speech-leveler",
      debugArtifactDirectoryPath: path.join(workspacePath, "debug-speech-leveler")
    });

    console.log("");

    const analyses = await Promise.all([
      analyzeAudioFileOverTime(rawPath),
      analyzeAudioFileOverTime(staticPath),
      analyzeAudioFileOverTime(speechLevelerPath)
    ]);

    printAnalysis("Raw Mistral only", rawPath, analyses[0]);
    printAnalysis("Current static mastering", staticPath, analyses[1]);
    printAnalysis("Speech-leveler", speechLevelerPath, analyses[2]);
  } finally {
    const keepWorkspace = /^(1|true|yes|on)$/i.test(process.env.VOICE_LAB_KEEP_AB_TMP ?? "");

    if (keepWorkspace) {
      console.log(`Keeping workspace: ${workspacePath}`);
    } else {
      await rm(workspacePath, { force: true, recursive: true });
    }
  }
}

function printAnalysis(label: string, filePath: string, analysis: AudioLoudnessTimeline): void {
  console.log(label);
  console.log(`  File: ${filePath}`);
  console.log(`  Integrated loudness: ${formatMetric(analysis.integratedLoudness, "LUFS")}`);
  console.log(`  True peak: ${formatMetric(analysis.truePeak, "dBFS")}`);
  console.log(`  LRA: ${formatMetric(analysis.loudnessRange, "LU")}`);
  console.log("  Largest jumps:");

  if (analysis.largestJumps.length === 0) {
    console.log("  (none)");
  } else {
    for (const jump of analysis.largestJumps) {
      console.log(
        `  ${formatAudioTimestamp(jump.fromSeconds)} -> ${formatAudioTimestamp(jump.toSeconds)}  delta ${jump.deltaLufs.toFixed(
          2
        )} LUFS  (${jump.fromShortTermLufs.toFixed(2)} -> ${jump.toShortTermLufs.toFixed(2)})`
      );
    }
  }

  console.log("");
}

function formatMetric(value: number | null, unit: string): string {
  return value === null ? "unavailable" : `${value.toFixed(2)} ${unit}`;
}
