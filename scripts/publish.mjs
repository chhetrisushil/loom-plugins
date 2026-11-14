#!/usr/bin/env node
// Publishes every public plugin under plugins/ to npm under the `next` dist-tag.
//
//   node scripts/publish.mjs          # DRY RUN: packs each plugin and reports what would ship
//   node scripts/publish.mjs --yes    # really publish (needs `npm login`)
//
// Then, once the release is verified, promote it: `node ../loom/scripts/promote-latest.mjs --yes` moves
// `latest` to it (loom ADR 0148 amendment: npm set `latest` on the first publish, and `^` ranges resolve
// to it, so a release left on `next` alone is not what consumers install).
//
// Refused unless the git tree is clean and every public plugin is built (`dist/` present). The root
// LICENSE and NOTICE are copied into each plugin for the pack and removed afterwards (git-ignored).
// Publish AFTER the @loomwork/* versions the plugins' peer ranges name are on the registry.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const really = process.argv.includes("--yes");
const fail = (msg) => {
  console.error(`publish: ${msg}`);
  process.exit(1);
};

if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) {
  fail("the git tree is not clean");
}
const plugins = readdirSync(join(root, "plugins"))
  .map((d) => join(root, "plugins", d))
  .filter((d) => existsSync(join(d, "package.json")))
  .filter((d) => !JSON.parse(readFileSync(join(d, "package.json"), "utf8")).private);
const unbuilt = plugins.filter((d) => !existsSync(join(d, "dist")));
if (unbuilt.length) fail(`not built (run pnpm build): ${unbuilt.join(", ")}`);

const copied = [];
try {
  for (const d of plugins) {
    for (const f of ["LICENSE", "NOTICE"]) {
      copyFileSync(join(root, f), join(d, f));
      copied.push(join(d, f));
    }
  }
  const args = ["-r", "publish", "--tag", "next", "--access", "public", "--no-git-checks"];
  if (!really) args.push("--dry-run");
  console.log(`${really ? "PUBLISHING" : "dry run:"} ${plugins.length} plugins (tag next)`);
  execFileSync("pnpm", args, { cwd: root, stdio: "inherit" });
} finally {
  for (const f of copied) rmSync(f, { force: true });
}
if (!really) console.log("dry run only; re-run with --yes to publish");
