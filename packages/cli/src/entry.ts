#!/usr/bin/env node
// ares — v2 CLI entrypoint.
//
// Commands:
//   ares chat                                      interactive terminal loop
//   ares run --goal "<text>" [--provider openai|ollama] [--model X]
//   ares login                                      OAuth device-code
//   ares doctor                                     auth + ollama health
//   ares help
//
// `run` emits NDJSON for automation; `chat` renders a human terminal loop.

import { stat } from "node:fs/promises";
import path from "node:path";
import { availableThemes, setTheme, themeChanged } from "./terminalUi.js";
import { parseArgs } from "./entry/args.js";

function bridgeLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (!key.startsWith("CRIX_")) continue;
    const aresKey = `ARES_${key.slice("CRIX_".length)}`;
    if (env[aresKey] === undefined) env[aresKey] = env[key];
  }
}

const INTERACTIVE_THEME_COMMANDS = new Set([
  "launcher",
  "menu",
  "chat",
  "cli",
  "shell",
  "run",
]);

async function main(): Promise<void> {
  // Rebrand compat: mirror legacy CRIX_* env vars onto ARES_* before anything
  // reads configuration.
  bridgeLegacyEnv();
  const args = parseArgs(process.argv.slice(2));
  const requestedTheme = args.flags.get("theme");
  if (requestedTheme) {
    const selected = setTheme(requestedTheme);
    if (!selected) {
      process.stderr.write(`error: unknown theme "${requestedTheme}". Available: ${availableThemes().join(", ")}\n`);
      process.exit(2);
    }
  } else if (INTERACTIVE_THEME_COMMANDS.has(args.command)) {
    const { loadSavedTheme } = await import("./entry/terminalLines.js");
    await loadSavedTheme();
  }
  await applyWorkspaceFlag(args.flags);
  switch (args.command) {
    case "launcher":
    case "menu": {
      const { launcherCommand } = await import("./entry/chat.js");
      process.exit(await launcherCommand(args));
      return;
    }
    case "chat":
    case "cli":
    case "shell": {
      const { chatCommand } = await import("./entry/chat.js");
      process.exit(await chatCommand(args));
      return;
    }
    case "run": {
      const { runCommand } = await import("./entry/chat.js");
      process.exit(await runCommand(args));
      return;
    }
    case "daemon": {
      const { daemonCommand } = await import("./entry/daemon.js");
      process.exit(await daemonCommand(args));
      return;
    }
    case "agent": {
      const { agentCommand } = await import("./entry/agentOps.js");
      process.exit(await agentCommand(args));
      return;
    }
    case "operator": {
      const { operatorCommand } = await import("./entry/operatorCmd.js");
      process.exit(await operatorCommand(args));
      return;
    }
    case "mind": {
      const { mindCommand } = await import("./entry/mindCmd.js");
      process.exit(await mindCommand(args));
      return;
    }
    case "garrison": {
      const { garrisonCommand } = await import("./entry/garrisonCmd.js");
      process.exit(await garrisonCommand(args));
      return;
    }
    case "attach": {
      const { attachCommand } = await import("./entry/garrisonCmd.js");
      process.exit(await attachCommand(args));
      return;
    }
    case "telegram": {
      const { telegramCommand } = await import("./entry/telegramWiring.js");
      process.exit(await telegramCommand(args));
      return;
    }
    case "holo": {
      const { holoCommand } = await import("./entry/holoCmd.js");
      process.exit(await holoCommand(args));
      return;
    }
    case "eval": {
      const { evalCommand } = await import("./entry/agentOps.js");
      process.exit(await evalCommand(args));
      return;
    }
    case "sessions": {
      const { sessionsCommand } = await import("./entry/introspect.js");
      process.exit(await sessionsCommand());
      return;
    }
    case "checkpoints": {
      const { checkpointsCommand } = await import("./entry/introspect.js");
      process.exit(await checkpointsCommand());
      return;
    }
    case "themes": {
      const { themesCommand } = await import("./entry/introspect.js");
      process.exit(themesCommand());
      return;
    }
    case "theme": {
      const selected = setTheme(args.positionals[0] ?? args.flags.get("name") ?? "");
      if (!selected) {
        process.stderr.write(`error: usage: ares theme <${availableThemes().join("|")}>\n`);
        process.exit(2);
      }
      const { saveTheme } = await import("./entry/terminalLines.js");
      await saveTheme(selected);
      process.stdout.write(themeChanged(selected));
      return;
    }
    case "resume": {
      const { resumeCommand } = await import("./entry/introspect.js");
      process.exit(await resumeCommand(args));
      return;
    }
    case "recap":
    case "whathappened": {
      const { recapCommand } = await import("./entry/introspect.js");
      process.exit(await recapCommand(args));
      return;
    }
    case "world": {
      const { worldCommand } = await import("./entry/introspect.js");
      process.exit(await worldCommand(args));
      return;
    }
    case "today":
    case "briefing": {
      const { todayCommand } = await import("./entry/introspect.js");
      process.exit(await todayCommand(args));
      return;
    }
    case "models": {
      const { modelsCommand } = await import("./entry/agentOps.js");
      process.exit(await modelsCommand(args));
      return;
    }
    case "mission": {
      const { missionCommand } = await import("./entry/agentOps.js");
      process.exit(await missionCommand(args));
      return;
    }
    case "login": {
      const { loginCommand } = await import("./entry/introspect.js");
      process.exit(await loginCommand());
      return;
    }
    case "doctor": {
      const { doctorCommand } = await import("./entry/introspect.js");
      process.exit(await doctorCommand());
      return;
    }
    case "friction": {
      const { frictionCommand } = await import("./entry/introspect.js");
      process.exit(await frictionCommand(args));
      return;
    }
    case "triage": {
      const { triageCommand } = await import("./entry/triage.js");
      process.exit(await triageCommand(args));
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      const { printHelp } = await import("./entry/runtime.js");
      await printHelp();
      return;
    }
    default:
      process.stderr.write(`error: unknown command "${args.command}". Run \`ares help\`.\n`);
      process.exit(2);
  }
}

async function applyWorkspaceFlag(flags: Map<string, string>): Promise<void> {
  const requested = flags.get("workspace") ?? flags.get("cwd");
  if (!requested) return;
  const target = path.resolve(process.cwd(), requested);
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) {
    process.stderr.write(`error: workspace is not a directory: ${target}\n`);
    process.exit(2);
  }
  process.chdir(target);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
