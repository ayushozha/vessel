// Zip archives imported into a project's workspace. Server-only.
// The archive is untrusted. Entries come from the central directory (what unzip tools trust), links and junk are
// skipped, every path goes through validatePath, and each entry inflates into a buffer capped at its declared size,
// so a lying header or a zip bomb stops at the cap instead of after it.
import { crc32, inflateRawSync } from "node:zlib";

import { createFolder, findConflicts, LIMITS, validatePath, WorkspaceError, writeFiles, type FileEntry } from "./workspace";

export const ZIP_LIMITS = { archiveBytes: 12 * 1024 * 1024, rawEntries: 2000, entries: LIMITS.files, totalBytes: 10 * 1024 * 1024, ratio: 100, ratioFloor: 64 * 1024 };

const JUNK_SEGMENTS = new Set(["__MACOSX", "node_modules", ".git"]);
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

type Raw = { name: string; dir: boolean; method: number; flags: number; crc: number; compSize: number; size: number; mode: number; offset: number };
type Planned = Raw & { path: string };

export type ZipPlan = {
  files: FileEntry[];
  folders: string[];
  skipped: { path: string; reason: string }[];
  conflicts: string[];
  totalBytes: number;
};

const corrupt = () => new WorkspaceError("This zip file is damaged or not a zip file.");

function readCentralDirectory(buf: Buffer): Raw[] {
  // The end-of-central-directory record sits in the last 22 bytes, or up to 64 KB earlier when the archive has a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt();
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new WorkspaceError("ZIP64 archives are not supported.");
  if (count > ZIP_LIMITS.rawEntries) throw new WorkspaceError(`zip has more than ${ZIP_LIMITS.rawEntries} entries`, "limit");
  const out: Raw[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw corrupt();
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (next > eocd) throw corrupt();
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
    out.push({
      name: name.replace(/\/+$/, ""),
      dir: name.endsWith("/"),
      flags,
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      // Unix mode bits live in the high half of the external attributes.
      mode: (buf.readUInt32LE(p + 38) >>> 16) & 0o170000,
      offset: buf.readUInt32LE(p + 42),
    });
    p = next;
  }
  return out;
}

function plan(buf: Buffer, folder = ""): { entries: Planned[]; skipped: ZipPlan["skipped"] } {
  if (buf.length > ZIP_LIMITS.archiveBytes) throw new WorkspaceError(`zip is larger than ${ZIP_LIMITS.archiveBytes / 1024 / 1024} MB`, "limit");
  let raw: Raw[];
  try {
    raw = readCentralDirectory(buf);
  } catch (e) {
    if (e instanceof WorkspaceError) throw e;
    throw corrupt();
  }
  const skipped: ZipPlan["skipped"] = [];
  const kept = raw.filter((e) => {
    const parts = e.name.split("/");
    if (!e.name) return false;
    if (parts.some((s) => JUNK_SEGMENTS.has(s)) || JUNK_FILES.has(parts[parts.length - 1])) {
      if (!e.dir) skipped.push({ path: e.name, reason: "ignored" });
      return false;
    }
    const reason = e.mode === 0o120000 ? "symbolic link" : e.mode && e.mode !== 0o100000 && e.mode !== 0o040000 ? "not a regular file" : null;
    if (reason) skipped.push({ path: e.name, reason });
    return !reason;
  });

  // A zip of one folder ("my-app/...") imports that folder's contents.
  const tops = new Set(kept.map((e) => e.name.split("/")[0]));
  const [top] = tops;
  const unwrap = tops.size === 1 && kept.some((e) => !e.dir && e.name.startsWith(`${top}/`)) && kept.every((e) => e.name === top ? e.dir : e.name.startsWith(`${top}/`));

  const entries: Planned[] = [];
  for (const e of kept) {
    const inner = unwrap ? e.name.slice(top.length + 1) : e.name;
    if (!inner) continue;
    const name = folder ? `${folder}/${inner}` : inner;
    const checked = validatePath(name);
    if (!checked.ok) {
      skipped.push({ path: name, reason: checked.reason });
      continue;
    }
    const reason =
      e.flags & 1 ? "encrypted"
      : !e.dir && e.method !== 0 && e.method !== 8 ? "unsupported compression"
      : !e.dir && e.size > LIMITS.fileBytes ? `larger than ${LIMITS.fileBytes / 1024} KB`
      : null;
    if (reason) skipped.push({ path: name, reason });
    else entries.push({ ...e, path: checked.path });
  }

  const files = entries.filter((e) => !e.dir);
  if (files.length > ZIP_LIMITS.entries) throw new WorkspaceError(`zip has more than ${ZIP_LIMITS.entries} files`, "limit");
  const total = files.reduce((sum, e) => sum + e.size, 0);
  if (total > ZIP_LIMITS.totalBytes) throw new WorkspaceError(`zip expands to more than ${ZIP_LIMITS.totalBytes / 1024 / 1024} MB`, "limit");
  const bomb = files.find((e) => e.size > ZIP_LIMITS.ratioFloor && e.size > e.compSize * ZIP_LIMITS.ratio);
  if (bomb) throw new WorkspaceError(`${bomb.path} compresses more than ${ZIP_LIMITS.ratio}:1; refusing a possible zip bomb`, "limit");
  return { entries, skipped };
}

function inflate(buf: Buffer, e: Planned): Buffer {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw corrupt();
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  if (start + e.compSize > buf.length) throw corrupt();
  const comp = buf.subarray(start, start + e.compSize);
  let data: Buffer;
  if (e.size === 0) data = Buffer.alloc(0);
  else if (e.method === 0) data = comp;
  else {
    try {
      // The declared size is the hard cap: inflation stops the moment output passes it.
      data = inflateRawSync(comp, { maxOutputLength: e.size });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new WorkspaceError(`${e.path} expands past its declared size; refusing a possible zip bomb`, "limit");
      throw corrupt();
    }
  }
  if (data.length !== e.size || crc32(data) !== e.crc) throw new WorkspaceError(`${e.path} failed its checksum; the zip is damaged.`);
  return data;
}

/** What importing `buf` would do, without touching the workspace. */
export async function previewZip(projectId: string, buf: Buffer, { folder = "" } = {}): Promise<ZipPlan> {
  const { entries, skipped } = plan(buf, folder);
  const files = entries.filter((e) => !e.dir);
  return {
    files: files.map((e) => ({ path: e.path, bytes: e.size })),
    folders: entries.filter((e) => e.dir).map((e) => e.path),
    skipped,
    conflicts: await findConflicts(projectId, files.map((e) => e.path)),
    totalBytes: files.reduce((sum, e) => sum + e.size, 0),
  };
}

/** Imports `buf` into the workspace (under `folder`). Existing files are only replaced with `overwrite`. Returns the changed paths. */
export async function importZip(projectId: string, buf: Buffer, { overwrite = false, folder = "" } = {}): Promise<{ plan: ZipPlan; changed: string[] }> {
  const preview = await previewZip(projectId, buf, { folder });
  if (preview.conflicts.length && !overwrite) throw new WorkspaceError(`${preview.conflicts.length} file(s) already exist`, "conflict");
  const { entries } = plan(buf, folder);
  const inputs = entries.filter((e) => !e.dir).map((e) => ({ path: e.path, data: inflate(buf, e) }));
  const written = await writeFiles(projectId, inputs, { overwrite: true });
  const changed = written.map((f) => f.path);
  for (const folder of preview.folders) {
    if (preview.files.some((f) => f.path.startsWith(`${folder}/`))) continue;
    try {
      changed.push(...(await createFolder(projectId, folder)));
    } catch (e) {
      if (!(e instanceof WorkspaceError && e.code === "conflict")) throw e;
    }
  }
  return { plan: preview, changed };
}
