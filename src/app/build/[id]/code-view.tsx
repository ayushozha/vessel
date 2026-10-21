"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import styles from "./builder.module.css";
import { buildTree, formatBytes, isImage, join, parentOf, pickFiles, readDrop, type Entry, type Picked, type TreeNode } from "./file-tree";

const PREFERRED = ["server.js", "index.js", "public/index.html", "index.html", "package.json"];
const MOVE = "application/x-vessel-path";
const JSON_HEADERS = { "Content-Type": "application/json" };

type Doc = { path: string; kind: "text"; content: string } | { path: string; kind: "image" | "binary"; bytes: number } | { path: string; kind: "error"; message: string };
type ZipPlan = { files: Entry[]; folders: string[]; skipped: { path: string; reason: string }[]; conflicts: string[]; totalBytes: number };
type Dialog = { title: string; body?: ReactNode; confirm?: string; danger?: boolean; onConfirm?: () => void };
type Reply<T> = { ok: boolean; status: number; body: T & { error?: string; conflicts?: string[] } };

async function api<T = object>(url: string, init?: RequestInit): Promise<Reply<T>> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, body: { error: "Adorable is not reachable." } as Reply<T>["body"] };
  }
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/** File tree, uploads and editor for the project workspace. Refreshes when `version` changes. */
export function CodeView({ projectId, version, changed }: { projectId: string; version: number; changed: Set<string> }) {
  const base = `/api/projects/${projectId}/files`;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parent: string; type: "file" | "dir" } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const uploadFolder = useRef("");
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const loaded = useRef<string | null>(null);
  const dirtyRef = useRef(false);

  const dirty = doc?.kind === "text" && draft !== doc.content;
  const tree = useMemo(() => buildTree(entries ?? []), [entries]);
  const refresh = () => setTick((t) => t + 1);
  useEffect(() => {
    dirtyRef.current = dirty;
  });

  useEffect(() => {
    let cancelled = false;
    api<{ files: Entry[] }>(base).then(({ ok, body }) => {
      if (cancelled) return;
      if (!ok) return setError(body.error ?? "Could not list files.");
      const files = body.files.filter((f) => f.type === "file");
      setEntries(body.files);
      setSelected((s) => (s && files.some((f) => f.path === s) ? s : (PREFERRED.find((p) => files.some((f) => f.path === p)) ?? files[0]?.path ?? null)));
    });
    return () => {
      cancelled = true;
    };
  }, [base, version, tick]);

  useEffect(() => {
    // Never clobber unsaved edits when the model or an upload rewrites the open file.
    if (!selected || (dirtyRef.current && loaded.current === selected)) return;
    let cancelled = false;
    api<{ content?: string; binary?: boolean; bytes: number }>(`${base}?path=${encodeURIComponent(selected)}`).then(({ ok, body }) => {
      if (cancelled) return;
      const next: Doc = !ok
        ? { path: selected, kind: "error", message: body.error ?? "Could not open this file." }
        : body.binary || isImage(selected)
          ? { path: selected, kind: isImage(selected) ? "image" : "binary", bytes: body.bytes }
          : { path: selected, kind: "text", content: body.content ?? "" };
      loaded.current = selected;
      setDoc(next);
      setDraft(next.kind === "text" ? next.content : "");
    });
    return () => {
      cancelled = true;
    };
  }, [base, selected, version]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.("[role=menu]")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const fail = (body: { error?: string }) => setNotice({ text: body.error ?? "Something went wrong.", error: true });
  const expand = (folder: string) => setCollapsed((c) => new Set([...c].filter((p) => p !== folder && !folder.startsWith(`${p}/`))));

  function select(p: string) {
    if (p === selected) return;
    if (!dirty || doc?.kind !== "text") return setSelected(p);
    const open = doc;
    setDialog({
      title: "Discard unsaved changes?",
      body: <p>{open.path} has edits that are not saved.</p>,
      confirm: "Discard",
      danger: true,
      onConfirm: () => {
        setDraft(open.content);
        setSelected(p);
      },
    });
  }

  async function save() {
    if (doc?.kind !== "text" || !dirty || saving) return;
    setSaving(true);
    const r = await api(base, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ path: doc.path, content: draft }) });
    setSaving(false);
    if (!r.ok) return fail(r.body);
    setDoc({ ...doc, content: draft });
    setNotice(null);
    refresh();
  }

  async function upload(picked: Picked, folder: string, overwrite = false) {
    const lone = picked.files.length === 1 && !picked.dirs.length ? picked.files[0] : null;
    if (lone && !lone.path.includes("/") && /\.zip$/i.test(lone.path)) return importZip(lone.file, folder);
    if (!picked.files.length && !picked.dirs.length) return setNotice({ text: picked.skipped ? `Skipped ${plural(picked.skipped, "ignored item")}.` : "Nothing to upload.", error: true });
    const form = new FormData();
    form.append("folder", folder);
    if (overwrite) form.append("overwrite", "1");
    for (const f of picked.files) {
      form.append("path", f.path);
      form.append("file", f.file);
    }
    for (const d of picked.dirs) form.append("dir", d);
    setNotice({ text: `Uploading ${plural(picked.files.length, "file")}…` });
    const r = await api<{ paths: string[] }>(base, { method: "POST", body: form });
    if (r.status === 409 && r.body.conflicts) {
      setNotice(null);
      return setDialog({ title: `Replace ${plural(r.body.conflicts.length, "existing file")}?`, body: <PathList paths={r.body.conflicts} />, confirm: "Replace", danger: true, onConfirm: () => upload(picked, folder, true) });
    }
    if (!r.ok) return fail(r.body);
    if (folder) expand(folder);
    setNotice({ text: `Uploaded ${plural(picked.files.length, "file")}${picked.skipped ? `, skipped ${plural(picked.skipped, "ignored item")}` : ""}.` });
    refresh();
  }

  async function importZip(file: File, folder: string) {
    const url = (q: string) => `${base}/import-zip?${q}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`;
    setNotice({ text: `Reading ${file.name}…` });
    const r = await api<ZipPlan>(url("dryRun=1"), { method: "POST", body: file });
    if (!r.ok) return fail(r.body);
    setNotice(null);
    const plan = r.body;
    const empty = !plan.files.length && !plan.folders.length;
    setDialog({
      title: `Import ${file.name}`,
      body: <ZipSummary plan={plan} />,
      confirm: empty ? undefined : plan.conflicts.length ? `Import and replace ${plan.conflicts.length}` : "Import",
      danger: plan.conflicts.length > 0,
      onConfirm: async () => {
        const done = await api<{ written: string[] }>(url("overwrite=1"), { method: "POST", body: file });
        if (!done.ok) return fail(done.body);
        if (folder) expand(folder);
        setNotice({ text: `Imported ${plural(plan.files.length, "file")} from ${file.name}.` });
        refresh();
      },
    });
  }

  async function move(from: string, to: string, overwrite = false) {
    if (from === to) return;
    const r = await api(base, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ from, to, overwrite }) });
    const target = entries?.find((e) => e.path.toLowerCase() === to.toLowerCase());
    if (r.status === 409 && !overwrite && target?.type === "file" && entries?.find((e) => e.path === from)?.type === "file") {
      return setDialog({ title: `Replace ${to}?`, body: <p>A file with that name already exists.</p>, confirm: "Replace", danger: true, onConfirm: () => move(from, to, true) });
    }
    if (!r.ok) return fail(r.body);
    if (selected && (selected === from || selected.startsWith(`${from}/`))) {
      const next = to + selected.slice(from.length);
      if (dirty) loaded.current = next;
      setDoc((d) => d && { ...d, path: next });
      setSelected(next);
    }
    setNotice(null);
    refresh();
  }

  function rename(node: TreeNode, name: string) {
    setRenaming(null);
    const clean = name.trim();
    if (clean && clean !== node.name) move(node.path, join(parentOf(node.path), clean));
  }

  function toggle(folder: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });
  }

  function remove(node: TreeNode) {
    const inside = (entries ?? []).filter((e) => e.path.startsWith(`${node.path}/`)).length;
    setDialog({
      title: `Delete ${node.name}?`,
      body: <p>{node.type === "dir" ? `This deletes the folder${inside ? ` and ${plural(inside, "item")} inside it` : ""}.` : "This deletes the file."} It cannot be undone.</p>,
      confirm: "Delete",
      danger: true,
      onConfirm: async () => {
        const r = await api(`${base}?path=${encodeURIComponent(node.path)}`, { method: "DELETE" });
        if (!r.ok) return fail(r.body);
        if (selected === node.path || selected?.startsWith(`${node.path}/`)) loaded.current = null;
        setNotice({ text: `Deleted ${node.path}.` });
        refresh();
      },
    });
  }

  async function create(name: string) {
    const draftEntry = creating;
    setCreating(null);
    if (!draftEntry || !name.trim()) return;
    const p = join(draftEntry.parent, name.trim().replace(/^\/+|\/+$/g, ""));
    const r = await api(base, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ path: p, type: draftEntry.type }) });
    if (!r.ok) return fail(r.body);
    if (draftEntry.type === "file") select(p);
    refresh();
  }

  function pick(input: HTMLInputElement | null, folder: string) {
    uploadFolder.current = folder;
    input?.click();
  }

  function onPicked(e: ChangeEvent<HTMLInputElement>, handle: (files: File[], folder: string) => void) {
    // Copy the FileList before clearing the input, so picking the same file again still fires change.
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length) handle(files, uploadFolder.current);
  }

  // Drop targets carry their folder in data-folder ("" is the workspace root).
  const folderOf = (e: DragEvent) => (e.currentTarget as HTMLElement).dataset.folder ?? "";
  const drop = {
    onDragOver: (e: DragEvent) => {
      const types = e.dataTransfer.types;
      if (!types.includes("Files") && !types.includes(MOVE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = types.includes(MOVE) ? "move" : "copy";
      setDropTarget(folderOf(e));
    },
    onDragLeave: (e: DragEvent) => {
      const folder = folderOf(e);
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget((t) => (t === folder ? null : t));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const folder = folderOf(e);
      const from = e.dataTransfer.getData(MOVE);
      if (from) {
        if (folder !== from && parentOf(from) !== folder) move(from, join(folder, from.split("/").pop()!));
        return;
      }
      readDrop(e.dataTransfer).then(
        (picked) => upload(picked, folder),
        () => setNotice({ text: "Could not read the dropped files.", error: true }),
      );
    },
  };

  const openMenu = (e: ReactMouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    setMenu({ x: e.clientX || box.left + 12, y: e.clientY || box.bottom, node });
  };

  const renderNodes = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      const isDir = node.type === "dir";
      const open = isDir && !collapsed.has(node.path);
      const pad = { paddingLeft: 6 + depth * 12 + (isDir ? 0 : 12) };
      return (
        <li key={node.path} data-drop={isDir && dropTarget === node.path} data-folder={isDir ? node.path : parentOf(node.path)} {...drop}>
          {renaming === node.path ? (
            <NameInput style={pad} initial={node.name} onDone={(name) => rename(node, name)} />
          ) : (
            <button
              type="button"
              style={pad}
              draggable
              data-on={node.path === selected}
              aria-expanded={isDir ? open : undefined}
              title={isDir ? node.path : `${node.path} · ${formatBytes(node.bytes)}`}
              onClick={() => (isDir ? toggle(node.path) : select(node.path))}
              onContextMenu={(e) => openMenu(e, node)}
              onDragStart={(e) => e.dataTransfer.setData(MOVE, node.path)}
            >
              <span>
                {isDir && <b aria-hidden="true">{open ? "▾" : "▸"}</b>}
                {node.name}
                {isDir ? "/" : ""}
              </span>
              {node.path === doc?.path && dirty ? <i className={styles.unsaved} aria-label="unsaved changes" /> : changed.has(node.path) && <i aria-label="changed in the last run" />}
            </button>
          )}
          {open && (node.children.length > 0 || creating?.parent === node.path) && (
            <ul>
              {creating?.parent === node.path && <NameInput style={{ paddingLeft: 18 + depth * 12 }} initial="" placeholder={creating.type === "dir" ? "folder name" : "file name"} onDone={create} />}
              {renderNodes(node.children, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

  const startCreate = (parent: string, type: "file" | "dir") => {
    if (parent) expand(parent);
    setCreating({ parent, type });
  };
  const menuItems: [string, () => void][] = !menu
    ? []
    : menu.node?.type === "file"
      ? [["Rename", () => setRenaming(menu.node!.path)], ["Delete", () => remove(menu.node!)]]
      : [
          ["New file", () => startCreate(menu.node?.path ?? "", "file")],
          ["New folder", () => startCreate(menu.node?.path ?? "", "dir")],
          ["Upload files", () => pick(filesInput.current, menu.node?.path ?? "")],
          ["Upload folder", () => pick(folderInput.current, menu.node?.path ?? "")],
          ["Import .zip", () => pick(zipInput.current, menu.node?.path ?? "")],
          ...(menu.node ? ([["Rename", () => setRenaming(menu.node!.path)], ["Delete", () => remove(menu.node!)]] as [string, () => void][]) : []),
        ];

  if (error) return <p className={styles.muted}>{error}</p>;
  const lineCount = draft.split("\n").length;

  return (
    <div
      className={styles.code}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          save();
        }
      }}
    >
      <div className={styles.treePane} data-drop={dropTarget === ""} data-folder="" {...drop} onContextMenu={(e) => openMenu(e, null)}>
        <div className={styles.treeTools} role="toolbar" aria-label="Files">
          <ToolButton label="New file" onClick={() => startCreate("", "file")} d="M7 2h5l4 4v12H7zM12 2v4h4M11.5 9v6M8.5 12h6" />
          <ToolButton label="New folder" onClick={() => startCreate("", "dir")} d="M2 5h6l2 2h8v10H2zM10 9.5v5M7.5 12h5" />
          <ToolButton label="Upload files" onClick={() => pick(filesInput.current, "")} d="M10 14V3M5.5 7.5 10 3l4.5 4.5M3 13v4h14v-4" />
          <ToolButton label="Upload folder" onClick={() => pick(folderInput.current, "")} d="M2 5h6l2 2h8v10H2zM10 15v-5M7.5 12.5 10 10l2.5 2.5" />
          <ToolButton label="Import .zip" onClick={() => pick(zipInput.current, "")} d="M4 2h12v16H4zM9 2v2h2v2H9v2h2v2H9v3h2" />
        </div>
        <ul className={styles.tree} aria-label="Project files">
          {creating?.parent === "" && <NameInput style={{ paddingLeft: 6 }} initial="" placeholder={creating.type === "dir" ? "folder name" : "file name"} onDone={create} />}
          {renderNodes(tree, 0)}
          {entries && !entries.length && !creating && <li className={styles.dropHint}>Drop files, a folder or a .zip here</li>}
        </ul>
        {notice && (
          <p className={styles.notice} data-error={notice.error} role="status">
            {notice.text}
          </p>
        )}
      </div>

      <div className={styles.source}>
        {doc && entries?.length ? (
          <>
            <div className={styles.sourceHead}>
              <span>
                {doc.path}
                {dirty && <i className={styles.unsaved} aria-label="unsaved changes" />}
              </span>
              {doc.kind === "text" && (
                <span className={styles.editorActions}>
                  {dirty && (
                    <button type="button" onClick={() => setDraft(doc.content)}>
                      Discard
                    </button>
                  )}
                  <button type="button" data-primary onClick={save} disabled={!dirty || saving} title="Save (Ctrl+S)">
                    {saving ? "Saving…" : "Save"}
                  </button>
                </span>
              )}
            </div>
            {doc.kind === "text" ? (
              <div className={styles.editor}>
                <pre aria-hidden="true">{Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}</pre>
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={lineCount} wrap="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label={`Edit ${doc.path}`} />
              </div>
            ) : doc.kind === "image" ? (
              <div className={styles.imagePreview}>
                {/* eslint-disable-next-line @next/next/no-img-element -- workspace bytes, not an optimizable asset */}
                <img src={`${base}?path=${encodeURIComponent(doc.path)}&raw=1&v=${version}-${tick}`} alt={doc.path} />
                <span>{formatBytes(doc.bytes)}</span>
              </div>
            ) : (
              <div className={styles.empty}>
                <strong>{doc.kind === "binary" ? "Binary file" : "Cannot open"}</strong>
                <p>{doc.kind === "binary" ? `${formatBytes(doc.bytes)} · not editable here` : doc.kind === "error" && doc.message}</p>
              </div>
            )}
          </>
        ) : (
          <div className={styles.empty} data-drop={dropTarget === ""} data-folder="" {...drop}>
            <strong>{entries?.length ? "Pick a file" : "No source yet."}</strong>
            <p>Files appear here the moment the model writes them. Drop files, folders or a .zip anywhere in this tab to add your own.</p>
          </div>
        )}
      </div>

      {menu && (
        <div className={styles.menu} role="menu" style={{ left: menu.x, top: menu.y }}>
          {menuItems.map(([label, act], i) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              autoFocus={i === 0}
              data-danger={label === "Delete"}
              onClick={() => {
                setMenu(null);
                act();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {dialog && <ConfirmDialog dialog={dialog} onClose={() => setDialog(null)} />}

      <input ref={filesInput} type="file" multiple hidden onChange={(e) => onPicked(e, (files, folder) => upload(pickFiles(files, (f) => f.name), folder))} />
      <input
        ref={(el) => {
          folderInput.current = el;
          el?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        hidden
        onChange={(e) => onPicked(e, (files, folder) => upload(pickFiles(files), folder))}
      />
      <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => onPicked(e, ([zip], folder) => importZip(zip, folder))} />
    </div>
  );
}

function ToolButton({ label, d, onClick }: { label: string; d: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
      </svg>
    </button>
  );
}

function NameInput({ initial, placeholder, style, onDone }: { initial: string; placeholder?: string; style: CSSProperties; onDone: (name: string) => void }) {
  const done = useRef(false);
  const finish = (value: string) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <li className={styles.nameRow} style={style}>
      <input
        autoFocus
        defaultValue={initial}
        placeholder={placeholder}
        aria-label={placeholder ?? "New name"}
        spellCheck={false}
        onFocus={(e) => e.target.setSelectionRange(0, initial.lastIndexOf(".") > 0 ? initial.lastIndexOf(".") : initial.length)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(e.currentTarget.value);
          if (e.key === "Escape") finish("");
        }}
        onBlur={(e) => finish(e.target.value)}
      />
    </li>
  );
}

function PathList({ paths }: { paths: string[] }) {
  return (
    <ul className={styles.pathList}>
      {paths.slice(0, 8).map((p) => (
        <li key={p}>{p}</li>
      ))}
      {paths.length > 8 && <li>…and {paths.length - 8} more</li>}
    </ul>
  );
}

function ZipSummary({ plan }: { plan: ZipPlan }) {
  return (
    <div className={styles.zipSummary}>
      <p>
        {plural(plan.files.length, "file")}
        {plan.folders.length ? `, ${plural(plan.folders.length, "empty folder")}` : ""} · {formatBytes(plan.totalBytes)}
      </p>
      {plan.conflicts.length > 0 && (
        <>
          <h4>Will replace {plural(plan.conflicts.length, "existing file")}</h4>
          <PathList paths={plan.conflicts} />
        </>
      )}
      {plan.skipped.length > 0 && (
        <>
          <h4>Skipped {plural(plan.skipped.length, "entry")}</h4>
          <PathList paths={plan.skipped.map((s) => `${s.path} · ${s.reason}`)} />
        </>
      )}
    </div>
  );
}

function ConfirmDialog({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog ref={ref} className={styles.dialog} onClose={onClose} onClick={(e) => e.target === e.currentTarget && ref.current?.close()} aria-labelledby="fs-dialog-title">
      <h3 id="fs-dialog-title">{dialog.title}</h3>
      {dialog.body}
      <div className={styles.dialogRow}>
        <button type="button" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        {dialog.confirm && (
          <button
            type="button"
            autoFocus
            data-danger={dialog.danger}
            onClick={() => {
              ref.current?.close();
              dialog.onConfirm?.();
            }}
          >
            {dialog.confirm}
          </button>
        )}
      </div>
    </dialog>
  );
}
