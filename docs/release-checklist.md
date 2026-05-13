# Release Checklist

Use this before publishing the repository, tagging a release, or making runtime claims.

## Pre-Public Repository Checklist

- `git status --short` is clean before starting release work.
- `.env`, `.env.local`, `.venv`, local storage, generated audio, debug artifacts, model caches, `.next`, `.vercel`, `.DS_Store`, and `tsconfig.tsbuildinfo` are absent from the commit.
- `.env.example` contains placeholders only.
- README includes current project status, limitations, setup, runtime caveats, privacy, roadmap, attribution, and license.
- Docs agree with the current VoxCPM2-only workflow.
- No private absolute paths, personal IDs, private domains, private transcripts, generated manifests, or generated audio fixtures are tracked.
- No fake screenshots, fake badges, or unproven deployment claims are present.

## Runtime Proof Checklist

Do not claim runtime support until it has been proven on that path.

- `npm test` passes.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- `npm run check` passes.
- `npm run test:voxcpm` passes.
- Python syntax checks pass for `services/voxcpm/server.py`, `check_runtime.py`, and `check_health.py`.
- `npm run check:voxcpm` passes in the target Python environment.
- Authenticated `/health` returns `200`; unauthenticated `/health` returns `401`.
- One short private VoxCPM2 generation succeeds.
- One long-form multi-section generation succeeds.
- WAV intermediates and final MP3 are reviewed.
- Hardware path is named precisely: CUDA/Linux, Apple Silicon MPS, CPU wiring only, or other private endpoint.

## No Secrets Or Artifacts Checklist

Search for:

- old provider names
- private domains
- personal identifiers
- real API keys or token prefixes
- private absolute paths
- `.env` files
- generated audio
- generated transcripts
- generated manifests
- model caches
- build output

Expected result: no tracked public-surface matches, except documented placeholders and ignore rules.

## GitHub Settings Checklist

Suggested repository description:

```text
Archived local-first VoxCPM2 voice cloning experiment for long-form narration and MP3 export.
```

Suggested topics:

```text
archived, tts, voice-cloning, voxcpm2, nextjs, fastapi, local-first, speech, mp3
```

Recommended settings before public release:

- Enable private vulnerability reporting if available.
- Require pull request review for protected branches if collaborators are added.
- Keep GitHub Pages disabled unless documentation hosting is intentional.
- Do not add CI badges until CI is actually configured.
- Do not attach private/generated audio to releases.

## Security Checklist

- VoxCPM2 requires bearer auth.
- The service is bound to localhost, a private network, an SSH tunnel, or authenticated HTTPS.
- Public deployments have an explicit auth and retention plan.
- Generated manifests do not contain raw transcript text, source text, tokens, base64 audio, or private paths.
- `.env.example` contains no real secrets.
