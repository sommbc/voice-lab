# Architecture

Voice Lab is split between a local Next.js app, shared TypeScript audio/text utilities, private filesystem storage, and a separate VoxCPM2 FastAPI service.

## Runtime Boundaries

- The Next.js app owns the UI, request validation, reference upload handling, text cleanup, chunk planning, audio processing, and private local storage.
- VoxCPM2 runs outside Next as an authenticated Python service. The Next app calls it over HTTP and does not import Torch, VoxCPM, or Python packages.
- ffmpeg work happens in Node through `lib/audio.ts`, using `ffmpeg-static` when available and a system ffmpeg fallback otherwise.
- Secrets and private artifacts stay server-side or in `VOICE_LAB_DATA_DIR`.

## Important Paths

- `app/page.tsx`: single workflow UI for reference voice, source text, generation settings, and MP3 download.
- `app/api/generate/route.ts`: VoxCPM2 long-form generation, WAV intermediates, merging, mastering, and response streaming.
- `app/api/voice-references/route.ts`: reference audio/transcript upload route.
- `lib/voxcpm.ts`: VoxCPM2 HTTP client, payload builder, and env parsing.
- `lib/voxcpm-generation.ts`: chunk sizing and prompt plan logic.
- `lib/storage.ts`: private storage root and path safety helpers.
- `lib/voice-reference-store.ts`: reference metadata, transcript validation, and upload normalization.
- `lib/text.ts`: source cleanup, paragraph preservation, and segmentation.
- `lib/audio.ts`: mastering, measurement, seam diagnostics, merging, and audio utility functions.
- `services/voxcpm/`: authenticated VoxCPM2 service.

## Generation Flow

1. Save reference audio and exact transcript under `VOICE_LAB_DATA_DIR`.
2. Clean and segment target text.
3. Build a VoxCPM2 prompt plan from the reference transcript and previous generated sections.
4. Call the authenticated VoxCPM2 service for each section.
5. Store raw WAV output, standardize it, level it, merge sections, and master the final file.
6. Persist a sanitized manifest with hashes, filenames, metrics, and run metadata.
7. Return one MP3 to the browser.

## Storage Model

`VOICE_LAB_DATA_DIR` defaults to `~/.voice-lab`. Storage helpers resolve paths under that root and reject path traversal. Manifests should store filenames, hashes, metrics, and run IDs, not raw transcript text or private absolute paths.

The repo ignores local fallback folders such as `runs/`, `voice-references/`, `.voice-lab/`, `output/`, and common audio extensions.

## Security Model

The VoxCPM2 service requires bearer auth for `/health` and `/generate`. Bind it to localhost, a private network, an SSH tunnel, or authenticated HTTPS. Do not log full audio payloads, bearer tokens, reference transcripts, or generated text.
