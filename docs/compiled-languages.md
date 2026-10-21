# Compiled backend languages in local Wasmer sandboxes

Findings from `spikes/compiled/`: which compiled backend languages Adorable can
honestly run inside a local Wasmer sandbox and serve over HTTP on this Windows
machine, and which ones the UI should offer.

Every **PASS** below was built and run, served JSON over HTTP from inside a
sandbox on a random `127.0.0.1` port, and was fetched from the host. Each one
has a starter in `spikes/compiled/starters/<lang>/`. Nothing was published to
Wasmer Edge in this spike.

## Verdict

| Language | Route | Status | HTTP from sandbox | 20 parallel requests + 1 idle client | Toolchain needed | Recommendation |
|---|---|---|---|---|---|---|
| **C** | Compiled **inside the sandbox** (`clang/clang`), run in the same sandbox | **PASS** | yes (POSIX sockets + pthreads) | 20/20 | none on the host (registry package, ~106 MB) | **Tier 1** (the most Wasmer-native demo) |
| **Rust** | Host `cargo` → `wasm32-wasip1(-threads)` → sandbox; sockets via the `wasix` crate | **PASS** | yes (thread per connection) | 20/20 | rustup + 2 targets | **Tier 1** |
| **Go** | Host stock `GOOS=wasip1 go build` → sandbox; WASIX sockets via `go:wasmimport` | **PASS** | yes (standard `net/http`) | 20/20 | Go ≥ 1.24 | **Tier 1** |
| **C++** | Compiled inside the sandbox (`clang --driver-mode=g++`) | **PARTIAL** | yes (pthreads) | 20/20 | none on the host | **Tier 2**: offer, but limited to an STL-free subset |
| **Java** | Host `javac` → TeaVM 0.12.0 **WASI** target → sandbox; WASIX sockets via `@Import` | **PASS** (single-threaded) | yes | 0/20 (blocked by the idle client) | JDK 21 + TeaVM jars (Maven) | **Experimental** |
| Java (alt) | TeaVM **C** target → clang inside the sandbox | **FAIL** | n/a | n/a | n/a | not offered |
| Rust (alt) | `cargo-wasix` toolchain (std `TcpListener`, Axum, Tokio) | **FAIL on this machine** | n/a | n/a | n/a | revisit on Linux/macOS or CI |

"Idle client" means the probe in `lib/concurrency.mjs` holds one TCP connection
open without sending anything, then fires 20 parallel `fetch`es with a 5 s
timeout each. A blocking single-threaded server stalls on that connection, so
0/20 marks a server that a slow client can freeze.

## Timings (this machine)

Windows 11 Pro 26300, Node 24.16.0, `@wasmer/sdk` 0.19.1. Measured with the
spike scripts; ranges cover several runs. The high ends come from one run made
while other sessions were loading the machine.

| Language | Cold build | Warm build | Run hello | Spawn → first HTTP response | Warm request |
|---|---|---|---|---|---|
| C (in sandbox) | first sandbox with an empty package cache **5.2 s** (downloads clang), first compile 0.7–0.85 s | 0.5–1.0 s per file | 4–10 ms | 150–590 ms | 4–46 ms |
| C++ (in sandbox) | same clang package | 0.4–1.0 s per file | 55–150 ms | 150–620 ms | 4–27 ms |
| Rust | 1.1 s after `target/` wipe (the `wasix` crate is already in the cargo registry) | 0.4 s | 78 ms | 140–380 ms | 3–5 ms |
| Go | 5.0 s with an empty `GOCACHE` | 0.33 s | 90–98 ms | 134–188 ms | 3–4 ms |
| Java | `javac` 0.4 s + TeaVM 1.8–2.5 s (no incremental cache) | same | 71–75 ms | 123–195 ms | 3 ms |

Module load (`wasmer.packages.load(bytes)`) takes 30–210 ms; Go modules are the
largest (2.6 MB hello). Sandbox creation with an already-loaded package takes
under 3 ms.

## How each route works

All routes end the same way: a WASI/WASIX module that exports `_start`, loaded
with `wasmer.packages.load(bytes)` (or built in the sandbox and passed to
`sandbox.installPackage(bytes)`), then started with
`sandbox.command(pkg, args, { env: { PORT } }).spawn()` in a sandbox created with
`network: { mode: "host" }`. The guest's `bind()` becomes a real listener on
the host with the **same address**: a guest bind on `0.0.0.0` showed up in
`netstat` as `0.0.0.0:PORT LISTENING`, which is reachable from the LAN. Every
starter therefore binds `127.0.0.1` (confirmed as `127.0.0.1:PORT LISTENING`),
and Adorable must enforce loopback for generated code, not just suggest it.

### C: PASS, compiled inside the sandbox

- Package `clang/clang@=0.160000.1` (clang 16.0.0, target `wasm32-unknown-wasi`,
  a WASIX libc sysroot at `/sysroot` with sockets, pthreads and `epoll.h`).
  Commands: `clang`, `clang-16`, `lld`, `wasm-ld`, `llvm-ar`, `llvm-nm`.
  `syrusakbary/clang@0.1.1` ships the same commands and hangs on `<string>` the same way.
- `clang /workspace/server.c -O2 -o /workspace/server.wasm`, then
  `sandbox.fs.readFile` → `sandbox.installPackage` → spawn. No host toolchain.
- The starter uses `socket/bind/listen/accept` and one detached pthread per
  connection. A blocking single-threaded version scored 0/20 on the idle-client
  probe. The pthread version scores 20/20.

### C++: PARTIAL, a subset compiles inside the sandbox

Classes, RAII, templates, lambdas, `<cstdio>`, `<cstdlib>`, `<cstring>`,
`<utility>`, `<new>`, `<limits>`, `<exception>`, `<stdexcept>`, `<iterator>`,
`<type_traits>` and `<initializer_list>` all compile (`--driver-mode=g++
-fno-exceptions`) and the HTTP starter serves 20/20. Two blocking bugs in
`clang/clang` 16:

1. **Any libc++ header that pulls in `<atomic>` hangs the compiler**: `<atomic>`,
   `<string>`, `<vector>`, `<memory>`, `<array>`, `<string_view>`, `<algorithm>`.
   Observed: no output and no exit after 8 minutes (`node c/spike.mjs --stl-repro`).
   `-D_LIBCPP_HAS_NO_THREADS` fails with errors in `<__assert>` instead.
   `-mno-atomics` fails with `invalid argument '-pthread' not allowed with '-mno-atomics'`.
2. **The frontend crashes on modest nesting**: 16 nested parentheses or a
   designated initializer nested 4 levels deep gives
   `clang-16: error: clang frontend command failed with exit code 11`
   (8 levels / 3 levels compile). Repro: `node c/spike.mjs --depth-repro`.
   Raising the SDK worker's `resourceLimits.stackSizeMb` from 4 to 64 changed
   nothing, so the limit is inside the clang build, not the Node worker.

Also seen: `-c`, `-E` and `-fsyntax-only` fail with
`error: unknown integrated tool '-cc1'. Valid tools include '-cc1' and '-cc1as'.`
Only full compile-and-link invocations work. Generated C++ must therefore stay
small, STL-free and shallow, which is a poor fit for LLM-written C++.

### Rust: PASS, host compile

- `rustup target add wasm32-wasip1 wasm32-wasip1-threads` (rustc 1.95.0, MSVC host).
- Rust's `wasm32-wasip1` std cannot bind sockets. Exact runtime error:
  `std TcpListener::bind failed: Error { kind: Unsupported, message: "operation not supported on this platform" }`.
- The starter calls Wasmer's WASIX syscalls through the official
  [`wasix`](https://crates.io/crates/wasix) crate (`=0.13.2`, Apache-2.0/MIT,
  wasix-org, ~4.5M downloads): `sock_open`, `sock_bind`, `sock_listen`,
  `sock_accept_v2`. It then wraps each connection fd as a `std::fs::File` and
  serves it on a `std::thread` (`wasm32-wasip1-threads`). The port in
  `__wasi_addr_port_t` is in host byte order.
- `cargo-wasix` 0.1.34 (real `std::net` on `wasm32-wasmer-wasi`, needed for
  Axum and Tokio) **could not be built here**: Windows App Control blocked its
  build scripts: `could not execute process ...\build-script-main (never executed) ... An Application Control policy has blocked this file. (os error 4551)`
  (`aws-lc-sys` with `%TEMP%` as the target dir, `icu_normalizer_data` with a
  target dir inside the repo). The same policy blocks the GNU toolchain's
  `rustc.exe`, so the spike uses `stable-x86_64-pc-windows-msvc`
  (`RUST_TOOLCHAIN` env). A prebuilt Windows toolchain
  (`wasix-org/rust` `v2026-09-18.1+rust-1.97`) exists but was not tried, for
  the same reason.

### Go: PASS, stock Go on host

- `GOOS=wasip1 GOARCH=wasm go build` with Go 1.26.3. No TinyGo and no fork.
- Stock wasip1 Go cannot open server sockets. Go's `net.FileListener` would
  accept a pre-opened socket, but Wasmer reports a WASIX socket's
  `fd_fdstat_get` filetype as `0` (unknown) instead of `SOCKET_STREAM`, so Go
  rejects it with `listen: file file+net wasix-listener: Socket operation on non-socket`.
- The starter's `wasix.go` (~100 lines) imports `wasix_32v1.sock_open/bind/listen/accept_v2`
  with `//go:wasmimport` and wraps the fds in a small `net.Listener` /
  `net.Conn`. The fds are non-blocking and `Accept` uses `SyscallConn().Read`,
  so Go's own poller (`poll_oneoff`) waits for readiness. Result: plain
  `http.HandleFunc` / `http.Serve` and real goroutine concurrency (20/20).
- TinyGo was not tried; stock Go already works.

### Java: PASS (experimental), TeaVM WASI target

- No JVM runs in the sandbox. TeaVM compiles Java bytecode ahead of time.
  TeaVM 0.12.0 (May 2025) still has a `webassembly-wasi` target (`-t wasi`),
  which current TeaVM sources no longer list, so this route has no upstream
  future.
- TeaVM must **run on JDK ≤ 21**. On JDK 26 the WASI target fails with
  `java.lang.IllegalArgumentException: Unsupported class file major version 70`
  (its ASM 9.7.1 reads the host JDK's classes). The spike uses Temurin
  21.0.12.1 from `toolchains/`.
- TeaVM's class library has no `java.net.ServerSocket` and no `System.exit`
  (`ERROR: Method java.lang.System.exit(I)V was not found`), and the WASI target
  exposes argv but not env. The starter imports WASIX/WASI syscalls with
  `@Import(module = "wasix_32v1", ...)` and reads the port from `args[0]`.
- It is single-threaded and blocks on an idle client (0/20). Use it for demos,
  not for anything that sees real traffic.
- **TeaVM C target → in-sandbox clang: FAIL.** TeaVM's generated C crashes
  clang/clang 16 (exit 11) on the nesting limits described under C++. Patching
  `TEAVM_ALIGN` and flattening vtable initializers cut the crashing files from
  about 80 to 20 of 333, but ordinary generated function bodies still crash.
  It also needed POSIX realtime signals (`SIGRTMIN`, `timer_create`) that
  WASI libc lacks.
- Not tested: GraalVM Web Image and CheerpJ (both documented as targeting JS
  hosts) and Kotlin/Wasm `wasmWasi` (Kotlin rather than Java, and it emits
  WasmGC, which this spike did not try on Wasmer).

## SDK behaviour worth knowing (`@wasmer/sdk` 0.19.1, Node)

- `SandboxOptions` has no `mounts`: files go in via `files` or `sandbox.fs`
  and come out via `sandbox.fs.readFile`. This matches the JS-runtime session's
  findings.
- `RunOptions.timeoutMs` / `SpawnOptions.timeoutMs` did **not** stop the
  hanging `<atomic>` compile. The spike races its own timer and calls
  `proc.kill()`, which works.
- A module built inside the sandbox must be installed with
  `sandbox.installPackage(bytes)`. Passing a `packages.load()` result that
  isn't installed fails with `PACKAGE_NOT_INSTALLED`.
- Guest listeners keep their bind address on the host, so `0.0.0.0` means
  every host interface (see above).
- `network: { mode: "host" }` is required to bind. With `"disabled"`,
  `sock_bind` returns errno 58 (`ENOTSUP`).
- The in-sandbox `wasmer/bash` has coreutils but no `grep`.
- These compiled guests are plain WASIX modules: their only imports are
  `wasi_snapshot_preview1` / `wasix_32v1` syscalls. Unlike Edge.js guests (see
  `docs/runtime-findings.md` in PR #5), they have no path to host JS.

## What Adorable should offer

1. **C** as the headline: the code is compiled *and* run inside Wasmer with
   no host toolchain. Keep generated code shallow (see the C++ limits).
2. **Rust** and **Go** as tier 1 backends, with the host toolchain as a
   prerequisite that the UI detects (`rustup target list --installed`,
   `go version`). Use the starters' socket shims as the fixed template and let
   the model write only the handler.
3. **C++** behind a "subset" label, with a prompt rule: no STL containers or
   strings, and no deep nesting.
4. **Java** behind an "experimental" flag: needs JDK 21 + TeaVM 0.12.0, is
   single-threaded, and the TeaVM WASI target is gone upstream.
5. Publishing to Wasmer Edge was not tested for any of these. The modules
   import `wasix_32v1`, which is Wasmer-specific, so Edge is the natural
   target, but verify it before showing a "Publish" button for compiled
   languages.

## Reproduce

```powershell
cd spikes/compiled
npm ci
node c/spike.mjs                    # C + C++, compiled inside the sandbox
node c/spike.mjs --stl-repro        # libc++ <atomic> hang (killed after 60 s)
node c/spike.mjs --depth-repro      # clang exit 11 on nesting
$env:RUST_TOOLCHAIN = "stable-x86_64-pc-windows-msvc"; node rust/spike.mjs
node go/spike.mjs
node java/spike.mjs                 # needs the Java setup below
```

Set `SPIKE_WASMER_CACHE` to an empty directory to measure cold package downloads.

### Toolchains installed for this spike (official sources, all versions older than two weeks)

| What | Version | Source | Where |
|---|---|---|---|
| `@wasmer/sdk` | 0.19.1 (pinned by the task; published 2026-10-07) | npm | `spikes/compiled/node_modules` |
| Rust targets | `wasm32-wasip1`, `wasm32-wasip1-threads` for rustc 1.95.0 MSVC | `rustup target add` | `~/.rustup` |
| `wasix` crate | 0.13.2 | crates.io | cargo registry |
| Apache Maven | 3.9.11 (2025-07-12), SHA-512 verified | archive.apache.org | `spikes/compiled/toolchains/` (gitignored) |
| TeaVM CLI + deps | 0.12.0 (2025-05-04), SHA-1 verified, 64 jars / 36 MB | Maven Central | `toolchains/teavm/lib` |
| Temurin JDK | 21.0.12.1+1 (2026-08-19), SHA-256 verified | Adoptium GitHub releases | `toolchains/jdk-21.0.12.1+1` |
| `cargo-wasix` | 0.1.34 attempted, **not installed** (App Control) | crates.io | — |

Java setup:

```powershell
cd spikes/compiled
# Maven 3.9.11 from archive.apache.org (verify the .sha512), unzipped into toolchains/
toolchains/apache-maven-3.9.11/bin/mvn -q -B -f java/teavm-deps.pom.xml "-Dmaven.repo.local=toolchains/m2" dependency:copy-dependencies "-DoutputDirectory=../toolchains/teavm/lib"
# Temurin 21 zip from Adoptium (verify the SHA-256), unzipped into toolchains/
```
