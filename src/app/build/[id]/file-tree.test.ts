import { describe, expect, it } from "vitest";

import { buildTree, formatBytes, pickFiles } from "./file-tree";

describe("file tree helpers", () => {
  it("nests folders first, then files, including empty folders", () => {
    const tree = buildTree([
      { path: "server.js", bytes: 1, type: "file" },
      { path: "src", bytes: 0, type: "dir" },
      { path: "src/b.js", bytes: 1, type: "file" },
      { path: "src/a", bytes: 0, type: "dir" },
      { path: "empty", bytes: 0, type: "dir" },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["empty", "src", "server.js"]);
    expect(tree[1].children.map((n) => n.path)).toEqual(["src/a", "src/b.js"]);
  });

  it("drops junk from picked folders", () => {
    const file = (name: string) => new File(["x"], name);
    const picked = pickFiles([file("a"), file("b"), file("c")], (f) => ({ a: "app/index.js", b: "app/node_modules/x.js", c: "app/.DS_Store" })[f.name]!);
    expect(picked.files.map((f) => f.path)).toEqual(["app/index.js"]);
    expect(picked.skipped).toBe(2);
  });

  it("formats sizes", () => expect([formatBytes(12), formatBytes(2048), formatBytes(3 * 1024 * 1024)]).toEqual(["12 B", "2.0 KB", "3.0 MB"]));
});
