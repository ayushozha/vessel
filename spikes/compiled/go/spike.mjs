// Go: host `GOOS=wasip1 GOARCH=wasm go build` -> run in a Wasmer sandbox.
// Stock Go; the HTTP starter reaches Wasmer's WASIX sockets via go:wasmimport.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, wasmer } from "../lib/harness.mjs";
import { build } from "../lib/build.mjs";
import { runWasm } from "../lib/run-wasm.mjs";

const wasip1 = { GOOS: "wasip1", GOARCH: "wasm" };
const coldCache = mkdtempSync(join(tmpdir(), "vessel-gocache-")); // cold build without wiping the user's cache
const out = (name) => join(root, "go", `${name}.wasm`);

try {
  build("go build hello", "go", ["build", "-o", out("hello"), "."], { cwd: root + "go/hello", env: wasip1 });
  await runWasm(out("hello"));

  const cwd = root + "starters/go";
  build("go build starter (cold GOCACHE)", "go", ["build", "-o", out("server"), "."], { cwd, env: { ...wasip1, GOCACHE: coldCache } });
  build("go build starter (warm)", "go", ["build", "-o", out("server"), "."], { cwd, env: { ...wasip1, GOCACHE: coldCache } });
  await runWasm(out("server"), { serve: true });
} finally {
  rmSync(coldCache, { recursive: true, force: true });
  await wasmer.close();
}
