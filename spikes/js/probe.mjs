// Lists the commands each registry package exposes and times a trivial run.
import { newWasmer, PKG, now, ms } from "./lib.mjs";
const wasmer = newWasmer();
try {
  for (const id of [PKG.edge, PKG.pglite, PKG.sws]) {
    const t = now();
    const pkg = await wasmer.packages.load(id);
    console.log(id, "load", ms(t), "commands:", pkg.commands.join(", "), "entry:", pkg.entrypoint);
  }
  const sb = await wasmer.sandboxes.create({ packages: [PKG.edge] });
  let t = now();
  console.log((await sb.command("edge", ["-e", "console.log(process.version, process.platform, process.arch)"]).run()).text().trim(), ms(t));
  t = now();
  console.log((await sb.command("edge", ["-e", "console.log('warm')"]).run()).text().trim(), ms(t));
  for (const c of ["npm", "pnpm", "npx", "node", "ls"]) {
    const o = await sb.command(c, ["--version"]).run({ check: false }).catch((e) => ({ text: () => `ERR ${e.code ?? e.message}` }));
    console.log(c, "->", (o.stdout?.text?.() ?? o.text()).trim().slice(0, 100), o.stderr?.text?.().trim().slice(0, 200) ?? "");
  }
  await sb.close();
} finally { await wasmer.close(); }
