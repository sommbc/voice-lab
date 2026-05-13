# Archive Notes

Voice Lab is archived as an experimental local-first VoxCPM2 voice cloning attempt for long-form narration and MP3 export. It is preserved as a technical reference, not as an actively maintained production tool.

## What Worked Technically

- The Next.js app and API routes were wired for a text-first narration workflow.
- The FastAPI VoxCPM2 service wrapper exposed authenticated health and generation endpoints.
- Private reference audio, transcripts, generated intermediates, and manifests were kept outside the repository by default.
- The app could prepare saved voice references, chunk long-form text, call the local service, process WAV intermediates, and export mastered MP3 files.
- Non-generation checks covered TypeScript, tests, builds, service imports, and service health wiring.

## What Failed Practically

- VoxCPM2 output quality did not meet Brandon's production narration bar.
- Generated audio was echoey and low quality enough that further product investment was not justified.
- Passing setup, health, and build checks did not translate into production-ready narration quality.

## Why Development Stopped

Development stopped because the core output quality failed the intended use case. The remaining work would not be a small product polish pass; it would require a different voice system, model strategy, or provider direction.

## Runtime Claims

This repository should make no further production runtime claims. Existing setup and architecture documentation is retained for reference only. Anyone inspecting the project should treat it as experimental and verify all runtime behavior independently.

For production narration, hosted commercial voice systems are likely a better practical fit than continuing this VoxCPM2 local-first experiment.
