// Run the test suite against a throwaway Ares home.
//
// A plain `node --test tests/*.test.mjs` leaves a populated ~/.ares behind —
// 84 KB of vault, mind and garrison state — and creates one on a machine that
// had none. Tests that build their own temp home are unaffected; this covers
// the ones that just call aresHome() and get the owner's real vault.
//
// It is a wrapper rather than a per-file fixture because the boundary belongs
// to the whole run: ARES_HOME is read at import time in places, and 94 of the
// suite's 237 files never mention it. One env var set before the runner starts
// closes all of them at once.
//
// Cross-platform on purpose: no mktemp, no shell globbing. `pnpm test` on
// Windows goes through cmd.exe, which expands neither.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(repoRoot, "tests");

// Anything passed through lands before the file list: `node scripts/run-tests.mjs
// --experimental-test-coverage`, or a substring to run one file.
const passthrough = process.argv.slice(2).filter((arg) => arg.startsWith("-"));
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

const files = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
  .sort()
  .map((name) => path.join(testsDir, name));

if (files.length === 0) {
  process.stderr.write(`no test files matched ${filters.join(", ") || "*.test.mjs"}\n`);
  process.exit(1);
}

const home = mkdtempSync(path.join(os.tmpdir(), "ares-test-home-"));
try {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=4", ...passthrough, ...files],
    { stdio: "inherit", cwd: repoRoot, env: { ...process.env, ARES_HOME: home } },
  );
  // A signal death (OOM, SIGKILL) has no exit status; reporting 0 there would
  // turn a crashed run into a green one.
  process.exit(result.status ?? 1);
} finally {
  rmSync(home, { recursive: true, force: true });
}
