"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

const DEFAULT_VOLUME_BOOST = "normal";

type OutputFormat = "mp3";
type VolumeBoost = "normal" | "louder" | "very-loud";
type VoxcpmCloneMode = "reference" | "ultimate";
type ProgressStage =
  | "cleaning"
  | "segmenting"
  | "single-pass"
  | "generating"
  | "normalizing"
  | "smoothing"
  | "merging"
  | "final-normalization"
  | "done";
type CompleteStrategy = "voxcpm-short" | "voxcpm-long-form";

type VoiceReferenceMetadata = {
  id: string;
  updatedAt: string;
  referenceFilename: string;
  transcriptFilename: string;
  audioSha256: string;
  transcriptSha256: string;
  audioBytes: number;
  transcriptCharacters: number;
};

type ProgressEvent = {
  type: "progress";
  stage: ProgressStage;
  message: string;
  currentSegment?: number;
  totalSegments?: number;
};

type ErrorEvent = {
  type: "error";
  message: string;
};

type CompleteEvent = {
  type: "complete";
  filename: string;
  audioBase64: string;
  mimeType: string;
  outputFormat: OutputFormat;
  normalizationApplied: boolean;
  normalizationFallbackUsed: boolean;
  strategy: CompleteStrategy;
  totalSegments: number;
};

type StreamEvent = ProgressEvent | ErrorEvent | CompleteEvent;

export default function HomePage() {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [voxcpmCloneMode, setVoxcpmCloneMode] = useState<VoxcpmCloneMode>("ultimate");
  const [referenceTranscript, setReferenceTranscript] = useState("");
  const [referenceAudioFile, setReferenceAudioFile] = useState<File | null>(null);
  const [referenceAudioName, setReferenceAudioName] = useState("");
  const [voiceReference, setVoiceReference] = useState<VoiceReferenceMetadata | null>(null);
  const [isReplacingReference, setIsReplacingReference] = useState(false);
  const [referenceStatusMessage, setReferenceStatusMessage] = useState("");
  const [referenceErrorMessage, setReferenceErrorMessage] = useState("");
  const [isSavingReference, setIsSavingReference] = useState(false);
  const [isRecordingReference, setIsRecordingReference] = useState(false);
  const [normalizationEnabled, setNormalizationEnabled] = useState(true);
  const [volumeBoost, setVolumeBoost] = useState<VolumeBoost>(DEFAULT_VOLUME_BOOST);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusDetail, setStatusDetail] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadFilename, setDownloadFilename] = useState("");
  const downloadUrlRef = useRef<string>("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    void loadSavedVoiceReference();
  }, []);

  useEffect(() => {
    return () => {
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function loadSavedVoiceReference() {
    try {
      const response = await fetch("/api/voice-references", {
        method: "GET",
        cache: "no-store"
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as { reference?: VoiceReferenceMetadata | null };
      setVoiceReference(data.reference ?? null);
      setIsReplacingReference(!data.reference);
    } catch {
      setVoiceReference(null);
      setIsReplacingReference(true);
    }
  }

  async function handleReferenceUpload(file: File | null) {
    setReferenceErrorMessage("");
    setReferenceStatusMessage("");

    if (!file) {
      setReferenceAudioFile(null);
      setReferenceAudioName("");
      return;
    }

    setReferenceAudioFile(file);
    setReferenceAudioName(file.name || "recorded-reference.wav");
  }

  async function handleSaveReference() {
    if (!referenceAudioFile) {
      setReferenceErrorMessage("Record or upload reference audio first.");
      return;
    }

    if (!referenceTranscript.trim()) {
      setReferenceErrorMessage("Enter the exact transcript for the reference audio.");
      return;
    }

    setIsSavingReference(true);
    setReferenceErrorMessage("");
    setReferenceStatusMessage("Saving reference");

    try {
      const formData = new FormData();
      formData.append("audio", referenceAudioFile);
      formData.append("transcript", referenceTranscript);

      const response = await fetch("/api/voice-references", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const fallback = await readErrorResponse(response);
        throw new Error(fallback);
      }

      const data = (await response.json()) as { reference: VoiceReferenceMetadata };
      setVoiceReference(data.reference);
      setReferenceStatusMessage("Saved voice reference ready");
      setReferenceAudioFile(null);
      setReferenceAudioName("");
      setReferenceTranscript("");
      setIsReplacingReference(false);
    } catch (error) {
      setReferenceStatusMessage("");
      setReferenceErrorMessage(
        sanitizeErrorMessage(error instanceof Error ? error.message : "Reference save failed.")
      );
    } finally {
      setIsSavingReference(false);
    }
  }

  async function handleToggleRecording() {
    if (isRecordingReference) {
      mediaRecorderRef.current?.stop();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setReferenceErrorMessage("Browser microphone recording is not available.");
      return;
    }

    setReferenceErrorMessage("");
    setReferenceStatusMessage("Recording reference");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordingStreamRef.current = stream;
      recordedChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(recordedChunksRef.current, { type });
        const extension = type.includes("webm") ? "webm" : type.includes("ogg") ? "ogg" : "wav";
        const file = new File([blob], `voice-reference.${extension}`, { type });
        setReferenceAudioFile(file);
        setReferenceAudioName(file.name);
        setReferenceStatusMessage("Recording ready");
        setIsRecordingReference(false);
        recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecordingReference(true);
    } catch (error) {
      setReferenceStatusMessage("");
      setReferenceErrorMessage(
        sanitizeErrorMessage(error instanceof Error ? error.message : "Microphone access failed.")
      );
      setIsRecordingReference(false);
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
    }
  }

  function handleReset() {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = "";
    }

    setTitle("");
    setText("");
    setNormalizationEnabled(true);
    setVolumeBoost(DEFAULT_VOLUME_BOOST);
    setDownloadUrl("");
    setDownloadFilename("");
    setErrorMessage("");
    setStatusMessage("");
    setStatusDetail("");
  }

  function handleStartReplacingReference() {
    setIsReplacingReference(true);
    setReferenceErrorMessage("");
    setReferenceStatusMessage("");
  }

  function handleCancelReplacingReference() {
    setIsReplacingReference(false);
    setReferenceAudioFile(null);
    setReferenceAudioName("");
    setReferenceTranscript("");
    setReferenceErrorMessage("");
    setReferenceStatusMessage("");
    if (isRecordingReference) {
      mediaRecorderRef.current?.stop();
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!text.trim()) {
      setErrorMessage("Paste some text first.");
      return;
    }

    if (!voiceReference) {
      setErrorMessage("Save reference audio and its exact transcript before generating.");
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
          cloneMode: voxcpmCloneMode,
          normalizationEnabled,
          volumeBoost,
          outputFormat: "mp3" satisfies OutputFormat
        })
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
      setErrorMessage(
        sanitizeErrorMessage(error instanceof Error ? error.message : "Generation failed.")
      );
      setStatusDetail("");
      setStatusMessage("");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleStreamEvent(event: StreamEvent) {
    if (event.type === "error") {
      throw new Error(sanitizeErrorMessage(event.message));
    }

    if (event.type === "progress") {
      setStatusMessage(event.message);

      if (event.stage === "generating" && event.currentSegment && event.totalSegments) {
        setStatusDetail(`section ${event.currentSegment} of ${event.totalSegments}`);
      } else {
        setStatusDetail("");
      }

      return;
    }

    const audioBytes = decodeBase64(event.audioBase64);
    const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(audioBuffer).set(audioBytes);
    const blob = new Blob([audioBuffer], { type: event.mimeType });
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
  const showFeedbackPlaceholder = !showStatus && !errorMessage && !downloadUrl;
  const showReferenceSetup = !voiceReference || isReplacingReference;
  const canSaveReference = canSaveVoiceReference({
    hasNewAudio: !!referenceAudioFile,
    transcript: referenceTranscript,
    isSavingReference,
    isRecordingReference
  });
  const canGenerate = canGenerateMp3({
    hasSavedReference: !!voiceReference,
    sourceText: text,
    isGenerating
  });

  return (
    <main className="app-shell">
      <div className="page">
        <header className="hero">
          <p className="eyebrow">Local voice cloning</p>
          <div className="hero-main">
            <h1 className="hero-title">Voice Lab</h1>
            <p className="hero-subtitle">
              Clone a reference voice with VoxCPM2, narrate long-form text, and export a mastered MP3 from a local or self-hosted setup.
            </p>
          </div>
        </header>

        <form className="workspace" onSubmit={handleSubmit}>
          <section className="panel panel-editor">
            <div className="panel-head panel-head-editor">
              <div>
                <p className="panel-kicker">Text Input</p>
                <h2 className="panel-title">Source text</h2>
              </div>
              <p className="panel-copy">Long-form text is cleaned, chunked for VoxCPM2, and delivered as one mastered file.</p>
            </div>

            <label className="field-label field-label-editor">
              <span className="sr-only">Text</span>
              <textarea
                className="textarea"
                name="text"
                placeholder="Paste markdown or plain text."
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
          </section>

          <aside className="panel panel-rail">
            <div className="panel-head">
              <p className="panel-kicker">Workflow</p>
              <h2 className="panel-title">Reference voice</h2>
              <p className="panel-copy">
                Create this once. Use 45-90 seconds of clean speech. Paste the exact words spoken. Voice Lab reuses the saved reference for future MP3s.
              </p>
            </div>

            <section className="section">
              <p className="section-heading">Reference Voice</p>
              <div className="toggle-list">
                {voiceReference ? (
                  <div className="reference-ready">
                    <div className="reference-ready-copy">
                      <div className="reference-ready-title">Saved voice reference ready</div>
                      <p>Voice Lab will reuse this reference for every generation.</p>
                      <p>Replace it only when you want to update your voice sample.</p>
                    </div>
                    <dl className="reference-meta" aria-label="Saved voice reference details">
                      <div>
                        <dt>Audio</dt>
                        <dd>{voiceReference.referenceFilename || "reference audio saved"}</dd>
                      </div>
                      <div>
                        <dt>Last updated</dt>
                        <dd>{formatReferenceDate(voiceReference.updatedAt)}</dd>
                      </div>
                      <div>
                        <dt>Transcript</dt>
                        <dd>{formatCharacterCount(voiceReference.transcriptCharacters)}</dd>
                      </div>
                      <div>
                        <dt>File size</dt>
                        <dd>{formatFileSize(voiceReference.audioBytes)}</dd>
                      </div>
                    </dl>
                  </div>
                ) : (
                  <div className="reference-status">
                    First-time setup: record or upload 45-90 seconds of clean speech, paste the exact transcript, then save it once.
                  </div>
                )}

                {voiceReference && !showReferenceSetup && (
                  <button
                    className="btn-secondary"
                    disabled={isSavingReference}
                    type="button"
                    onClick={handleStartReplacingReference}
                  >
                    Replace Reference
                  </button>
                )}

                {showReferenceSetup && (
                  <div className="replace-reference">
                    {voiceReference && (
                      <div className="replace-reference-head">
                        <p className="section-heading">Replace reference</p>
                        <button
                          className="btn-secondary btn-compact"
                          disabled={isSavingReference || isRecordingReference}
                          type="button"
                          onClick={handleCancelReplacingReference}
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    <div className="reference-actions">
                      <button
                        className="btn-secondary btn-compact"
                        disabled={isSavingReference}
                        type="button"
                        onClick={handleToggleRecording}
                      >
                        {isRecordingReference ? "Stop Recording" : "Record"}
                      </button>
                      <label className="btn-secondary btn-compact file-button">
                        Upload
                        <input
                          accept="audio/*"
                          className="file-input"
                          type="file"
                          onChange={(event) =>
                            void handleReferenceUpload(event.target.files?.[0] ?? null)
                          }
                        />
                      </label>
                    </div>

                    {referenceAudioName && (
                      <div className="reference-status">Selected: {referenceAudioName}</div>
                    )}

                    <label className="field-label">
                      <span className="field-name">Exact Transcript</span>
                      <textarea
                        className="textarea textarea-compact"
                        placeholder="Paste the exact words spoken in the reference audio."
                        value={referenceTranscript}
                        onChange={(event) => setReferenceTranscript(event.target.value)}
                      />
                    </label>

                    <button
                      className="btn-secondary"
                      disabled={!canSaveReference}
                      type="button"
                      onClick={handleSaveReference}
                    >
                      {isSavingReference ? "Saving..." : "Save Reference"}
                    </button>
                  </div>
                )}

                {referenceStatusMessage && (
                  <div className="reference-status">{referenceStatusMessage}</div>
                )}
                {referenceErrorMessage && (
                  <div className="reference-error">{referenceErrorMessage}</div>
                )}
              </div>
            </section>

            <section className="section">
              <p className="section-heading">Generation Settings</p>
              <div className="field-grid">
                <label className="field-label">
                  <span className="field-name">File Name</span>
                  <input
                    className="input"
                    name="title"
                    placeholder="my-narration"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>

                <label className="field-label">
                  <span className="field-name">Output</span>
                  <input className="input" disabled readOnly value="Mastered MP3" />
                </label>

                <label className="field-label">
                  <span className="field-name">Mastering Preset</span>
                  <div className="select-wrap">
                    <select
                      className="select"
                      disabled={!normalizationEnabled}
                      value={volumeBoost}
                      onChange={(event) => setVolumeBoost(event.target.value as VolumeBoost)}
                    >
                      <option value="normal">Normal / podcast MP3</option>
                      <option value="louder">Louder</option>
                      <option value="very-loud">Very Loud</option>
                    </select>
                  </div>
                </label>
              </div>
            </section>

            <details className="advanced-panel">
              <summary className="advanced-summary">
                <span className="advanced-summary-copy">
                  <span className="advanced-summary-title">Advanced VoxCPM</span>
                  <span className="advanced-summary-note">Reference and mastering controls</span>
                </span>
                <span aria-hidden="true" className="advanced-summary-icon" />
              </summary>

              <div className="advanced-body toggle-list">
                <label className="field-label">
                  <span className="field-name">Reference Mode</span>
                  <div className="select-wrap">
                    <select
                      className="select"
                      value={voxcpmCloneMode}
                      onChange={(event) =>
                        setVoxcpmCloneMode(event.target.value as VoxcpmCloneMode)
                      }
                    >
                      <option value="ultimate">Reference plus prompt text</option>
                      <option value="reference">Reference audio only</option>
                    </select>
                  </div>
                </label>

                <label className="toggle">
                  <input
                    checked={normalizationEnabled}
                    className="toggle-input"
                    onChange={(event) => setNormalizationEnabled(event.target.checked)}
                    type="checkbox"
                  />
                  <span className="toggle-copy">
                    <span className="toggle-text">Audio normalization</span>
                    <span className="toggle-note">Apply final mastering before delivery.</span>
                  </span>
                </label>
              </div>
            </details>
          </aside>

          <section className="action-card">
            <div className="action-copy">
              <p className="action-label">Run</p>
              <h2 className="action-title">Generate MP3</h2>
              <p className="action-note">Downloads automatically when the finished file is ready.</p>
            </div>

            <div className="actions actions-primary">
              <button
                className="btn-primary"
                disabled={!canGenerate}
                type="submit"
              >
                {isGenerating ? "Generating..." : "Generate MP3"}
              </button>
            </div>
          </section>

          <section className="feedback-stack">
            {showStatus && (
              <div aria-live="polite" className="feedback-card status-box" role="status">
                <div className="status-label">Status</div>
                <div className="status-message">{statusMessage}</div>
                {statusDetail && <div className="status-detail">{statusDetail}</div>}
              </div>
            )}

            {errorMessage && (
              <div className="feedback-card error-box" role="alert">
                <div className="status-label">Error</div>
                <div className="error-message">{errorMessage}</div>
              </div>
            )}

            {downloadUrl && (
              <div aria-live="polite" className="feedback-card output-box">
                <div className="status-label">Result</div>
                <div className="output-file">{downloadFilename}</div>
                <audio className="audio-player" controls preload="metadata" src={downloadUrl} />
                <div className="output-actions">
                  <a className="btn-secondary" href={downloadUrl} download={downloadFilename}>
                    Download
                  </a>
                  <button className="btn-secondary" type="button" onClick={handleReset}>
                    New Narration
                  </button>
                </div>
              </div>
            )}

            {showFeedbackPlaceholder && (
              <div className="feedback-card placeholder-box">
                <div className="status-label">Session</div>
                <div className="status-message">
                  Progress, errors, and the finished file appear here during generation.
                </div>
              </div>
            )}
          </section>
        </form>
      </div>
    </main>
  );
}

function buildCompletionDetail(event: CompleteEvent): string {
  const strategyLabel = (() => {
    switch (event.strategy) {
      case "voxcpm-long-form":
        return `VoxCPM2 long-form, ${event.totalSegments} sections`;
      case "voxcpm-short":
        return "VoxCPM2 clone";
      default:
        return "VoxCPM2";
    }
  })();

  return `${strategyLabel}, ${event.outputFormat.toUpperCase()}, ${
    event.normalizationApplied
      ? "mastered"
      : event.normalizationFallbackUsed
        ? "mastering fallback used"
        : "mastering off"
  }`;
}

async function readErrorResponse(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return sanitizeErrorMessage(data.error ?? `Request failed with status ${response.status}.`);
  } catch {
    return `Request failed with status ${response.status}.`;
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

function sanitizeErrorMessage(message: string): string {
  return truncate(
    message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (line) =>
          !/^ffmpeg version /i.test(line) &&
          !/^built with /i.test(line) &&
          !/^configuration:/i.test(line) &&
          !/^libav[a-z]+\s+/i.test(line)
      )
      .join(" "),
    280
  );
}

export function canSaveVoiceReference({
  hasNewAudio,
  transcript,
  isSavingReference = false,
  isRecordingReference = false
}: {
  hasNewAudio: boolean;
  transcript: string;
  isSavingReference?: boolean;
  isRecordingReference?: boolean;
}): boolean {
  return hasNewAudio && transcript.trim().length > 0 && !isSavingReference && !isRecordingReference;
}

export function canGenerateMp3({
  hasSavedReference,
  sourceText,
  isGenerating = false
}: {
  hasSavedReference: boolean;
  sourceText: string;
  isGenerating?: boolean;
}): boolean {
  return hasSavedReference && sourceText.trim().length > 0 && !isGenerating;
}

function formatReferenceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatCharacterCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 characters";
  }

  return `${value.toLocaleString()} characters`;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "unknown";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function truncate(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}
