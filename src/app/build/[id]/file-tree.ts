// Browser-side helpers for the Code tab's file tree: nesting the flat listing and reading dropped files and folders.

export type Entry = { path: string; bytes: number; type: "file" | "dir" };
export type TreeNode = Entry & { name: string; children: TreeNode[] };
export type Picked = { files: { path: string; file: File }[]; dirs: string[]; skipped: number };

/** Nests a sorted flat listing; folders first, then files, each alphabetical. */
export function buildTree(entries: Entry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const node: TreeNode = { ...e, name: e.path.split("/").pop()!, children: [] };
    if (e.type === "dir") dirs.set(e.path, node);
    const parent = e.path.includes("/") ? dirs.get(e.path.slice(0, e.path.lastIndexOf("/"))) : undefined;
    (parent ? parent.children : root).push(node);
  }
  const order = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    nodes.forEach((n) => order(n.children));
    return nodes;
  };
  return order(root);
}

export const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

// Things that never belong in an upload; the server would refuse the whole batch over them.
const JUNK = /(^|\/)(node_modules|\.git|__MACOSX|\.next|\.wasmer|dist-ssr)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/;

export function pickFiles(list: Iterable<File>, relative = (f: File) => f.webkitRelativePath || f.name): Picked {
  const picked: Picked = { files: [], dirs: [], skipped: 0 };
  for (const file of list) {
    const path = relative(file);
    if (JUNK.test(path)) picked.skipped++;
    else picked.files.push({ path, file });
  }
  return picked;
}

/** Files and folders from a drop, walking directories. Must be called synchronously inside the drop handler. */
export function readDrop(dt: DataTransfer): Promise<Picked> {
  const roots = [...dt.items].map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!roots.length) return Promise.resolve(pickFiles(dt.files));
  const picked: Picked = { files: [], dirs: [], skipped: 0 };
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const path = join(prefix, entry.name);
    if (JUNK.test(path)) {
      picked.skipped++;
      return;
    }
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
      picked.files.push({ path, file });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    // readEntries returns at most ~100 entries per call; keep reading until it returns none.
    for (let batch: FileSystemEntry[]; (batch = await new Promise((ok, fail) => reader.readEntries(ok, fail))).length; ) children.push(...batch);
    if (!children.length) picked.dirs.push(path);
    for (const child of children) await walk(child, path);
  };
  return Promise.all(roots.map((r) => walk(r, ""))).then(() => picked);
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(p);
