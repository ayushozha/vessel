# Vessel

**Software at the speed of a sentence.** Describe an app, and Vessel's agent builds, runs, repairs and ships it on [Wasmer](https://wasmer.io).

![Status](https://img.shields.io/badge/status-hackathon%20prototype-0A0A0B)
![Next.js](https://img.shields.io/badge/Next.js-16.3-0A0A0B)
![TypeScript](https://img.shields.io/badge/TypeScript-5-0EA5E9)
![Tests](https://img.shields.io/badge/tests-vitest-10B981)
![Runs](https://img.shields.io/badge/runs-locally%20only-FF8A1F)
![License](https://img.shields.io/badge/license-none%20yet-8E8E96)

Model-agnostic onboarding · ChatGPT plan usage (local mode) · OpenAI · Anthropic · GLM

- [Status](#status)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How credentials are handled](#how-credentials-are-handled)
- [API](#api)
- [Repository map](#repository-map)
- [Testing](#testing)
- [License](#license)

## Status

| Area | State |
|---|---|
| Onboarding: connect OpenAI, Anthropic or GLM (Z.ai / BigModel) with an API key | Implemented, tested |
| Onboarding: Continue with ChatGPT (local mode, plan usage) | Implemented, tested up to OpenAI consent; needs a real sign-in to confirm end to end |
| Model selection from each provider's live model list | Implemented |
| Build engine (generate → deploy on Wasmer → repair) | Roadmap, see the product spec |
| Landing page | Design preview only |

The product and engineering spec lives outside this repo in `specs/wasmer-build-with-ai/` (SPEC.md and FEATURES.md).

## Quick start

Requires Node 20+ and pnpm. PowerShell:

```powershell
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

Open **http://127.0.0.1:3000** (not `localhost`; see below).

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `CHATGPT_LOCAL_MODE` | off | `true` enables Continue with ChatGPT. Only works when the app is opened at `127.0.0.1`, because OpenAI only redirects back to a `127.0.0.1` loopback address. |
| `VESSEL_CREDENTIALS_PATH` | `~/.config/vessel/credentials.json` | Where API keys and ChatGPT tokens are stored. |

No model IDs are configured or hardcoded. Each provider's model list is fetched with the user's own credential, and the user picks one.

## How credentials are handled

- Keys and tokens are stored only in the local credentials file (owner-only permissions, atomic writes). They are never sent to the browser; the UI only sees the last four characters.
- On Windows, owner-only file modes are not enforced; the file inherits your user profile's permissions. On a shared Windows machine, point `VESSEL_CREDENTIALS_PATH` at a folder only you can read.
- A key is saved only after the provider accepts it (its model-list endpoint returns success).
- API routes answer only local, same-origin requests, which also blocks DNS-rebinding hosts.
- ChatGPT uses OpenAI's documented flow for locally run apps: PKCE (S256), one-time state and nonce that expire after 10 minutes, ID-token signature verification against OpenAI's JWKS, and a required `chatgpt.tokens.use.direct` scope before the plan can be used. A hosted version of Vessel would need OpenAI's approval and a different client.
- GLM's `/models` endpoint is not officially documented. A 404 there saves the key as *unverified* and asks for a model ID rather than claiming the key works.

## API

All routes are local-only.

| Route | Purpose |
|---|---|
| `GET /api/providers` | Connection status (masked), active provider and model, ChatGPT local-mode availability |
| `POST /api/providers` | `{ provider, apiKey, region? }`: verify a key and store it; returns the model list |
| `PATCH /api/providers` | `{ provider, model }`: choose a model and make that provider active |
| `DELETE /api/providers?provider=` | Remove a provider |
| `GET /api/providers/models?provider=` | Re-fetch models with the stored credential (refreshes ChatGPT tokens when needed) |
| `GET /api/chatgpt/start` · `GET /api/chatgpt/callback` | ChatGPT sign-in and consent |

## Repository map

| Path | Role |
|---|---|
| `src/lib/providers.ts` | Provider registry and model-list adapters |
| `src/lib/credentials.ts` | Local credential store |
| `src/lib/chatgpt.ts` | ChatGPT local OAuth flow, ID-token verification, token refresh |
| `src/lib/guard.ts` | Local-only and same-origin request guard |
| `src/app/api/` | Route handlers |
| `src/app/onboarding/` | Onboarding UI |

## Testing

```powershell
pnpm check   # lint, typecheck, unit + route tests
pnpm build
```

## Contributing

Keep these invariants: no secret ever reaches the client or logs; no hardcoded model IDs; ChatGPT plan usage stays local-only unless OpenAI approves a hosted client.

## License

No license file is currently checked in.
