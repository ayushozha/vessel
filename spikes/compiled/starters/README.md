# Compiled-language starters

Minimal HTTP JSON servers that run inside a local Wasmer sandbox
(`@wasmer/sdk` 0.19.1, `network: { mode: "host" }`). Each one binds 127.0.0.1 only (a guest bind is a real host listener), reads its port
from `PORT` (Java: `argv[1]`) and answers every path with
`{"lang": ..., "runtime": ..., "hits": n}`. Findings and limits are in
[`docs/compiled-languages.md`](../../../docs/compiled-languages.md).

| Starter | Build | Concurrency |
|---|---|---|
| `c/server.c` | inside the sandbox: `clang server.c -O2 -o server.wasm` (`clang/clang@=0.160000.1`) | pthread per connection |
| `cpp/server.cpp` | inside the sandbox: `clang --driver-mode=g++ -fno-exceptions server.cpp -O2 -o server.wasm`. STL-free: libc++ containers hang this clang | pthread per connection |
| `rust/` | `cargo build --release --target wasm32-wasip1-threads` | thread per connection |
| `go/` | `GOOS=wasip1 GOARCH=wasm go build -o server.wasm .` | goroutines + Go poller |
| `java/Server.java` | JDK 21 `javac` + TeaVM 0.12.0 `-t wasi` (see `java/spike.mjs`) | single-threaded |

Run any host-built module from `spikes/compiled`:

```powershell
node lib/run-wasm.mjs starters/rust/target/wasm32-wasip1-threads/release/vessel-rust-starter.wasm --serve
node lib/run-wasm.mjs go/server.wasm --serve
node lib/run-wasm.mjs java/out/server/classes.wasm --serve "{PORT}"
```

The C and C++ starters are compiled and served by `node c/spike.mjs`.

The socket glue is fixed code: `wasix.go`, the `listen`/`sock_accept_v2`
part of `main.rs`, and the `Wasix`/`Wasi` classes in `Server.java`. Generated
apps should only replace the request handler.
