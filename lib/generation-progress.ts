export type OutputFormat = "mp3" | "wav";
export type ProgressStage =
  | "started"
  | "cleaning"
  | "segmenting"
  | "section-started"
  | "section-raw-received"
  | "section-standardized"
  | "section-leveled"
  | "merge-started"
  | "mastering-started"
  | "final-ready"
  | "failed"
  | "single-pass"
  | "generating"
  | "normalizing"
  | "smoothing"
  | "merging"
  | "final-normalization"
  | "done";

export type ProgressEvent = {
  type: "progress";
  stage: ProgressStage;
  message: string;
  currentSegment?: number;
  totalSegments?: number;
  completedSegments?: number;
};

export type ErrorEvent = {
  type: "error";
  message: string;
};

export type CompleteEvent = {
  type: "complete";
  filename: string;
  audioBase64: string;
  mimeType: string;
  outputFormat: OutputFormat;
  normalizationApplied: boolean;
  normalizationFallbackUsed: boolean;
  strategy: "voxcpm-short" | "voxcpm-long-form";
  totalSegments: number;
};

export type StreamEvent = ProgressEvent | ErrorEvent | CompleteEvent;

export function parseStreamEventLine(line: string): StreamEvent | null {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = JSON.parse(trimmed) as unknown;

  if (!isStreamEvent(parsed)) {
    throw new Error("Malformed generation progress event.");
  }

  return parsed;
}

export function buildProgressDetailLines(
  event: ProgressEvent,
  elapsedSeconds: number
): string[] {
  const lines: string[] = [];
  const currentSegment = getPositiveInteger(event.currentSegment);
  const totalSegments = getPositiveInteger(event.totalSegments);
  const completedSegments = getCompletedSegments(event, totalSegments);

  if (currentSegment && totalSegments) {
    lines.push(`Section ${currentSegment} of ${totalSegments}`);
  }

  if (totalSegments) {
    lines.push(`Generated ${completedSegments} / ${totalSegments} sections`);
  }

  lines.push(`Elapsed: ${formatElapsedTime(elapsedSeconds)}`);

  return lines;
}

export function formatElapsedTime(totalSeconds: number): string {
  const safeTotalSeconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const seconds = safeTotalSeconds % 60;
  const totalMinutes = Math.floor(safeTotalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}:${padTime(minutes)}:${padTime(seconds)}`;
  }

  return `${padTime(totalMinutes)}:${padTime(seconds)}`;
}

function isStreamEvent(value: unknown): value is StreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "progress") {
    return typeof value.stage === "string" && typeof value.message === "string";
  }

  if (value.type === "error") {
    return typeof value.message === "string";
  }

  if (value.type === "complete") {
    return (
      typeof value.filename === "string" &&
      typeof value.audioBase64 === "string" &&
      typeof value.mimeType === "string" &&
      typeof value.outputFormat === "string" &&
      typeof value.normalizationApplied === "boolean" &&
      typeof value.normalizationFallbackUsed === "boolean" &&
      typeof value.strategy === "string" &&
      typeof value.totalSegments === "number"
    );
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getCompletedSegments(event: ProgressEvent, totalSegments: number | null): number {
  const explicitCompleted = getNonNegativeInteger(event.completedSegments);

  if (explicitCompleted !== null) {
    return clampCompletedSegments(explicitCompleted, totalSegments);
  }

  const currentSegment = getPositiveInteger(event.currentSegment);

  switch (event.stage) {
    case "section-leveled":
      return clampCompletedSegments(currentSegment ?? 0, totalSegments);
    case "merge-started":
    case "mastering-started":
    case "final-ready":
    case "done":
      return clampCompletedSegments(totalSegments ?? 0, totalSegments);
    default:
      return clampCompletedSegments(currentSegment ? currentSegment - 1 : 0, totalSegments);
  }
}

function getPositiveInteger(value: unknown): number | null {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return null;
  }

  return value;
}

function getNonNegativeInteger(value: unknown): number | null {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    return null;
  }

  return value;
}

function clampCompletedSegments(value: number, totalSegments: number | null): number {
  if (!totalSegments) {
    return value;
  }

  return Math.min(value, totalSegments);
}

function padTime(value: number): string {
  return String(value).padStart(2, "0");
}
