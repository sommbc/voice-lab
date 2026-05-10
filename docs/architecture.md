# Architecture

Voice Lab is intentionally split between the local web app, shared TypeScript processing libraries, and optional provider sidecars.

## Runtime Boundaries

- The Next.js app owns the UI, request validation, text cleanup, Mistral calls, audio processing, and local file storage.
- Provider secrets stay server-side. Client code can submit a Mistral voice ID, but it never receives API keys.
- VoxCPM2 runs as a separate Python FastAPI service. The Next.js app calls it over HTTP and does not import Torch or Python packages.
- ffmpeg work happens in Node through `lib/audio.ts`, using `ffmpeg-static` when available and a system `ffmpeg` fallback otherwise.

## Important Paths

- `app/page.tsx`: local UI for text input, provider selection, reference capture/upload, and output controls.
- `app/api/generate/route.ts`: Mistral continuous-read and segmented fallback route.
- `app/api/voxcpm/generate/route.ts`: VoxCPM2 reference-voice route.
- `app/api/voice-references/route.ts`: reference audio/transcript upload route.
- `lib/providers/`: provider clients and provider-level types.
- `lib/storage.ts`: private storage root and path safety helpers.
- `lib/voice-reference-store.ts`: reference metadata, transcript validation, and upload normalization.
- `lib/text.ts`: source cleanup, paragraph preservation, and segmentation.
- `lib/audio.ts`: mastering, measurement, seam diagnostics, merging, and debug artifact helpers.
- `services/voxcpm/`: optional VoxCPM2 service.

## Generation Paths

### Mistral

1. Clean and normalize pasted text.
2. Try a continuous full-document request.
3. If the failure looks chunking-worthy and fallback is enabled, split into bounded sections.
4. Generate each segment with continuity context.
5. Standardize, level, score seams, retry bad seams when enabled, merge, and master.
6. Return one MP3 or WAV to the browser.

### VoxCPM2

1. Save reference audio and exact transcript under `VOICE_LAB_DATA_DIR`.
2. Clean and segment the target text.
3. Build prompt plans from the reference transcript and previous generated sections.
4. Call the authenticated VoxCPM2 service for each section.
5. Standardize, level, merge, master, and persist a sanitized manifest.
6. Return one MP3 to the browser.

## Storage Model

`VOICE_LAB_DATA_DIR` defaults to `~/.voice-lab`. The repo also ignores local fallback paths such as `runs/`, `voice-references/`, `.voice-lab/`, `output/`, and common audio extensions.

Storage helpers resolve paths under the configured root and reject path traversal. Manifests should store filenames, hashes, metrics, and run IDs, not raw transcript text or private absolute paths.

## Debugging Model

Segmented generation can emit debug artifacts when `VOICE_LAB_DEBUG_AUDIO=true`. These artifacts are meant for local diagnosis and may contain private audio. Keep them out of git and delete them before release.
