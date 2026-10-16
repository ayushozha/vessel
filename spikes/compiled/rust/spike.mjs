// Rust: host cargo -> wasm32-wasip1(-threads) -> run in a Wasmer sandbox.
// Needs: rustup targets wasm32-wasip1 and wasm32-wasip1-threads.
// RUST_TOOLCHAIN picks a rustup toolchain (this machine: stable-x86_64-pc-windows-msvc,
// because Windows App Control blocks the GNU toolchain's rustc.exe).
import { rmSync, utimesSync } from "node:fs";
import { root, wasmer } from "../lib/harness.mjs";
import { build } from "../lib/build.mjs";
import { runWasm } from "../lib/run-wasm.mjs";

const tc = process.env.RUST_TOOLCHAIN ? [`+${process.env.RUST_TOOLCHAIN}`] : [];
const cargo = (dir, target) => build(`cargo build ${dir} (${target})`, "cargo", [...tc, "build", "--release", "--target", target], { cwd: root + dir });

try {
  rmSync(root + "rust/hello/target", { recursive: true, force: true });
  cargo("rust/hello", "wasm32-wasip1");
  await runWasm(root + "rust/hello/target/wasm32-wasip1/release/hello.wasm");

  const starter = "starters/rust";
  rmSync(root + `${starter}/target`, { recursive: true, force: true });
  cargo(starter, "wasm32-wasip1-threads"); // cold: fetch + compile the `wasix` crate
  utimesSync(root + `${starter}/src/main.rs`, new Date(), new Date());
  cargo(starter, "wasm32-wasip1-threads"); // warm: only the app crate
  await runWasm(root + `${starter}/target/wasm32-wasip1-threads/release/vessel-rust-starter.wasm`, { serve: true });
} finally {
  await wasmer.close();
}
