import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProgressDetailLines,
  formatElapsedTime,
  parseStreamEventLine
} from "../lib/generation-progress";

test("progress details show current section, completed sections, and elapsed time", () => {
  assert.deepEqual(
    buildProgressDetailLines(
      {
        type: "progress",
        stage: "section-raw-received",
        message: "Section 3 of 13 raw WAV received",
        currentSegment: 3,
        totalSegments: 13,
        completedSegments: 2
      },
      724
    ),
    ["Section 3 of 13", "Generated 2 / 13 sections", "Elapsed: 12:04"]
  );
});

test("progress details infer completed sections for final stage", () => {
  assert.deepEqual(
    buildProgressDetailLines(
      {
        type: "progress",
        stage: "final-ready",
        message: "Final MP3 ready",
        totalSegments: 13
      },
      3661
    ),
    ["Generated 13 / 13 sections", "Elapsed: 1:01:01"]
  );
});

test("stream parser accepts progress events and ignores blank lines", () => {
  assert.equal(parseStreamEventLine("   "), null);

  const parsed = parseStreamEventLine(
    JSON.stringify({
      type: "progress",
      stage: "section-started",
      message: "Section 1 of 2 started",
      currentSegment: 1,
      totalSegments: 2,
      completedSegments: 0
    })
  );

  assert.deepEqual(parsed, {
    type: "progress",
    stage: "section-started",
    message: "Section 1 of 2 started",
    currentSegment: 1,
    totalSegments: 2,
    completedSegments: 0
  });
});

test("stream parser rejects malformed events", () => {
  assert.throws(() => parseStreamEventLine(JSON.stringify({ type: "progress" })), /Malformed/);
});

test("elapsed time formatting stays compact for normal and long runs", () => {
  assert.equal(formatElapsedTime(0), "00:00");
  assert.equal(formatElapsedTime(12), "00:12");
  assert.equal(formatElapsedTime(724), "12:04");
  assert.equal(formatElapsedTime(3661), "1:01:01");
});
