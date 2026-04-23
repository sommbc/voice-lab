"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

const VOICES = [
  { name: "Brandon",             id: "29511880-fc64-4d77-af2f-59ea3eb3efb1" },
  { name: "Paul — Neutral",      id: "c69964a6-ab8b-4f8a-9465-ec0925096ec8" },
  { name: "Paul — Confident",    id: "98559b22-62b5-4a64-a7cd-fc78ca41faa8" },
  { name: "Paul — Cheerful",     id: "01d985cd-5e0c-4457-bfd8-80ba31a5bc03" },
  { name: "Oliver — Neutral",    id: "e3596645-b1af-469e-b857-f18ddedc7652" },
  { name: "Oliver — Confident",  id: "8169ab87-bc99-4669-a5ec-6855860ace24" },
  { name: "Oliver — Curious",    id: "390c8a2b-60a6-4882-8437-c49a8bd33b63" },
  { name: "Jane — Neutral",      id: "82c99ee6-f932-423f-a4a3-d403c8914b8d" },
  { name: "Jane — Confident",    id: "cbe96cf0-85ec-4a10-accb-0b35c93b6dfd" },
  { name: "Jane — Curious",      id: "5de47977-6e47-4266-a938-3bc1d76b4676" },
];

const DEFAULT_VOICE_ID = "29511880-fc64-4d77-af2f-59ea3eb3efb1";
const VOICE_STORAGE_KEY = "voiceover-selected-voice-id";

type ProgressEvent = {
  type: "progress";
  stage: "cleaning" | "single-pass" | "chunking" | "generating" | "merging" | "done";
  message: string;
  currentChunk?: number;
  totalChunks?: number;
};

type ErrorEvent = {
  type: "error";
  message: string;
};

type CompleteEvent = {
  type: "complete";
  filename: string;
  audioBase64: string;
  totalChunks: number;
  mode: "single-pass" | "chunked";
  usedFallbackChunking: boolean;
};

type StreamEvent = ProgressEvent | ErrorEvent | CompleteEvent;

export default function HomePage() {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICE_ID);
  const [singlePassMode, setSinglePassMode] = useState(true);
  const [fallbackChunkingOnFailure, setFallbackChunkingOnFailure] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusDetail, setStatusDetail] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadFilename, setDownloadFilename] = useState("");
  const downloadUrlRef = useRef<string>("");

  useEffect(() => {
    const stored = localStorage.getItem(VOICE_STORAGE_KEY);
    if (stored && VOICES.some((v) => v.id === stored)) {
      setVoiceId(stored);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
    };
  }, []);

  function handleVoiceChange(id: string) {
    setVoiceId(id);
    localStorage.setItem(VOICE_STORAGE_KEY, id);
  }

  function handleReset() {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = "";
    }
    setTitle("");
    setText("");
    setSinglePassMode(true);
    setFallbackChunkingOnFailure(true);
    setDownloadUrl("");
    setDownloadFilename("");
    setErrorMessage("");
    setStatusMessage("");
    setStatusDetail("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!text.trim()) {
      setErrorMessage("Paste some text first.");
      return;
    }

    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = "";
    }

    setIsGenerating(true);
    setErrorMessage("");
    setDownloadUrl("");
    setDownloadFilename("");
    setStatusDetail("");
    setStatusMessage("Starting");

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          text,
          voiceId,
          singlePassMode,
          fallbackChunkingOnFailure,
        }),
      });

      if (!response.ok) {
        const fallback = await readErrorResponse(response);
        throw new Error(fallback);
      }

      if (!response.body) {
        throw new Error("Server returned no response body.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";

      while (true) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const eventPayload = JSON.parse(line) as StreamEvent;
          await handleStreamEvent(eventPayload);
        }

        if (done) {
          if (buffered.trim()) {
            const trailingEvent = JSON.parse(buffered) as StreamEvent;
            await handleStreamEvent(trailingEvent);
          }
          break;
        }
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Generation failed.");
      setStatusDetail("");
      setStatusMessage("");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleStreamEvent(event: StreamEvent) {
    if (event.type === "error") {
      throw new Error(event.message);
    }

    if (event.type === "progress") {
      setStatusMessage(event.message);

      if (event.stage === "generating" && event.currentChunk && event.totalChunks) {
        setStatusDetail(`chunk ${event.currentChunk} of ${event.totalChunks}`);
      } else {
        setStatusDetail("");
      }

      return;
    }

    const audioBytes = decodeBase64(event.audioBase64);
    const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(audioBuffer).set(audioBytes);
    const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
    const objectUrl = URL.createObjectURL(blob);

    downloadUrlRef.current = objectUrl;
    setDownloadUrl(objectUrl);
    setDownloadFilename(event.filename);
    setStatusMessage("Done");
    setStatusDetail(buildCompletionDetail(event));

    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = event.filename;
    anchor.click();
  }

  const showStatus = isGenerating || !!statusMessage;

  return (
    <main className="page">
      <div className="stack">
        <header className="header">
          <p className="sec-label">Private Tool</p>
          <h1>Voiceover</h1>
          <p className="subtitle">Paste text. Get an MP3.</p>
        </header>

        <form className="stack" onSubmit={handleSubmit}>
          <div className="row">
            <div className="card stack">
              <label className="field-label">
                <span className="field-name">File name</span>
                <input
                  className="input"
                  name="title"
                  placeholder="my-article"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>

              <label className="field-label">
                <span className="field-name">Voice</span>
                <div className="select-wrap">
                  <select
                    className="select"
                    value={voiceId}
                    onChange={(e) => handleVoiceChange(e.target.value)}
                  >
                    {VOICES.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
              </label>

              <div className="toggle-list">
                <label className="toggle">
                  <input
                    checked={singlePassMode}
                    onChange={(event) => setSinglePassMode(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <span className="toggle-text">Single pass</span>
                    <span className="toggle-note">Full document in one request.</span>
                  </span>
                </label>

                <label className="toggle">
                  <input
                    checked={fallbackChunkingOnFailure}
                    disabled={!singlePassMode}
                    onChange={(event) => setFallbackChunkingOnFailure(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <span className="toggle-text">Chunk on failure</span>
                    <span className="toggle-note">
                      Split and merge if single-pass hits limits.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="card">
              <label className="field-label">
                <span className="field-name">Text</span>
                <textarea
                  className="textarea"
                  name="text"
                  placeholder="Paste markdown or plain text."
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="controls">
            <div className="actions">
              <button className="btn-primary" disabled={isGenerating} type="submit">
                {isGenerating ? "Generating..." : "Generate"}
              </button>
            </div>

            {showStatus && (
              <div className="status-box">
                <div className="status-label">Status</div>
                <div className="status-message">
                  {statusMessage}
                  {statusDetail ? ` — ${statusDetail}` : ""}
                </div>
              </div>
            )}

            {errorMessage && (
              <div className="error-box">
                <strong>Error:</strong> {errorMessage}
              </div>
            )}

            {downloadUrl && (
              <div className="output-box">
                <div className="output-file">{downloadFilename}</div>
                <div className="actions">
                  <a className="btn-primary" href={downloadUrl} download={downloadFilename}>
                    Download
                  </a>
                  <audio
                    className="audio-player"
                    controls
                    preload="metadata"
                    src={downloadUrl}
                  />
                  <button className="btn-secondary" type="button" onClick={handleReset}>
                    New Transcription
                  </button>
                </div>
              </div>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}

function buildCompletionDetail(event: CompleteEvent): string {
  if (event.mode === "single-pass") {
    return "single-pass";
  }

  if (event.totalChunks === 1) {
    return `${event.usedFallbackChunking ? "fallback, " : ""}1 chunk`;
  }

  return `${event.usedFallbackChunking ? "fallback, " : ""}${event.totalChunks} chunks merged`;
}

async function readErrorResponse(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error ?? `Request failed with status ${response.status}.`;
  } catch {
    return `Request failed with status ${response.status}.`;
  }
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
