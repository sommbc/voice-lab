"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

const VOICES = [
  { name: "Brandon", id: "4482a650-b0e9-46d5-aa72-b3fbdb43fb20" },
  { name: "Paul — Neutral", id: "c69964a6-ab8b-4f8a-9465-ec0925096ec8" },
  { name: "Paul — Confident", id: "98559b22-62b5-4a64-a7cd-fc78ca41faa8" },
  { name: "Paul — Cheerful", id: "01d985cd-5e0c-4457-bfd8-80ba31a5bc03" },
  { name: "Oliver — Neutral", id: "e3596645-b1af-469e-b857-f18ddedc7652" },
  { name: "Oliver — Confident", id: "8169ab87-bc99-4669-a5ec-6855860ace24" },
  { name: "Oliver — Curious", id: "390c8a2b-60a6-4882-8437-c49a8bd33b63" },
  { name: "Jane — Neutral", id: "82c99ee6-f932-423f-a4a3-d403c8914b8d" },
  { name: "Jane — Confident", id: "cbe96cf0-85ec-4a10-accb-0b35c93b6dfd" },
  { name: "Jane — Curious", id: "5de47977-6e47-4266-a938-3bc1d76b4676" }
];

const DEFAULT_VOICE_ID = "4482a650-b0e9-46d5-aa72-b3fbdb43fb20";
const VOICE_STORAGE_KEY = "voice-lab-selected-voice-id";
const DEFAULT_VOLUME_BOOST = "normal";

type OutputFormat = "mp3" | "wav";
type VolumeBoost = "normal" | "louder" | "very-loud";
type Provider = "mistral" | "voxcpm";
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
type GenerationStrategy = "continuous-read" | "segmented-fallback" | "segmented-only";
type CompleteStrategy = GenerationStrategy | "voxcpm-short" | "voxcpm-long-form";

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
  const [provider, setProvider] = useState<Provider>("mistral");
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICE_ID);
  const [voxcpmCloneMode, setVoxcpmCloneMode] = useState<VoxcpmCloneMode>("ultimate");
  const [referenceTranscript, setReferenceTranscript] = useState("");
  const [referenceAudioFile, setReferenceAudioFile] = useState<File | null>(null);
  const [referenceAudioName, setReferenceAudioName] = useState("");
  const [voiceReference, setVoiceReference] = useState<VoiceReferenceMetadata | null>(null);
  const [referenceStatusMessage, setReferenceStatusMessage] = useState("");
  const [referenceErrorMessage, setReferenceErrorMessage] = useState("");
  const [isSavingReference, setIsSavingReference] = useState(false);
  const [isRecordingReference, setIsRecordingReference] = useState(false);
  const [continuousRead, setContinuousRead] = useState(true);
  const [fallbackToSegmented, setFallbackToSegmented] = useState(true);
  const [forceSegmentedMode, setForceSegmentedMode] = useState(false);
  const [normalizationEnabled, setNormalizationEnabled] = useState(true);
  const [volumeBoost, setVolumeBoost] = useState<VolumeBoost>(DEFAULT_VOLUME_BOOST);
  const [smoothJoins, setSmoothJoins] = useState(true);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("mp3");
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

  const segmentedControlsActive = forceSegmentedMode || !continuousRead || fallbackToSegmented;
  const voxcpmSelected = provider === "voxcpm";

  useEffect(() => {
    const stored = localStorage.getItem(VOICE_STORAGE_KEY);
    if (stored && VOICES.some((voice) => voice.id === stored)) {
      setVoiceId(stored);
      return;
    }

    if (stored) {
      localStorage.setItem(VOICE_STORAGE_KEY, DEFAULT_VOICE_ID);
    }
  }, []);

  useEffect(() => {
    void loadSavedVoiceReference();
  }, []);

  useEffect(() => {
    if (voxcpmSelected && outputFormat !== "mp3") {
      setOutputFormat("mp3");
    }
  }, [outputFormat, voxcpmSelected]);

  useEffect(() => {
    return () => {
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function handleVoiceChange(id: string) {
    setVoiceId(id);
    localStorage.setItem(VOICE_STORAGE_KEY, id);
  }

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
    } catch {
      setVoiceReference(null);
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
      setReferenceStatusMessage("Reference saved");
      setReferenceAudioFile(null);
      setReferenceAudioName("");
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
        const file = new File([blob], `brandon-reference.${extension}`, { type });
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
    setProvider("mistral");
    setContinuousRead(true);
    setFallbackToSegmented(true);
    setForceSegmentedMode(false);
    setNormalizationEnabled(true);
    setVolumeBoost(DEFAULT_VOLUME_BOOST);
    setSmoothJoins(true);
    setOutputFormat("mp3");
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

    if (voxcpmSelected && !voiceReference) {
      setErrorMessage("Save Brandon reference audio and transcript before using VoxCPM2.");
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
      const response = await fetch(voxcpmSelected ? "/api/voxcpm/generate" : "/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(
          voxcpmSelected
            ? {
                title,
                text,
                cloneMode: voxcpmCloneMode,
                normalizationEnabled,
                volumeBoost,
                outputFormat: "mp3"
              }
            : {
                title,
                text,
                voiceId,
                continuousRead,
                fallbackToSegmented,
                forceSegmentedMode,
                normalizationEnabled,
                volumeBoost,
                smoothJoins,
                outputFormat
              }
        )
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

  return (
    <main className="app-shell">
      <div className="page">
        <header className="hero">
          <p className="eyebrow">SOMMBC Private Tool</p>
          <div className="hero-main">
            <h1 className="hero-title">Voice Lab</h1>
            <p className="hero-subtitle">Paste long-form text. Generate one finished narration file.</p>
          </div>
        </header>

        <form className="workspace" onSubmit={handleSubmit}>
          <section className="panel panel-editor">
            <div className="panel-head panel-head-editor">
              <div>
                <p className="panel-kicker">Text Input</p>
                <h2 className="panel-title">Source text</h2>
              </div>
              <p className="panel-copy">Paste markdown or plain text. Cleanup still runs before narration.</p>
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
              <p className="panel-kicker">Controls</p>
              <h2 className="panel-title">Generation setup</h2>
              <p className="panel-copy">
                Defaults are tuned for one Substack-ready MP3. Adjust only what this run needs.
              </p>
            </div>

            <section className="section">
              <p className="section-heading">Output</p>
              <div className="field-grid">
                <label className="field-label">
                  <span className="field-name">File Name</span>
                  <input
                    className="input"
                    name="title"
                    placeholder="my-article"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>

                <label className="field-label">
                  <span className="field-name">Provider</span>
                  <div className="select-wrap">
                    <select
                      className="select"
                      value={provider}
                      onChange={(event) => setProvider(event.target.value as Provider)}
                    >
                      <option value="mistral">Mistral Voxtral</option>
                      <option value="voxcpm">VoxCPM2 Clone</option>
                    </select>
                  </div>
                </label>

                {!voxcpmSelected && (
                <label className="field-label">
                  <span className="field-name">Voice</span>
                  <div className="select-wrap">
                    <select
                      className="select"
                      value={voiceId}
                      onChange={(event) => handleVoiceChange(event.target.value)}
                    >
                      {VOICES.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
                )}

                <label className="field-label">
                  <span className="field-name">Output Format</span>
                  <div className="select-wrap">
                    <select
                      className="select"
                      disabled={voxcpmSelected}
                      value={voxcpmSelected ? "mp3" : outputFormat}
                      onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}
                    >
                      <option value="mp3">MP3</option>
                      <option value="wav">WAV</option>
                    </select>
                  </div>
                </label>

                <label className="field-label">
                  <span className="field-name">Volume Preset</span>
                  <div className="select-wrap">
                    <select
                      className="select"
                      disabled={!normalizationEnabled}
                      value={volumeBoost}
                      onChange={(event) => setVolumeBoost(event.target.value as VolumeBoost)}
                    >
                      <option value="normal">Normal / Substack</option>
                      <option value="louder">Louder</option>
                      <option value="very-loud">Very Loud / Emergency</option>
                    </select>
                  </div>
                </label>
              </div>
            </section>

            {voxcpmSelected && (
              <section className="section">
                <p className="section-heading">VoxCPM2 Reference</p>
                <div className="toggle-list">
                  <label className="field-label">
                    <span className="field-name">Clone Mode</span>
                    <div className="select-wrap">
                      <select
                        className="select"
                        value={voxcpmCloneMode}
                        onChange={(event) =>
                          setVoxcpmCloneMode(event.target.value as VoxcpmCloneMode)
                        }
                      >
                        <option value="ultimate">Ultimate clone</option>
                        <option value="reference">Reference clone</option>
                      </select>
                    </div>
                  </label>

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

                  {(referenceAudioName || voiceReference) && (
                    <div className="reference-status">
                      {referenceAudioName
                        ? `Selected: ${referenceAudioName}`
                        : `Saved: ${voiceReference?.referenceFilename ?? "reference.wav"}`}
                    </div>
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
                    disabled={isSavingReference || isRecordingReference}
                    type="button"
                    onClick={handleSaveReference}
                  >
                    {isSavingReference ? "Saving..." : "Save Reference"}
                  </button>

                  {referenceStatusMessage && (
                    <div className="reference-status">{referenceStatusMessage}</div>
                  )}
                  {referenceErrorMessage && (
                    <div className="reference-error">{referenceErrorMessage}</div>
                  )}
                </div>
              </section>
            )}

            {!voxcpmSelected && (
            <section className="section">
              <p className="section-heading">Narration Path</p>
              <div className="toggle-list">
                <label className="toggle">
                  <input
                    checked={continuousRead}
                    className="toggle-input"
                    onChange={(event) => {
                      setContinuousRead(event.target.checked);
                      if (event.target.checked) {
                        setForceSegmentedMode(false);
                      }
                    }}
                    type="checkbox"
                  />
                  <span className="toggle-copy">
                    <span className="toggle-text">Continuous Read</span>
                    <span className="toggle-note">
                      Default on. Reads the cleaned document as one continuous pass, then masters
                      the final file.
                    </span>
                  </span>
                </label>

                <label className="toggle">
                  <input
                    checked={fallbackToSegmented}
                    className="toggle-input"
                    disabled={!continuousRead || forceSegmentedMode}
                    onChange={(event) => setFallbackToSegmented(event.target.checked)}
                    type="checkbox"
                  />
                  <span className="toggle-copy">
                    <span className="toggle-text">Fallback to segmented mode if needed</span>
                    <span className="toggle-note">
                      {!continuousRead || forceSegmentedMode
                        ? "Continuous Read is off, so segmented generation runs directly."
                        : "If continuous read fails, retry section by section and still return one file."}
                    </span>
                  </span>
                </label>
              </div>
            </section>
            )}

            {!voxcpmSelected && (
            <details className="advanced-panel">
              <summary className="advanced-summary">
                <span className="advanced-summary-copy">
                  <span className="advanced-summary-title">Advanced</span>
                  <span className="advanced-summary-note">Secondary processing controls</span>
                </span>
                <span aria-hidden="true" className="advanced-summary-icon" />
              </summary>

              <div className="advanced-body toggle-list">
                <label className="toggle">
                  <input
                    checked={forceSegmentedMode}
                    className="toggle-input"
                    onChange={(event) => {
                      setForceSegmentedMode(event.target.checked);
                      if (event.target.checked) {
                        setContinuousRead(false);
                      }
                    }}
                    type="checkbox"
                  />
                  <span className="toggle-copy">
                    <span className="toggle-text">Force segmented mode</span>
                    <span className="toggle-note">
                      Skip continuous read and generate section by section from the start.
                    </span>
                  </span>
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

                {segmentedControlsActive && (
                  <label className="toggle">
                    <input
                      checked={smoothJoins}
                      className="toggle-input"
                      disabled={!segmentedControlsActive}
                      onChange={(event) => setSmoothJoins(event.target.checked)}
                      type="checkbox"
                    />
                    <span className="toggle-copy">
                      <span className="toggle-text">Smooth joins</span>
                      <span className="toggle-note">
                        Only used during segmented generation to soften section boundaries.
                      </span>
                    </span>
                  </label>
                )}
              </div>
            </details>
            )}
          </aside>

          <section className="action-card">
            <div className="action-copy">
              <p className="action-label">Run</p>
              <h2 className="action-title">Generate narration</h2>
              <p className="action-note">Downloads automatically when the finished file is ready.</p>
            </div>

            <div className="actions actions-primary">
              <button
                className="btn-primary"
                disabled={isGenerating || (voxcpmSelected && !voiceReference)}
                type="submit"
              >
                {isGenerating ? "Generating..." : "Generate"}
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
      case "segmented-fallback":
        return `Segmented fallback, ${event.totalSegments} sections`;
      case "segmented-only":
        return `Segmented only, ${event.totalSegments} sections`;
      case "continuous-read":
      default:
        return "Continuous read";
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

function truncate(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}
