# Adorable

**Software at the speed of a sentence.** Describe an app, and Adorable's agent builds, runs, repairs and ships it on [Wasmer](https://wasmer.io).

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
- [Project memory](#project-memory)
- [License](#license)

## Status

| Area | State |
|---|---|
| Onboarding step 1: Sign in with Wasmer (creates the wasmer.io account if needed and links it; required before anything else) | Implemented, tested up to wasmer.io log in; needs a real sign-in to confirm end to end |
| Onboarding: connect OpenAI, Anthropic or GLM (Z.ai / BigModel) with an API key | Implemented, tested |
| Onboarding: Continue with ChatGPT (local mode, plan usage) | Implemented, tested up to OpenAI consent; needs a real sign-in to confirm end to end |
| Model selection from each provider's live model list | Implemented |
| Build engine: plan, then parallel per-file generation from the connected model | Implemented, tested |
| Local run: each project in a Wasmer SDK sandbox (Edge.js) with persistent host-side PGlite Postgres | Implemented, tested |
| Project memory with Provena: decisions and preferences recalled on every run | Implemented, tested (needs `pnpm setup:provena`) |
| Token and cost tracking: tokens per run and project; USD for API keys via [genai-prices](https://github.com/pydantic/genai-prices) | Implemented, tested; ChatGPT plan runs show tokens only |
| One-click Publish to Wasmer Edge with Anybuild (zip upload, stack detection, build, live URL; managed Postgres for apps that use `pg`; republish = new version of the same app) | Implemented, tested against a mock and the live API's schema; needs a real publish to confirm end to end |
| Checks, Edge logs and auto-repair | Roadmap, see the product spec |
| Landing page | Design preview only |

The product and engineering spec lives outside this repo in `specs/wasmer-build-with-ai/` (SPEC.md and FEATURES.md).

## Quick start

Requires Node 20+ and pnpm. PowerShell:

```powershell
pnpm install
pnpm setup:provena   # optional: enables project memory
Copy-Item .env.example .env.local
pnpm dev
```

Open the **sign-in link printed in the terminal** (`http://127.0.0.1:3000/auth?token=…`). Every page and API call needs this launch's token, so other local processes, including generated apps in their sandboxes, cannot use Adorable. Use `127.0.0.1`, not `localhost` (see below); app previews are served from `localhost` on purpose so they never receive Adorable's cookie.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `CHATGPT_LOCAL_MODE` | off | `true` enables Continue with ChatGPT. Only works when the app is opened at `127.0.0.1`, because OpenAI only redirects back to a `127.0.0.1` loopback address. |
| `WASMER_REGISTRY` | `https://registry.wasmer.io/graphql` | Wasmer GraphQL API used for sign-in and publishing (for example `https://registry.wasmer.wtf/graphql` for the dev environment). |
| `VESSEL_CREDENTIALS_PATH` | `~/.config/vessel/credentials.json` | Where API keys and ChatGPT tokens are stored. |
| `VESSEL_PROVENA_CLI` | `~/.config/vessel/toolchains/provena/cli/dist/cli.js` | Provena CLI used for project memory. Memory is off when it is missing. |

No model IDs are configured or hardcoded. Each provider's model list is fetched with the user's own credential, and the user picks one.

## How credentials are handled

- Sign in with Wasmer uses the same flow as `wasmer login`: Adorable asks Wasmer for a nonce whose callback is a one-shot listener on a random `127.0.0.1` port with an unguessable path, then opens `wasmer.io/auth/cli`. Signed-out visitors log in or sign up on wasmer.io first. When the user authorizes, wasmer.io posts a personal API token (named `adorable`) to the listener; Adorable accepts it only from wasmer.io's origin, checks it with Wasmer's `viewer` query, stores it and closes the listener. Sign out forgets the token locally; revoke it in Wasmer's settings.
- Keys and tokens are stored only in the local credentials file (owner-only permissions, atomic writes). They are never sent to the browser; the UI only sees the last four characters.
- On Windows, owner-only file modes are not enforced; the file inherits your user profile's permissions. On a shared Windows machine, point `VESSEL_CREDENTIALS_PATH` at a folder only you can read.
- A key is saved only after the provider accepts it (its model-list endpoint returns success).
- API routes answer only local, same-origin requests, which also blocks DNS-rebinding hosts.
- ChatGPT uses OpenAI's documented flow for locally run apps: PKCE (S256), one-time state and nonce that expire after 10 minutes, ID-token signature verification against OpenAI's JWKS, and a required `chatgpt.tokens.use.direct` scope before the plan can be used. A hosted version of Adorable would need OpenAI's approval and a different client.
- GLM's `/models` endpoint is not officially documented. A 404 there saves the key as *unverified* and asks for a model ID rather than claiming the key works.

## API

All routes are local-only.

| Route | Purpose |
|---|---|
| `GET /api/wasmer` · `DELETE` | Linked Wasmer account (username and email only) · sign out |
| `POST /api/wasmer/login` · `GET ?id=` · `DELETE ?id=` | Start a Wasmer sign-in (returns `authUrl` and `signupUrl`) · poll it · cancel it |
| `GET /api/providers` | Connection status (masked), active provider and model, ChatGPT local-mode availability |
| `POST /api/providers` | `{ provider, apiKey, region? }`: verify a key and store it; returns the model list |
| `PATCH /api/providers` | `{ provider, model }`: choose a model and make that provider active |
| `DELETE /api/providers?provider=` | Remove a provider |
| `GET /api/providers/models?provider=` | Re-fetch models with the stored credential (refreshes ChatGPT tokens when needed) |
| `GET /api/chatgpt/start` · `GET /api/chatgpt/callback` | ChatGPT sign-in and consent |
| `POST /api/projects/:id/deploy` · `GET` | Publish the project to Wasmer Edge (runs in the background) · progress, build log and the published app |
| `GET /api/projects/:id/memory` · `POST` `{ kind, scope, title, body }` | List what the project remembers; add a rule by hand (human authority) |

## Repository map

| Path | Role |
|---|---|
| `src/lib/wasmer.ts`, `src/lib/wasmer-login.ts` | Wasmer GraphQL client; Sign in with Wasmer (nonce flow and loopback callback) |
| `src/lib/deploy.ts` | One-click Publish: zip the workspace, Anybuild deploy under the linked account, follow the build, remember the app |
| `src/lib/providers.ts` | Provider registry and model-list adapters |
| `src/lib/credentials.ts` | Local credential store |
| `src/lib/chatgpt.ts` | ChatGPT local OAuth flow, ID-token verification, token refresh |
| `src/lib/guard.ts` | Local-only and same-origin request guard |
| `src/app/api/` | Route handlers |
| `src/app/onboarding/` | Onboarding UI |
| `src/lib/memory.ts` | Provena-backed project and user memory |
| `scripts/setup-provena.mjs` | Installs a pinned Provena build into Adorable's toolchains |

## Testing

```powershell
pnpm check   # lint, typecheck, unit + route tests
pnpm build
```

## Project memory

Each project workspace is a [Provena](https://github.com/ayushozha/provena) brain (`.provena/`, an append-only memory ledger plus a repo map), so follow-up edits never start cold:

- The first brief is stored as the project's founding decision.
- The model records lasting decisions and preferences with `<memory>` blocks; Adorable writes them to the ledger after the run, in the background.
- Every run recalls them (rules you added first, then newest) into the prompt.
- Preferences marked *all my projects* go to a user-level brain at `~/.config/vessel/brain`.
- The Memory tab lists everything remembered and lets you add rules. Provena gets a minimal environment (no provider keys), and the project's git repo runs no hooks.

## Contributing

Keep these invariants: no secret ever reaches the client or logs; no hardcoded model IDs; ChatGPT plan usage stays local-only unless OpenAI approves a hosted client.

## License

No license file is currently checked in.
