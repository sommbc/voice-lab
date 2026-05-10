# Providers

Voice Lab treats providers as server-side adapters with explicit runtime boundaries.

## Current Providers

| Provider | Route | Adapter | Notes |
| --- | --- | --- | --- |
| Mistral Voxtral | `app/api/generate/route.ts` | `lib/providers/mistral.ts` | Continuous-read first, segmented fallback when useful. |
| VoxCPM2 | `app/api/voxcpm/generate/route.ts` | `lib/providers/voxcpm.ts` | Requires separate authenticated Python service. |

## Provider Rules

- API keys and bearer tokens must stay server-side.
- Provider clients should live under `lib/providers/`.
- Provider payload builders should be testable without network calls.
- Provider errors returned to the browser must be sanitized for private paths, auth headers, and base64 audio.
- Next.js routes should not import heavyweight provider runtimes such as Torch.
- Reference audio and transcripts should be read from private local storage, not committed fixtures.

## Adding A Provider

1. Add provider-specific types or shared IDs in `lib/providers/types.ts`.
2. Add the provider client in `lib/providers/<provider>.ts`.
3. Keep payload construction in a pure function and add tests for it.
4. Add a route only if the provider needs a different workflow from existing routes.
5. Document required env vars in `README.md` and a provider doc.
6. Add privacy notes for any uploaded reference material.

## Capability Differences

Do not assume every provider supports the same behavior. Some providers support long inputs but produce uneven pacing. Some providers support reference audio but do not preserve identity well over long runs. Some providers return compressed audio while others return WAV. The UI and docs should describe capabilities honestly rather than presenting all providers as interchangeable.
