// Java: javac -> TeaVM 0.12.0 WASI target -> run in a Wasmer sandbox.
// TeaVM must run on JDK <= 21 (its ASM 9.7.1 cannot read JDK 26 class files).
// Setup (see docs/compiled-languages.md): TEAVM_LIB = dir of TeaVM jars, JAVA21_HOME = JDK 21.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { root, wasmer } from "../lib/harness.mjs";
import { build } from "../lib/build.mjs";
import { runWasm } from "../lib/run-wasm.mjs";

const lib = process.env.TEAVM_LIB ?? join(root, "toolchains/teavm/lib");
const jdk = process.env.JAVA21_HOME ?? join(root, "toolchains/jdk-21.0.12.1+1");
const bin = (tool) => join(jdk, "bin", tool);
const out = join(root, "java/out");

function teavm(name, srcDir, mainClass) {
  const classes = join(out, name, "classes");
  const javaFile = join(root, srcDir, `${mainClass}.java`);
  build(`javac ${name}`, bin("javac"), ["--release", "17", "-cp", join(lib, "teavm-interop-0.12.0.jar"), "-d", classes, javaFile]);
  build(`teavm wasi ${name}`, bin("java"), ["-cp", join(lib, "*"), "org.teavm.cli.TeaVMRunner", "-t", "wasi", "-O", "2", "-p", classes, "-d", join(out, name), mainClass]);
  return join(out, name, "classes.wasm");
}

try {
  rmSync(out, { recursive: true, force: true });
  await runWasm(teavm("hello", "java/hello/src", "Hello"));
  // TeaVM's WASI target exposes argv but not env, so the port is passed as an argument.
  await runWasm(teavm("server", "starters/java", "Server"), { serve: true, args: ["{PORT}"] });
} finally {
  await wasmer.close();
}
