// Headless-Chrome smoke test for the Code tab file system, driven over the Chrome DevTools Protocol.
// Starts `next dev` on a free 127.0.0.1 port against a throwaway VESSEL_HOME, imports a real zip through the
// "Import .zip" input, drops a file onto a folder row, edits and saves a file with Ctrl+S, and screenshots each step.
//
//   node scripts/smoke-file-system.mjs [outDir]      (CHROME=<path to chrome> to override the browser)
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { zipSync } from "fflate";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "vessel-smoke"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-smoke-home-"));
await fs.mkdir(out, { recursive: true });

const freePort = () =>
  new Promise((ok) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });

// A connected (fake) model and a project with chat history, so the builder opens without auto-running the brief.
const id = randomUUID();
const now = new Date().toISOString();
await fs.mkdir(path.join(home, "projects", id), { recursive: true });
await fs.writeFile(path.join(home, "credentials.json"), JSON.stringify({ version: 1, hostId: randomUUID(), active: "openai", keys: { openai: { apiKey: "sk-smoke-00000000", model: "smoke-model", verified: true, savedAt: now } } }));
await fs.writeFile(path.join(home, "projects", `${id}.json`), JSON.stringify({ id, kind: "app", brief: "Smoke test project", name: "Smoke test", createdAt: now }));
await fs.writeFile(path.join(home, "projects", id, "chat.json"), JSON.stringify([{ role: "user", text: "Smoke test project", at: now }]));

const enc = (s) => new TextEncoder().encode(s);
const zipPath = path.join(out, "demo-app.zip");
await fs.writeFile(
  zipPath,
  zipSync({
    "demo-app/": {},
    "demo-app/server.js": enc('const http = require("node:http");\nhttp.createServer((req, res) => res.end("hi")).listen(process.env.PORT);\n'),
    "demo-app/package.json": enc('{ "name": "demo-app", "private": true }\n'),
    "demo-app/public/index.html": enc("<!doctype html>\n<h1>Demo</h1>\n"),
    "demo-app/public/logo.svg": enc('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff3d6e"/><stop offset="1" stop-color="#6d4aff"/></linearGradient></defs><rect width="120" height="40" rx="8" fill="url(#g)"/></svg>'),
    "demo-app/src/lib/util.js": enc("export const add = (a, b) => a + b;\n"),
    "demo-app/assets/": {},
    "demo-app/__MACOSX/._server.js": enc("junk"),
    "demo-app/.DS_Store": enc("junk"),
    "demo-app/../evil.js": enc("zip-slip"),
  }),
);
const dropPath = path.join(out, "notes.txt");
await fs.writeFile(dropPath, "dropped from the desktop\n");

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(`pnpm exec next dev -H 127.0.0.1 -p ${port}`, { shell: true, env: { ...process.env, VESSEL_HOME: home, VESSEL_CREDENTIALS_PATH: path.join(home, "credentials.json") }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-smoke-chrome-"));
let chrome;

const kill = (child) => {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch {}
};

async function waitFor(check, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

try {
  await waitFor(() => fetch(`${base}/api/projects/${id}/files`).then((r) => r.ok), "the dev server", 180_000);

  chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
  const devtools = await waitFor(async () => (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0], "Chrome");
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()).find((t) => t.type === "page"), "a page target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const msgId = ++seq;
      pending.set(msgId, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(out, name), Buffer.from(data, "base64"));
    console.log(`screenshot ${path.join(out, name)}`);
  };
  globalThis.failShot = async () => {
    await shot("failure.png");
    console.error(await evaluate(`document.querySelector("[class*=source]")?.innerText`));
  };
  const setFiles = async (selector, files) => {
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
    await send("DOM.setFileInputFiles", { nodeId, files });
  };
  const centerOf = (js) => evaluate(`(() => { const r = (${js}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const treeText = () => evaluate(`document.querySelector('[aria-label="Project files"]')?.innerText ?? ""`);
  const fileApi = (q) => evaluate(`fetch("/api/projects/${id}/files${q}").then((r) => r.json())`);

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${base}/build/${id}` });
  await waitFor(() => evaluate(`!![...document.querySelectorAll('[role=tablist] button')].find((b) => b.textContent.startsWith("Code"))`), "the builder");
  // Keep clicking until hydration has attached the handler.
  await waitFor(() => evaluate(`[...document.querySelectorAll('[role=tablist] button')].find((b) => b.textContent.startsWith("Code")).click(), !!document.querySelector('input[accept*="zip"]')`), "the Code tab");

  // 1. Import a real zip: the dry run opens a preview listing files, skipped junk and the zip-slip entry.
  await setFiles('input[accept*="zip"]', [zipPath]);
  const preview = await waitFor(() => evaluate(`document.querySelector("dialog[open]")?.innerText`), "the zip preview");
  console.log("zip preview:", preview.replace(/\s+/g, " "));
  if (!/5 files/.test(preview) || !/escapes the workspace/.test(preview) || !/ignored/.test(preview)) throw new Error("zip preview is missing files or skipped entries");
  await shot("1-zip-preview.png");
  await evaluate(`[...document.querySelectorAll("dialog[open] button")].at(-1).click()`);
  await waitFor(async () => /util\.js/.test(await treeText()), "the imported tree");

  // 2. Drop a desktop file onto the "public" folder row.
  const publicRow = await centerOf(`[...document.querySelectorAll('[aria-label="Project files"] button')].find((b) => b.textContent.trim().startsWith("▾public"))`);
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await send("Input.dispatchDragEvent", { type, ...publicRow, data: { items: [], files: [dropPath], dragOperationsMask: 1 } });
  }
  await waitFor(async () => (await fileApi("")).files.some((f) => f.path === "public/notes.txt"), "the dropped file in public/", 15_000);

  // 3. Edit server.js in place and save with Ctrl+S.
  await evaluate(`[...document.querySelectorAll('[aria-label="Project files"] button')].find((b) => b.textContent.trim() === "server.js").click()`);
  await waitFor(() => evaluate(`document.querySelector('textarea[aria-label^=Edit]')?.value.includes("createServer")`), "the editor");
  await evaluate(`(() => { const t = document.querySelector('textarea[aria-label^=Edit]'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
  await send("Input.insertText", { text: "// edited in Adorable\n" });
  await shot("2-unsaved-edit.png");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 2 });
  await waitFor(async () => (await fileApi("?path=server.js")).content?.includes("// edited in Adorable"), "the saved edit", 10_000);

  // 4. The SVG previews as an image; the final tree is the evidence screenshot.
  await evaluate(`[...document.querySelectorAll('[aria-label="Project files"] button')].find((b) => b.textContent.trim() === "logo.svg").click()`);
  await waitFor(() => evaluate(`document.querySelector('img[alt="public/logo.svg"]')?.complete && document.querySelector('img[alt="public/logo.svg"]').naturalWidth > 0`), "the image preview");
  await shot("3-tree.png");

  const listing = (await fileApi("")).files.map((f) => `${f.type === "dir" ? "d" : "f"} ${f.path}`);
  console.log(listing.join("\n"));
  if (listing.some((l) => /evil|__MACOSX|DS_Store/.test(l))) throw new Error("junk or zip-slip entry was written");
  if (!existsSync(path.join(home, "projects", id, "workspace", "assets"))) throw new Error("empty folder from the zip was not created");
  if (existsSync(path.join(home, "projects", id, "evil.js")) || existsSync(path.join(home, "projects", "evil.js"))) throw new Error("zip-slip escaped the workspace");
  console.log("SMOKE OK");
  ws.close();
} catch (e) {
  console.error("SMOKE FAILED:", e.message);
  await globalThis.failShot?.().catch(() => {});
  console.error(serverLog.split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  kill(chrome);
  kill(server);
  await sleep(500);
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
