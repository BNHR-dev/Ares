import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { aresHome } from "./providers/openaiAuth.js";
import {
  REPOSITORY_INSTRUCTION_FILES,
  type RepositoryInstructionClaim,
} from "./repositoryInstructions.js";

export type StartupReminderSource = "memory" | "instructions";

export interface StartupReminder {
  text: string;
  source: StartupReminderSource;
  /** Canonical files whose contents this reminder already put in the Session's
   * model context. QueryEngine claims them before path-sensitive discovery. */
  instructionClaims?: RepositoryInstructionClaim[];
}

const MAX_CONTEXT_CHARS = 24_000;

export async function loadStartupReminders(workspace: string): Promise<StartupReminder[]> {
  const reminders: StartupReminder[] = [];
  reminders.push(...(await loadMemoryReminders(workspace)));
  reminders.push(...(await loadInstructionReminders(workspace)));
  return reminders;
}

export async function loadMemoryReminders(workspace: string): Promise<StartupReminder[]> {
  const files = [
    { label: "global memory", file: path.join(aresHome(), "memory.md") },
    { label: "project memory", file: path.join(workspace, ".ares", "memory.md") },
  ];
  const reminders: StartupReminder[] = [];
  for (const entry of files) {
    const text = await readSmallText(entry.file);
    if (!text) continue;
    reminders.push({
      source: "memory",
      text: `Loaded ${entry.label} from ${entry.file}:\n\n${text}`,
    });
  }
  return reminders;
}

export async function loadInstructionReminders(workspace: string): Promise<StartupReminder[]> {
  const reminders: StartupReminder[] = [];
  for (const dir of ancestorDirs(path.resolve(workspace))) {
    for (const name of REPOSITORY_INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      const text = await readSmallText(file);
      if (!text) continue;
      const contentHash = await fs.readFile(file)
        .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
        .catch(() => null);
      if (!contentHash) continue;
      reminders.push({
        source: "instructions",
        text: `Loaded project instructions from ${file} [sha256:${contentHash}]:\n\n${text}`,
        instructionClaims: [{ path: path.resolve(file), contentHash }],
      });
    }
  }
  return reminders;
}

async function readSmallText(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) return null;
    const text = await fs.readFile(file, "utf8");
    return text.length > MAX_CONTEXT_CHARS
      ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[truncated: ${text.length - MAX_CONTEXT_CHARS} chars omitted]`
      : text;
  } catch {
    return null;
  }
}

function ancestorDirs(workspace: string): string[] {
  const dirs: string[] = [];
  let current = path.parse(workspace).root;
  const parts = path.relative(current, workspace).split(path.sep).filter(Boolean);
  dirs.push(current);
  for (const part of parts) {
    current = path.join(current, part);
    dirs.push(current);
  }
  return dirs;
}
