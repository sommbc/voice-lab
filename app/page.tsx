"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

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

const DEFAULT_STATUS = "Paste text, then generate one MP3. Single-pass mode is the default.";

export default function HomePage() {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [singlePassMode, setSinglePassMode] = useState(true);
  const [fallbackChunkingOnFailure, setFallbackChunkingOnFailure] = useState(true);
  const [statusMessage, setStatusMessage] = useState(DEFAULT_STATUS);
  const [statusDetail, setStatusDetail] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadFilename, setDownloadFilename] = useState("");
  const downloadUrlRef = useRef<string>("");

  useEffect(() => {
    return () => {
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!text.trim()) {
      setErrorMessage("Paste some text before generating audio.");
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
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title,
          text,
          singlePassMode,
          fallbackChunkingOnFailure
        })
      });

      if (!response.ok) {
        const fallback = await readErrorResponse(response);
        throw new Error(fallback);
      }

      if (!response.body) {
        throw new Error("The server returned no response body.");
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
      setStatusMessage(DEFAULT_STATUS);
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
        setStatusDetail(`Chunk ${event.currentChunk} of ${event.totalChunks}`);
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

  return (
    <main className="page">
      <div className="stack">
        <header className="panel stack">
          <div>
            <h1 style={{ margin: 0, fontSize: "2rem" }}>Voiceover</h1>
            <p className="meta" style={{ marginBottom: 0 }}>
              Paste long-form text, generate one MP3 with your saved Mistral voice, and download it.
            </p>
          </div>
          <div className="meta">
            Required env vars: <code>MISTRAL_API_KEY</code> and <code>MISTRAL_VOICE_ID</code>.
          </div>
        </header>

        <form className="stack" onSubmit={handleSubmit}>
          <div className="panel row">
            <div className="stack">
              <label className="label">
                Optional title
                <input
                  className="input"
                  name="title"
                  placeholder="substack-post"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>

              <div className="toggle-list">
                <label className="toggle">
                  <input
                    checked={singlePassMode}
                    onChange={(event) => setSinglePassMode(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    Single pass mode
                    <span className="toggle-note">
                      Try one full cleaned document request first.
                    </span>
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
                    Fallback chunking on failure
                    <span className="toggle-note">
                      If single-pass fails in a chunking-worthy way, split and merge automatically.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="stack">
              <label className="label">
                Text to speak
                <textarea
                  className="textarea"
                  name="text"
                  placeholder="Paste markdown or plain text here"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="panel stack">
            <div className="actions">
              <button className="button" disabled={isGenerating} type="submit">
                {isGenerating ? "Generating..." : "Generate MP3"}
              </button>
              <span className="meta">
                Default path: one cleaned full-document TTS request. If that fails and fallback is on,
                the server chunks and merges automatically.
              </span>
            </div>

            <div className="status">
              <strong>Status:</strong> {statusMessage}
              {statusDetail ? ` (${statusDetail})` : ""}
            </div>

            {errorMessage ? (
              <div className="error">
                <strong>Error:</strong> {errorMessage}
              </div>
            ) : null}

            {downloadUrl ? (
              <div className="download stack">
                <div>
                  <strong>Ready:</strong> {downloadFilename}
                </div>
                <div className="actions">
                  <a className="button" href={downloadUrl} download={downloadFilename}>
                    Download MP3
                  </a>
                  <audio controls preload="metadata" src={downloadUrl} />
                </div>
              </div>
            ) : null}
          </div>
        </form>
      </div>
    </main>
  );
}

function buildCompletionDetail(event: CompleteEvent): string {
  if (event.mode === "single-pass") {
    return "Used single-pass mode";
  }

  if (event.totalChunks === 1) {
    return `Used ${event.usedFallbackChunking ? "fallback chunk" : "chunk"} mode with 1 chunk`;
  }

  return `Used ${
    event.usedFallbackChunking ? "fallback chunk" : "chunk"
  } mode with ${event.totalChunks} merged chunks`;
}

async function readErrorResponse(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error || `Request failed with ${response.status}.`;
  } catch {
    return `Request failed with ${response.status}.`;
  }
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
