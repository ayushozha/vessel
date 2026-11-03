import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { updateStore } from "./credentials";
import { appNameFor, deployStatus, readDeployment, startDeploy, zipWorkspace } from "./deploy";
import { createProject } from "./projects";
import { stackFor } from "./runtime";
import { autobuildConfig, buildStatus, deployViaAutobuild, signedUploadUrl, uploadZip, watchBuild, type DeployedVersion } from "./wasmer";
import { writeFiles } from "./workspace";

vi.mock("./wasmer", async (original) => ({
  ...(await original<typeof import("./wasmer")>()),
  signedUploadUrl: vi.fn(),
  uploadZip: vi.fn(),
  autobuildConfig: vi.fn(),
  deployViaAutobuild: vi.fn(),
  buildStatus: vi.fn(),
  watchBuild: vi.fn(),
}));
vi.mock("./runtime", () => ({ stackFor: vi.fn() }));

const UPLOAD = "https://uploads.example/adorable.zip?sig=1";
const version = (n: number): DeployedVersion => ({
  id: `v${n}`,
  version: `v${n}`,
  url: `https://v${n}--desk.wasmer.app`,
  app: { id: "da_1", name: "desk-abc123", url: "https://desk-abc123.wasmer.app", adminUrl: "https://wasmer.io/apps/me/desk-abc123" },
});

let dir: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-deploy-"));
  process.env.VESSEL_HOME = dir;
  process.env.VESSEL_CREDENTIALS_PATH = path.join(dir, "credentials.json");
  vi.mocked(signedUploadUrl).mockResolvedValue(UPLOAD);
  vi.mocked(uploadZip).mockResolvedValue();
  vi.mocked(autobuildConfig).mockResolvedValue({ appName: "x", presetName: "node", installCmd: "npm install", buildCmd: null, startCmd: "node server.js", setupDb: false });
  vi.mocked(deployViaAutobuild).mockResolvedValue("build-1");
  vi.mocked(buildStatus).mockResolvedValue({ status: "SUCCESS", version: version(1) });
  vi.mocked(watchBuild).mockReturnValue(() => {});
  vi.mocked(stackFor).mockResolvedValue("node-pglite");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  delete process.env.VESSEL_HOME;
  delete process.env.VESSEL_CREDENTIALS_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

const linkWasmer = () =>
  updateStore((s) => {
    s.wasmer = { token: "wap_tok", username: "me", registry: "https://registry.wasmer.io/graphql", savedAt: new Date().toISOString() };
  });

async function project(files = [{ path: "server.js", data: "require('http')" }, { path: "public/index.html", data: "<h1>hi</h1>" }]) {
  const p = await createProject({ kind: "app", brief: "A support desk", name: "Support desk!" });
  if (files.length) await writeFiles(p.id, files);
  return p;
}

/** Run the background publish until it settles. */
async function settle(id: string) {
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(3_000);
    const { job } = await deployStatus(id);
    if (job?.step === "live" || job?.step === "failed") return job;
  }
  throw new Error("publish did not settle");
}

describe("appNameFor", () => {
  it("slugs the project name and adds a piece of the id", () => {
    expect(appNameFor({ id: "abc12345-0000-4000-8000-000000000000", name: "Support Désk — for my team!" })).toBe("support-desk-for-my-team-abc123");
    expect(appNameFor({ id: "12345678-0000-4000-8000-000000000000", name: "!!!" })).toBe("app-123456");
    expect(appNameFor({ id: "abc12345-0000-4000-8000-000000000000", name: "42 things" })).toBe("app-42-things-abc123");
  });
});

describe("zipWorkspace", () => {
  it("zips every workspace file at its relative path", async () => {
    const p = await project();
    const files = unzipSync(await zipWorkspace(p.id));
    expect(Object.keys(files).sort()).toEqual(["public/index.html", "server.js"]);
    expect(new TextDecoder().decode(files["server.js"])).toBe("require('http')");
  });

  it("refuses an empty project", async () => {
    const p = await project([]);
    await expect(zipWorkspace(p.id)).rejects.toThrow(/Nothing to publish/);
  });
});

describe("startDeploy", () => {
  it("needs a linked Wasmer account", async () => {
    const p = await project();
    await expect(startDeploy(p.id)).rejects.toMatchObject({ code: "unlinked" });
  });

  it("uploads, deploys with Anybuild and managed Postgres, and remembers the live app", async () => {
    await linkWasmer();
    const p = await project();
    const started = await startDeploy(p.id);
    expect(started.job?.step).not.toBe("live");

    const job = await settle(p.id);
    expect(job).toMatchObject({ step: "live", url: "https://desk-abc123.wasmer.app", preset: "node", buildId: "build-1" });
    expect(vi.mocked(uploadZip).mock.calls[0][0]).toBe(UPLOAD);
    expect(deployViaAutobuild).toHaveBeenCalledWith("wap_tok", {
      uploadUrl: UPLOAD,
      owner: "me",
      appName: appNameFor(p),
      appId: undefined,
      presetName: "node",
      installCmd: "npm install",
      buildCmd: null,
      startCmd: "node server.js",
      enableDatabase: true,
      dbEngine: "POSTGRES",
      envVars: [{ name: "NODE_ENV", value: "production" }],
    });
    expect(await readDeployment(p.id)).toMatchObject({ owner: "me", appId: "da_1", appName: "desk-abc123", url: "https://desk-abc123.wasmer.app", version: "v1" });
  });

  it("publishes later versions to the same app", async () => {
    await linkWasmer();
    const p = await project();
    await startDeploy(p.id);
    await settle(p.id);
    vi.mocked(buildStatus).mockResolvedValue({ status: "SUCCESS", version: version(2) });
    await startDeploy(p.id);
    await settle(p.id);
    expect(vi.mocked(deployViaAutobuild).mock.calls[1][1]).toMatchObject({ appId: "da_1", appName: "desk-abc123", owner: "me" });
    expect((await readDeployment(p.id))?.version).toBe("v2");
  });

  it("does not add a database to apps without one", async () => {
    await linkWasmer();
    vi.mocked(stackFor).mockResolvedValue("node");
    const p = await project();
    await startDeploy(p.id);
    await settle(p.id);
    expect(vi.mocked(deployViaAutobuild).mock.calls[0][1]).toMatchObject({ enableDatabase: false, dbEngine: undefined });
  });

  it("refuses a second publish while one is running", async () => {
    await linkWasmer();
    vi.mocked(buildStatus).mockResolvedValue({ status: "WORKING", version: null });
    const p = await project();
    await startDeploy(p.id);
    await expect(startDeploy(p.id)).rejects.toMatchObject({ code: "busy" });
  });

  it("reports a failed build and where it stopped, and keeps the build log", async () => {
    await linkWasmer();
    vi.mocked(buildStatus).mockResolvedValue({ status: "FAILED", version: null });
    vi.mocked(watchBuild).mockImplementation((_t, _b, onEvent) => {
      onEvent({ kind: "LOG", message: "npm ERR! missing script: start\n", version: null });
      return () => {};
    });
    const p = await project();
    await startDeploy(p.id);
    const job = await settle(p.id);
    expect(job).toMatchObject({ step: "failed", failedAt: "building" });
    expect(job.error).toMatch(/ended with failed/);
    expect(job.logs).toContain("npm ERR! missing script: start");
    expect((await readDeployment(p.id))?.url).toBeUndefined();
  });

  it("fails cleanly when the upload is refused", async () => {
    await linkWasmer();
    const { WasmerError } = await import("./wasmer");
    vi.mocked(uploadZip).mockRejectedValue(new WasmerError("Uploading the project to Wasmer failed (403)."));
    const p = await project();
    await startDeploy(p.id);
    const job = await settle(p.id);
    expect(job).toMatchObject({ step: "failed", failedAt: "uploading", error: "Uploading the project to Wasmer failed (403)." });
    expect(deployViaAutobuild).not.toHaveBeenCalled();
  });
});
