import path from "node:path";
import { analyzeAudioFileOverTime, formatAudioTimestamp } from "../lib/audio";

const inputArgument = process.argv[2];

if (!inputArgument) {
  console.error("Usage: npm run analyze-audio -- <file>");
  process.exit(1);
}

const inputPath = path.resolve(process.cwd(), inputArgument);

void main();

async function main(): Promise<void> {
  try {
    const analysis = await analyzeAudioFileOverTime(inputPath);

    console.log(`File: ${inputPath}`);
    console.log(`Integrated loudness: ${formatMetric(analysis.integratedLoudness, "LUFS")}`);
    console.log(`True peak: ${formatMetric(analysis.truePeak, "dBFS")}`);
    console.log(`LRA: ${formatMetric(analysis.loudnessRange, "LU")}`);
    console.log("");
    console.log("Approximate short-window loudness by timestamp:");

    if (analysis.shortTermByTimestamp.length === 0) {
      console.log("(no valid short-term loudness samples)");
    } else {
      for (const point of analysis.shortTermByTimestamp) {
        console.log(
          `${formatAudioTimestamp(point.seconds)}  ${point.shortTermLufs
            .toFixed(2)
            .padStart(7, " ")} LUFS`
        );
      }
    }

    console.log("");
    console.log("Top timestamp ranges where loudness jumps are largest:");

    if (analysis.largestJumps.length === 0) {
      console.log("(no jumps detected)");
    } else {
      for (const jump of analysis.largestJumps) {
        console.log(
          `${formatAudioTimestamp(jump.fromSeconds)} -> ${formatAudioTimestamp(
            jump.toSeconds
          )}  delta ${jump.deltaLufs.toFixed(2)} LUFS  (${jump.fromShortTermLufs.toFixed(
            2
          )} -> ${jump.toShortTermLufs.toFixed(2)})`
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Audio analysis failed.");
    process.exit(1);
  }
}

function formatMetric(value: number | null, unit: string): string {
  return value === null ? "unavailable" : `${value.toFixed(2)} ${unit}`;
}
