# Voice Lab

Voice Lab is an open-source speech lab for long-form voice generation, TTS provider experimentation, voice-cloning workflows, segmented generation diagnostics, seam scoring, mastering, and podcast-ready MP3 export. It is built as a local-first Next.js app with server-side provider calls and a separate optional VoxCPM2 service for GPU-backed reference-voice experiments.

No screenshots are included yet. The app ships with a dark editorial default theme that can be replaced by downstream projects.

## Features

- Mistral Voxtral TTS generation with continuous-read first and segmented fallback modes.
- VoxCPM2 reference-voice workflow through an authenticated FastAPI sidecar service.
- Long-form text cleanup, markdown stripping, URL removal, and speech-friendly normalization.
- Deterministic segmentation for provider limits and retryable generation failures.
- Seam diagnostics, acoustic scoring, bounded regeneration, multi-take selection, and debug manifests for segmented output.
- Final mastering to normal, louder, or very-loud presets with MP3 or WAV export where supported.
- Local private storage for reference audio, transcripts, run WAVs, final files, and manifests.
- Audio analysis and mastering comparison scripts for provider and pipeline testing.

## Honest Limitations

- Voice Lab does not guarantee perfect voice cloning.
- Provider APIs can impose text length, latency, rate, model, voice, and quality limits.
- Continuous long-form narration is not seamless with every provider or every voice.
- VoxCPM2 is experimental for long-form narration and needs a suitable GPU for real work.
- Seam scores are diagnostics, not a substitute for listening to final audio.
- The app returns generated audio to the browser as base64 in the response stream, so keep deployments private unless you harden the delivery path.

## Architecture

```text
Next.js app
  app/page.tsx                  local UI
  app/api/generate              Mistral continuous/segmented generation
  app/api/voxcpm/generate       VoxCPM2 reference-voice generation
  app/api/voice-references      reference audio/transcript storage

Shared TypeScript libraries
  lib/providers                 provider clients and provider types
  lib/audio.ts                  ffmpeg, mastering, seam diagnostics
  lib/text.ts                   text cleanup and segmentation
  lib/storage.ts                private local storage path handling
  lib/voice-reference-store.ts  reference metadata and upload handling

Optional Python service
  services/voxcpm/server.py     authenticated FastAPI wrapper for VoxCPM2
```

Provider secrets are read only on the server. The Next app does not import Torch, VoxCPM, or other Python/GPU dependencies.

More detail:

- [docs/architecture.md](docs/architecture.md)
- [docs/providers.md](docs/providers.md)
- [docs/mistral.md](docs/mistral.md)
- [docs/voxcpm.md](docs/voxcpm.md)

## Quick Start

Requirements:

- Node.js `>=20.9.0`
- npm
- ffmpeg, either from `ffmpeg-static` or available on `PATH`
- A Mistral API key for Voxtral TTS
- Optional: CUDA GPU environment for VoxCPM2

```bash
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MISTRAL_API_KEY` | For Mistral | none | Server-only Mistral API key. |
| `MISTRAL_VOICE_ID` | For Mistral default voice | none | Server-side default voice ID. The UI can override per run. |
| `VOICE_LAB_DATA_DIR` | No | `~/.voice-lab` | Private local storage root for references and VoxCPM run artifacts. Keep outside the repo. |
| `VOICE_LAB_DEBUG_AUDIO` | No | `false` | Keeps segmented debug artifacts under a temporary debug directory and logs that path server-side. |
| `VOICE_LAB_MASTERING_STRATEGY` | No | `static` | `static` or `speech-leveler`. |
| `VOICE_LAB_CONTEXT_OVERLAP` | No | `true` | Adds neighboring text context for segmented Mistral prompts. |
| `VOICE_LAB_TONE_SEAM_SCORING` | No | `true` | Enables prosody/tone proxy scoring in seam diagnostics. |
| `VOICE_LAB_SEAM_RETRIES` | No | `2` | Bounded retry count for failed segmented seams. |
| `VOICE_LAB_MULTI_TAKE_COUNT` | No | `1` | Number of segmented takes considered during multi-take optimization. Values above `5` are clamped. |
| `VOXCPM_ENABLED` | For VoxCPM2 | `false` | Must be `true` for the Next app to call the VoxCPM2 service. |
| `VOXCPM_ENDPOINT_URL` | For VoxCPM2 | `http://127.0.0.1:8809/generate` | Authenticated VoxCPM2 generate endpoint. |
| `VOXCPM_HEALTH_URL` | For VoxCPM2 | `http://127.0.0.1:8809/health` | Authenticated VoxCPM2 health endpoint for operators. |
| `VOXCPM_API_KEY` | For VoxCPM2 | none | Shared bearer token between Next and the VoxCPM2 service. |
| `VOXCPM_ENDPOINT_MODE` | No | `native-wrapper` | `native-wrapper` or `vllm-omni`. |
| `VOXCPM_MODEL` | No | `openbmb/VoxCPM2` | Model identifier used by the service or compatible endpoint. |
| `VOXCPM_TIMEOUT_MS` | No | `300000` | Request timeout for VoxCPM2 generation. |
| `VOXCPM_CFG_VALUE` | No | `2.0` | VoxCPM2 CFG value. |
| `VOXCPM_INFERENCE_TIMESTEPS` | No | `10` | VoxCPM2 inference steps. |
| `VOXCPM_NORMALIZE_TEXT` | No | `true` | Requests provider-side text normalization. |
| `VOXCPM_DENOISE_REFERENCE` | No | `false` | Requests denoising when the service was started with denoiser support. |

## Provider Setup

### Mistral Voxtral

1. Create a Mistral API key.
2. Set `MISTRAL_API_KEY` in `.env`.
3. Set `MISTRAL_VOICE_ID` to the voice you want as the server default, or leave it blank and enter a voice ID in the UI for each run.
4. Run `npm run dev`.

The Mistral route first attempts a full-document request. If the provider rejects or times out for a chunking-worthy reason, Voice Lab can fall back to segmented generation and return one mastered file.

See [docs/mistral.md](docs/mistral.md).

### VoxCPM2

VoxCPM2 runs outside Next as a separate authenticated service. GPU is strongly recommended and usually required for practical generation speed.

```bash
uv python install 3.11
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
uv pip install -r services/voxcpm/requirements.txt
VOXCPM_API_KEY="replace-me" VOXCPM_DEVICE=cuda uvicorn services.voxcpm.server:app --host 127.0.0.1 --port 8809
```

Then set in `.env`:

```bash
VOXCPM_ENABLED=true
VOXCPM_ENDPOINT_URL=http://127.0.0.1:8809/generate
VOXCPM_HEALTH_URL=http://127.0.0.1:8809/health
VOXCPM_API_KEY=replace-me
```

Health check:

```bash
curl -H "Authorization: Bearer $VOXCPM_API_KEY" http://127.0.0.1:8809/health
```

See [docs/voxcpm.md](docs/voxcpm.md).

## Generating Audio

1. Paste markdown or plain text into the source text area.
2. Choose `Mistral Voxtral` or `VoxCPM2 reference voice`.
3. For Mistral, optionally enter a voice ID. If blank, the server uses `MISTRAL_VOICE_ID`.
4. For VoxCPM2, save reference audio with the exact spoken transcript before generation.
5. Choose output format and mastering preset.
6. Select advanced segmented controls only when you need to bypass continuous-read behavior.
7. Generate. The browser downloads the final file when the run completes.

## Debug Artifacts

Set `VOICE_LAB_DEBUG_AUDIO=true` to retain server-side debug artifacts for segmented runs. Debug output can include raw segments, standardized WAVs, leveled WAVs, seam clips, pre-master audio, final mastered output, and a diagnostics manifest.

Reference audio, transcripts, generated WAVs/MP3s, and manifests may contain private material. Keep `VOICE_LAB_DATA_DIR` outside the repo and do not commit generated artifacts.

## Scripts

```bash
npm run dev
npm test
npm run typecheck
npm run build
npm run check
npm run clean
npm run analyze-audio -- ./path/to/file.mp3
npm run mastering-ab -- ./path/to/source.md
npm run segmented-ab -- ./path/to/source.md
```

`npm run check` runs tests, TypeScript, and production build. There is no lint script until a real lint configuration exists.

## Tests

Tests use Node's built-in test runner through `tsx`.

```bash
npm test
npx tsc --noEmit
npm run build
git diff --check
```

Coverage currently focuses on text cleanup, segmentation, mastering argument generation, provider payloads, storage path safety, reference metadata sanitization, and VoxCPM prompt planning.

## Security And Privacy

- `.env` and local env variants are ignored.
- `.env.example` contains placeholders only.
- Provider API keys are server-only.
- VoxCPM2 requires bearer-token auth and should be bound to localhost, an SSH tunnel, a private network, or authenticated HTTPS.
- Reference audio, exact transcripts, generated audio, and manifests are private by default.
- Generated outputs and common audio files are ignored by git.
- Do not deploy this publicly without revisiting authentication, upload limits, retention policy, and response streaming.
- Do not log API keys, bearer tokens, full base64 audio payloads, or private transcript content.

## Roadmap

- Provider registry and capability reporting.
- Optional authenticated project workspace mode.
- More provider adapters for TTS and voice conversion experiments.
- Better run browser for local artifacts without exposing private paths.
- STT and podcast transcript workflows.
- More seam diagnostics and listening-review tooling.
- CI once the public repository has its GitHub workflow policy settled.

## License

MIT. See [LICENSE](LICENSE).
