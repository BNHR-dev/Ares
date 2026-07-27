#!/usr/bin/env node
// Standalone Vanguard TUI — the engine Ares already ships, without the shell.
//
// The desktop app embeds Vanguard as its coding engine, but the engine's own
// terminal UI is a complete product on its own: `vanguard` in any project
// directory opens it there. This matters on machines where the desktop shell
// is heavy (WebKitGTK Linux especially) — the TUI is plain terminal I/O and
// runs anywhere Node runs, PowerShell included. Resolution order mirrors the
// daemon's worker resolution: an explicit override, then the OTA-updated
// engine, then the copy vendored into this package. All arguments pass
// through to Vanguard's CLI (`vanguard --help`, `vanguard run …`; bare
// `vanguard` opens the TUI).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentVanguardEngine } from "./entry/vanguardEngineUpdate.js";

async function resolveEngineCli(): Promise<string | undefined> {
  const explicit = process.env.ARES_VANGUARD_CLI;
  if (explicit !== undefined && explicit !== "" && existsSync(explicit)) return explicit;
  const home = process.env.ARES_HOME || path.join(os.homedir(), ".ares");
  const updated = await currentVanguardEngine(home).catch(() => undefined);
  if (updated !== undefined) return path.join(updated.dir, "engine", "src", "cli.js");
  // The vendored engine, wherever this bin landed: beside the package's own
  // node_modules (the pnpm file: link) or in the repo's vendor tree. The
  // package cannot be require.resolve'd — its exports map is ESM-only.
  const candidates = [
    new URL("../node_modules/vanguard/engine/src/cli.js", import.meta.url),
    new URL("../../../vendor/vanguard/engine/src/cli.js", import.meta.url),
  ];
  for (const candidate of candidates) {
    const file = fileURLToPath(candidate);
    if (existsSync(file)) return file;
  }
  return undefined;
}

async function main(): Promise<void> {
  const cli = await resolveEngineCli();
  if (cli === undefined) {
    process.stderr.write(
      "vanguard: no engine found (expected the Ares-vendored copy, an OTA install under "
      + "~/.ares/vanguard-engine, or an ARES_VANGUARD_CLI override).\n",
    );
    process.exit(1);
  }
  const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal !== null ? 1 : 0));
  });
  child.on("error", (error) => {
    process.stderr.write(`vanguard: failed to launch engine: ${error.message}\n`);
    process.exit(1);
  });
}

void main();
