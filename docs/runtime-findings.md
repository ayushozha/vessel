# Local sandbox runtime: findings

Measured 2026-10-15 on Windows 11 (Node 24.16.0, pnpm 10.30.1) with `@wasmer/sdk@0.19.1`,
`wasmer/edgejs@0.2.5` (reports `v24.13.2 wasi/wasm32`), `wasmer/pglite@0.2.0` (PostgreSQL 18.4,
wasm32-wasix) and `wasmer/static-web-server@2.44.0`. Spikes live in [`spikes/js/`](../spikes/js);
run any of them from the repo root with `node spikes/js/<name>.mjs`.

## Summary

| Stack | Result | Offer in the UI? |
| --- | --- | --- |
| Edge.js + Express JSON API (a) | **PASS** | Yes, tier 1 (`node` stack) |
| Edge.js + Express + `pg` against pglite (b) | **PASS**, but the database resets on every restart | Yes, tier 1 (`node-pglite` stack) |
| Edge.js MCP server (starter, live test) | **PASS** (CommonJS only, see below) | Yes, tier 1 (`node` stack) |
| React + Vite 8 (c) | **FAIL**: rolldown's WASI binding cannot load | No |
| React + Vite 7 + esbuild-wasm / @rollup/wasm-node (c) | **FAIL**: Edge.js realm bugs break esbuild-wasm, even after patching | No |
| Next.js 16 `next build` / `next dev` (d) | **FAIL**: Turbopack needs native; webpack build hangs; dev never serves a page | No |
| Deps: host-installed vs in-guest install (e) | **PASS** both; host copy is ~3–5x faster | Host cache for certified starters, guest install otherwise |

**Tier 1 the UI may offer today:** Node.js API/app (Express) on Edge.js, Node.js + PostgreSQL
(Express + `pg` + pglite), and MCP servers on Edge.js. React + Vite (the requested tier 1) and
Next.js do **not** run in the local sandbox yet; they should go to Wasmer Edge (Anybuild) or wait for
upstream fixes.

> [!CAUTION]
> **Edge.js under the Node SDK is not a security boundary.** Read [Security](#security-edgejs-is-not-isolated)
> before relying on the "generated code never runs on the host" rule.

## Security: Edge.js is not isolated

In `@wasmer/sdk` 0.19.1 on Node, Edge.js does not interpret JavaScript inside WebAssembly. Guest JS is
`eval`'d by the **host's V8**, inside an SDK worker thread, behind a `Proxy` global
(`wasmer_napi_compile_function` in the SDK's `wasmer-napi` snippet). Code compiled with `new Function`
or indirect eval resolves globals against the real worker global instead:

```js
// inside `edge -e` in a sandbox
const p = new Function("return process")();
p.pid;                                   // the host Node pid
p.platform;                              // "win32"
p.env.USERPROFILE;                       // host environment
p.getBuiltinModule("fs").existsSync(…);  // true for host files
```

Observed: host pid, `win32`, host env, and host filesystem access via `process.getBuiltinModule("fs")`.
That is a full escape: arbitrary host file access and process execution as the Vessel user. Dynamic
`import()` from eval'd code also resolves through the host loader (`Cannot find module
'C:\workspace\server.js' imported from …/@wasmer/sdk/pkg/snippets/…/inline0.js`). Non-JS packages
(pglite, static-web-server, python) are real WASIX modules and are not affected.

What `src/lib/sandbox.ts` does about it (defense in depth, **not** a fix):

- Each project's SDK client runs in its own forked Node process (`src/lib/sandbox-host.mjs`) with a
  scrubbed environment (`SystemRoot`, `windir`, `TEMP`, `TMP`, `PATH` only). Escaped guest code
  cannot read Vessel's in-memory secrets or provider keys from the server's env.
- It still runs as the user, so it **can** read `~/.config/vessel/credentials.json` and anything else
  the user can. Running the host as a separate low-privilege OS user, or in a container or VM, would
  close that.
- Real fixes: Wasmer making the Edge.js `Function`/eval path use the guest global, or running
  Edge.js on the native Wasmer runtime instead of the JS SDK. The `wasmer` CLI is not installed on this
  machine, so that is untested.

## Runtime facts that shaped the design

| Fact | Evidence | Consequence |
| --- | --- | --- |
| The SDK needs WebAssembly JSPI; Node 24 (V8 13.6) has it behind a flag | `panicked … the JavaScript host does not support WebAssembly JSPI` | Host is forked with `execArgv: ["--experimental-wasm-jspi"]` |
| Node rejects that flag in `NODE_OPTIONS` | `--experimental-wasm-jspi is not allowed in NODE_OPTIONS` | Spikes call `v8.setFlagsFromString` before the SDK starts workers (works) |
| No host mounts in `SandboxOptions` on Node | `dist/index.js#createSandbox` only takes `packages`, `files`, `env`, `network` | Workspace and deps are **copied** in via `files`/`sandbox.fs`, never mounted; guests cannot reach host paths through WASIX |
| `sandbox.fs` only accepts paths under `/workspace` | `invalid guest path '/': sandbox filesystem paths must be inside '/workspace'` | All Vessel paths are `/workspace/<relative>` |
| Guest TCP listeners bind the **same host address and port** | `node-network.js#listenTcp` calls `net.createServer().listen({host, port})` | Vessel picks a free port and sets `HOST=127.0.0.1`; a guest that binds `0.0.0.0` is reachable from the LAN |
| pglite always listens on 5432, ignoring `PGPORT`, `-p`, `-c` | `FATAL: pglite: invalid command-line argument: -p` | One PostgreSQL project at a time per machine (pool enforces it) |
| pglite serves one connection, then exits when it closes | spike (b): `pglite after client disconnect: exited 0/exited` | Apps must use one long-lived `pg.Client`, not a `Pool`; restart respawns the DB first |
| pglite data is per process | spike (b): 2 rows before respawn, 0 after, in the same sandbox | Restart = fresh database; `resetData()` = restart; starters create schema idempotently |
| An uncaught guest-side error can kill the **whole** Wasmer client | `WORKER_FAILED … Scheduler is dead` after rolldown/esbuild/Next errors | One client per project, in its own process; the pool marks the project `crashed` |
| `process.exit` from escaped code exits the SDK worker | `Wasmer SDK worker exited unexpectedly with status 1` | Same isolation as above |
| `os.homedir()` throws without `HOME` | `uv_os_homedir returned ENOENT` | Vessel sets `HOME=/workspace` |
| `fs.watch` is `ENOSYS` | `Watchpack Error (watcher): Error: ENOSYS … watch '/workspace'` | Dev servers need polling (`WATCHPACK_POLLING=true`, `CHOKIDAR_USEPOLLING`) |
| `spawnSync` of the runtime produced no output; async `spawn` works | spike probe | Prefer async child processes in generated code |

## Per-stack results

Timings are wall-clock from the spike output (package cache warm; "cold" = first run after a fresh
cache). Sandbox creation with Edge.js is ~1.4s every time; an Edge.js process starts in ~0.7s cold /
~0.46s warm.

### (a) Edge.js + Express: PASS

`node spikes/js/a-express.mjs` (in-guest install) and `DEPS=host node spikes/js/a-express.mjs`.

| Step | Guest install | Host-installed deps copied in |
| --- | --- | --- |
| Sandbox create | 1.46s | 1.43s |
| `pnpm install --ignore-scripts` in guest | 9.3–9.5s | n/a (604 files / 2.2 MiB copied) |
| Server ready (`listening on`) | 0.46–0.50s | 0.69s |
| `GET /api/health` first / warm | 19ms / 7ms | 25ms / 9ms |
| **Total** | **11.3s** | **4.1s** |

### (b) Edge.js + Express + `pg` + pglite: PASS (with resets)

`node spikes/js/b-express-pglite.mjs`. Two sandboxes in one client, both `network: host`.

| Step | Time |
| --- | --- |
| pglite ready (`OLIPHAUNT_WASIX_SOCKET_READY 5432`) | 265–281ms |
| App ready (connect + `CREATE TABLE`) | 729–737ms |
| `SELECT version()` | 39ms: `PostgreSQL 18.4 on wasm32-unknown-wasix, compiled by wasixcc 0.4.4, 32-bit` |
| INSERT / SELECT | 15–41ms |
| Restart app + pglite in the same sandboxes | 1.6s; **0 rows afterwards** (per-process PGDATA) |
| Total including restart | 3.8s |

### MCP server on Edge.js: PASS (CommonJS)

`starters/node-mcp` (`@modelcontextprotocol/sdk@1.31.0`, Streamable HTTP, stateless). `initialize`,
`tools/list` and `tools/call` work in the live test. As ESM it crashes at import:
`TypeError: Cannot read properties of undefined (reading 'arrayToEnum')`, because the ESM build of
`zod/v3`, which the MCP SDK imports, fails under Edge.js. `import "zod"`, `import "zod/v4"` and
`require("zod/v3")` all work. The starter therefore uses `require`.

### (c) React + Vite: FAIL

`VITE=8 node spikes/js/c-react-vite.mjs` / `VITE=7 node spikes/js/c-react-vite.mjs`.

- **Vite 8.3.2** (rolldown + lightningcss). Guest install 8.2s. Rolldown detects a WebContainer and
  downloads `@rolldown/binding-wasm32-wasi@1.2.14` by itself, then fails:
  `Cannot destructure property 'WASI' of 'internalBinding(...)' as it is undefined`. Edge.js exposes
  `node:wasi` but not its internal binding. The error also killed the Wasmer client
  (`Scheduler is dead`).
- **Vite 7.3.6** with pnpm overrides `rollup → @rollup/wasm-node@4.63.6` and
  `esbuild → esbuild-wasm@0.28.2`. Guest install 13.8–34.6s. esbuild-wasm fails in three layers, all
  from the realm split described under Security:
  1. `usage: go_js_wasm_exec [wasm binary] [arguments]`: code built by `new Function` sees a
     different `process.argv` (length 2) than the module (length 5).
  2. Patch 1 (pass `process` in) leads to `ReferenceError: Go is not defined`: `globalThis.Go` set by
     `wasm_exec.js` is invisible in the `new Function` global.
  3. Patch 2 ([`patches/esbuild-wasm@0.28.2.patch`](../spikes/js/fixtures/react-vite7/patches/esbuild-wasm@0.28.2.patch),
     compile the Go loader as a real CommonJS module) leads to `TypeError: The "list" argument must be an
     instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView`, raised from inside the Go wasm's
     `fs` calls (even `esbuild --version`). The bytes come from the host realm and fail Edge.js's
     `Buffer` checks. This is not patchable from userland.
- Not reached: `vite dev`, and serving `dist/` with static-web-server.
- Untested options: Vite 8 with `@rolldown/browser` (bundles its own WASI shim) plus `lightningcss-wasm`;
  a Babel-only transform pipeline without esbuild.

### (d) Next.js 16.3.8: FAIL

`node spikes/js/d-next.mjs` (`SKIP_BUILD=1` for dev only). Guest install 28–32s; native SWC is
absent, and Next loads `@next/swc-wasm-nodejs` automatically.

- Default (Turbopack): `Turbopack is not supported on this platform (wasi/wasm32) because native
  bindings are not available … use Webpack instead`.
- `next build --webpack`: no output, then a hang. The host process sat at 0% CPU with 2.5 GB RSS
  after ~2 min of work, and the SDK `timeoutMs` (600s) never fired, so I killed it after ~10 min.
- `next dev --webpack`: `Ready in 1014ms`, then `Watchpack Error (watcher): Error: ENOSYS` and
  `The directory at "/workspace/.next/dev" was deleted … Restarting the server`. With
  `WATCHPACK_POLLING=true` the watcher errors go away, but the first `GET /` gets no response within
  5 minutes (`fetch failed`).

### (e) Dependency speed: PASS

`node spikes/js/e-deps.mjs`, Express + pg, measured until the server can import both:

| Mode | Run 1 | Run 2 |
| --- | --- | --- |
| Host `npm install --ignore-scripts`, copy `node_modules` in (742 files / 2.6 MiB) | 3.75s | 1.99s |
| `pnpm install --ignore-scripts` inside the guest (in-memory fs, nothing cached) | 10.70s | 10.89s |

"Mounted read-only" is not possible with this SDK (no mounts), so host deps are copied. The pool
uses the host path only for exact dependency sets prepared by Vessel
(`node scripts/warm-deps.mjs`: certified starters, npm with scripts disabled, so no package code runs on
the host). Anything else installs inside the guest.

## The runtime (`src/lib/sandbox.ts`)

```text
Next server (sandbox.ts)                      forked host per project (sandbox-host.mjs)
  SandboxPool.start(id, stack)  --IPC-->        new Wasmer({ cache: ~/.config/vessel/.wasmer })
    planSandbox: packages/env/args               app sandbox: wasmer/edgejs@0.2.5, files = workspace (+deps)
    readTree(workspace) + deps cache             db sandbox:  wasmer/pglite@0.2.0   (node-pglite only)
  ProjectSandbox: state, logs, appUrl  <--IPC--  log lines, exits, op replies
```

- `start(projectId, stack)` → `ProjectSandbox` with `appUrl`, `port`, `state`
  (`starting|running|restarting|crashed|stopped`), `logs` (last 1000), `onLog(listener)`.
- `syncFiles({ "rel/path": contents | null })` writes changed files into the guest (`null` deletes).
  Paths are validated (no absolute, drive, `..`, empty or `.` segments, NUL or backslash). Server code
  changes need `restart()`.
- `restart()` maps to PR #3's `onRestart`. `resetData()` maps to `onResetData` (`node-pglite` only;
  same effect as restart today). `appUrl` maps to `appUrl`.
- Only Vessel picks packages (exact pins), commands, env (`PORT`, `HOST=127.0.0.1`, `HOME`, `NODE_ENV`,
  `DATABASE_URL`), and which host files are read: the project workspace
  `~/.config/vessel/projects/<id>/workspace` and the deps cache `~/.config/vessel/deps/<key>`, both
  checked with `realpath` containment and size limits, regular files only.
- Unit tests: `src/lib/sandbox.test.ts` (SDK and host mocked). Live test:
  `$env:VESSEL_LIVE_SANDBOX = "1"; pnpm vitest run src/lib/sandbox.live.test.ts` boots both starters
  (about 25s).

## Certified starters

| Starter | Stack | Verified by |
| --- | --- | --- |
| [`starters/node-pglite`](../starters/node-pglite) | `node-pglite` | Live test: health, CRUD, validation, `syncFiles`, restart, reset (guest install path) |
| [`starters/node-mcp`](../starters/node-mcp) | `node` | Live test: MCP initialize, tools/list, tools/call (deps-cache path) |

There is no React + Vite starter because the stack fails (see above).
