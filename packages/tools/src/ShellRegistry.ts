// ShellRegistry — session-owned foreground handles plus restart-durable
// background shell jobs. BashOutput polls; KillShell terminates.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BackgroundJobRecord, JsonValue, SessionKernelStore } from "@ares/core";
import { toolError } from "./_shared.js";
import type { ShellSupervisorManifest, ShellSupervisorState } from "./ShellSupervisor.js";

const MAX_BUFFER_CHARS = 200_000;
const MAX_DURABLE_POLL_BYTES = 200_000;
const SUPERVISOR_HEARTBEAT_STALE_MS = 30_000;
const SUPERVISOR_LAUNCH_TIMEOUT_MS = 5_000;

export interface ShellLaunchOptions {
  program: string;
  args: string[];
  cwd: string;
  description: string;
  /** Canonical owner. Required when durable persistence is enabled. */
  sessionId?: string;
  /** Stable parent tool-use identity. Replays address, never duplicate, a job. */
  invocationKey?: string;
  /** Soft timeout (kill after). Optional — backgrounded shells often run forever. */
  timeoutMs?: number;
}

export interface ShellSnapshot {
  id: string;
  description: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "errored" | "orphaned";
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  /** Total chars for legacy jobs; exact spool bytes for durable jobs. */
  totalChars: number;
  durable?: boolean;
  pid?: number | null;
  outputPath?: string;
  recovered?: boolean;
}

export interface ShellRegistryDurability {
  kernel: SessionKernelStore;
  workspace: string;
}

interface ShellState {
  id: string;
  child: ChildProcess;
  description: string;
  command: string;
  cwd: string;
  status: ShellSnapshot["status"];
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  buffer: Array<{ stream: "stdout" | "stderr"; text: string; ts: number }>;
  totalChars: number;
  cursors: Map<string, number>;
  events: EventEmitter;
}

export class ShellRegistry {
  private readonly shells = new Map<string, ShellState>();
  private readonly knownSessionIds = new Set<string>();
  private counter = 0;
  private durability?: ShellRegistryDurability;

  configureDurability(options: ShellRegistryDurability): this {
    const workspace = path.resolve(options.workspace);
    if (this.durability) {
      if (this.durability.kernel !== options.kernel || path.resolve(this.durability.workspace) !== workspace) {
        throw new Error("ShellRegistry durability cannot be rebound to another kernel/workspace");
      }
      return this;
    }
    this.durability = { kernel: options.kernel, workspace };
    return this;
  }

  /** Register one canonical session with this registry. This never shares jobs:
   * every durable lookup still predicates on the caller's session id. */
  registerSession(sessionId: string): void {
    if (sessionId.trim()) this.knownSessionIds.add(sessionId);
  }

  list(sessionId?: string): ShellSnapshot[] {
    if (this.durability && sessionId) {
      this.registerSession(sessionId);
      return this.durability.kernel
        .listBackgroundJobs(sessionId, { kind: "shell" })
        .map((job) => this.reconcileDurableJob(job))
        .map((job) => durableSnapshot(job, true));
    }
    return [...this.shells.values()].map(snapshot);
  }

  has(id: string, sessionId?: string): boolean {
    return this.get(id, sessionId) !== undefined;
  }

  get(id: string, sessionId?: string): ShellSnapshot | undefined {
    if (this.durability && sessionId) {
      this.registerSession(sessionId);
      const job = this.durability.kernel.getBackgroundJob(id);
      if (!job || job.kind !== "shell" || job.sessionId !== sessionId) return undefined;
      return durableSnapshot(this.reconcileDurableJob(job), true);
    }
    const state = this.shells.get(id);
    return state ? snapshot(state) : undefined;
  }

  async spawn(opts: ShellLaunchOptions): Promise<ShellSnapshot> {
    if (this.durability) {
      if (!opts.sessionId || !opts.invocationKey) {
        throw new Error("Durable background shells require sessionId and invocationKey");
      }
      this.registerSession(opts.sessionId);
      return this.spawnDurable(opts as ShellLaunchOptions & { sessionId: string; invocationKey: string });
    }
    return this.spawnLegacy(opts);
  }

  private async spawnDurable(
    opts: ShellLaunchOptions & { sessionId: string; invocationKey: string },
  ): Promise<ShellSnapshot> {
    const id = stableJobId("sh", opts.sessionId, opts.invocationKey);
    const prior = this.durability!.kernel.getBackgroundJob(id);
    if (prior) {
      if (prior.sessionId !== opts.sessionId || prior.kind !== "shell") {
        throw new Error(`background shell identity collision: ${id}`);
      }
      const reconciled = this.reconcileDurableJob(prior);
      if (reconciled.status !== "queued") return durableSnapshot(reconciled, true);
      // A queued record means the host died before launch confirmation. Its
      // token-bound state file is checked once more before a safe relaunch.
      const state = readSupervisorState(reconciled);
      if (state) return durableSnapshot(this.reconcileDurableJob(reconciled), true);
    }

    const token = prior?.processToken ?? randomUUID();
    const root = path.join(this.durability!.workspace, ".ares", "background-jobs", opts.sessionId);
    const statePath = prior?.statePath ?? path.join(root, `${id}.state.json`);
    const outputPath = prior?.outputPath ?? path.join(root, `${id}.output.log`);
    const manifestPath = path.join(root, `${id}.launch.json`);
    const request = {
      version: 1,
      program: opts.program,
      args: opts.args,
      cwd: opts.cwd,
      description: opts.description,
    } satisfies JsonValue;
    const created = prior ?? this.durability!.kernel.createBackgroundJob({
      id,
      sessionId: opts.sessionId,
      invocationKey: opts.invocationKey,
      kind: "shell",
      description: opts.description,
      request,
      processToken: token,
      statePath,
      outputPath,
    }).record;

    await mkdir(root, { recursive: true });
    const manifest: ShellSupervisorManifest = {
      version: 1,
      jobId: id,
      token: created.processToken!,
      program: opts.program,
      args: opts.args,
      cwd: opts.cwd,
      outputPath: created.outputPath!,
      statePath: created.statePath!,
      createdAtMs: created.createdAtMs,
    };
    await writeJsonAtomic(manifestPath, manifest);
    const supervisorPath = fileURLToPath(new URL("./ShellSupervisor.js", import.meta.url));
    const supervisor = spawn(process.execPath, [supervisorPath, manifestPath], {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      supervisor.once("spawn", resolve);
      supervisor.once("error", reject);
    }).catch((error: NodeJS.ErrnoException) => {
      this.durability!.kernel.settleBackgroundJob(id, {
        status: "failed",
        error: { message: error.message, code: error.code ?? null },
      });
      throw toolError(`Background shell supervisor failed to launch: ${error.code ?? error.message}`);
    });
    supervisor.unref();

    // Persist the supervisor pid immediately. If the host dies before its state
    // file arrives, restart can still distinguish "spawned" from "never ran".
    this.durability!.kernel.markBackgroundJobRunning(id, {
      pid: supervisor.pid ?? null,
      processToken: manifest.token,
      statePath: manifest.statePath,
      outputPath: manifest.outputPath,
      heartbeatAtMs: Date.now(),
    });
    const state = await waitForSupervisorState(created, SUPERVISOR_LAUNCH_TIMEOUT_MS);
    if (!state) {
      const alive = supervisor.pid ? processAlive(supervisor.pid) : false;
      if (!alive) {
        const failed = this.durability!.kernel.settleBackgroundJob(id, {
          status: "failed",
          error: { message: "Detached supervisor exited before publishing launch state" },
        });
        throw toolError(`Background shell failed to launch: ${failed.id}`);
      }
      // Process is proven live but its control plane is not ready. Keep the
      // durable running state; the next poll performs token/heartbeat recovery.
    }
    let job = this.reconcileDurableJob(this.durability!.kernel.getBackgroundJob(id)!);
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timer = setTimeout(() => void this.kill(id, "timeout", opts.sessionId), opts.timeoutMs);
      timer.unref();
    }
    job = this.durability!.kernel.getBackgroundJob(id) ?? job;
    return durableSnapshot(job, false);
  }

  private async spawnLegacy(opts: ShellLaunchOptions): Promise<ShellSnapshot> {
    const id = `sh_${(++this.counter).toString(36)}_${Date.now().toString(36)}`;
    const child = spawn(opts.program, opts.args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
    });
    const state: ShellState = {
      id,
      child,
      description: opts.description,
      command: `${opts.program} ${opts.args.join(" ")}`,
      cwd: opts.cwd,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      buffer: [],
      totalChars: 0,
      cursors: new Map(),
      events: new EventEmitter(),
    };
    const appendChunk = (stream: "stdout" | "stderr", buf: Buffer) => {
      const text = buf.toString("utf8");
      state.totalChars += text.length;
      state.buffer.push({ stream, text, ts: Date.now() });
      while (state.totalChars > MAX_BUFFER_CHARS && state.buffer.length > 1) {
        const removed = state.buffer.shift()!;
        state.totalChars -= removed.text.length;
        for (const [key, value] of state.cursors) state.cursors.set(key, Math.max(0, value - 1));
      }
      state.events.emit("data");
    };
    child.stdout?.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));
    child.on("error", () => {
      state.status = "errored";
      state.finishedAt = new Date().toISOString();
      state.events.emit("end");
    });
    child.on("close", (code) => {
      state.status = state.status === "killed" ? "killed" : "exited";
      state.exitCode = code;
      state.finishedAt = new Date().toISOString();
      state.events.emit("end");
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((error: NodeJS.ErrnoException) => {
      throw toolError(`Background shell failed to launch: ${error.code ?? error.message}`);
    });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timer = setTimeout(() => void this.kill(id, "timeout"), opts.timeoutMs);
      timer.unref();
    }
    this.shells.set(id, state);
    return snapshot(state);
  }

  /** Read all NEW output since this durable consumer last acknowledged bytes. */
  poll(id: string, cursorKey: string, filter?: RegExp, sessionId?: string): {
    snapshot: ShellSnapshot;
    output: string;
    newChunks: number;
  } | null {
    if (this.durability && sessionId) return this.pollDurable(id, cursorKey, filter, sessionId);
    const state = this.shells.get(id);
    if (!state) return null;
    const start = state.cursors.get(cursorKey) ?? 0;
    const chunks = state.buffer.slice(start);
    state.cursors.set(cursorKey, state.buffer.length);
    let text = chunks.map((chunk) => chunk.stream === "stderr" ? `[stderr] ${chunk.text}` : chunk.text).join("");
    if (filter) text = filterLines(text, filter);
    return { snapshot: snapshot(state), output: text, newChunks: chunks.length };
  }

  private pollDurable(id: string, cursorKey: string, filter: RegExp | undefined, sessionId: string): {
    snapshot: ShellSnapshot;
    output: string;
    newChunks: number;
  } | null {
    this.registerSession(sessionId);
    let job = this.durability!.kernel.getBackgroundJob(id);
    if (!job || job.kind !== "shell" || job.sessionId !== sessionId) return null;
    job = this.reconcileDurableJob(job);
    const outputPath = job.outputPath;
    if (!outputPath || !existsSync(outputPath)) {
      return { snapshot: durableSnapshot(job, true), output: "", newChunks: 0 };
    }
    const available = statSync(outputPath).size;
    this.durability!.kernel.updateBackgroundJobObservation(id, { outputBytes: available });
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = Math.min(this.durability!.kernel.getBackgroundJobCursor(id, cursorKey), available);
      const wanted = Math.min(MAX_DURABLE_POLL_BYTES, available - start);
      if (wanted <= 0) return { snapshot: durableSnapshot(job, true), output: "", newChunks: 0 };
      const fd = openSync(outputPath, "r");
      let bytesRead = 0;
      let buffer: Buffer;
      try {
        buffer = Buffer.allocUnsafe(wanted);
        bytesRead = readSync(fd, buffer, 0, wanted, start);
      } finally {
        closeSync(fd);
      }
      const safeBytes = completeUtf8Prefix(buffer.subarray(0, bytesRead));
      if (safeBytes === 0 && bytesRead > 0) continue;
      const end = start + safeBytes;
      const text = buffer.subarray(0, safeBytes).toString("utf8");
      if (!this.durability!.kernel.advanceBackgroundJobCursor(id, cursorKey, start, end)) continue;
      const rendered = filter ? filterLines(text, filter) : text;
      return {
        snapshot: durableSnapshot(this.durability!.kernel.getBackgroundJob(id) ?? job, true),
        output: rendered,
        newChunks: safeBytes > 0 ? 1 : 0,
      };
    }
    throw new Error(`background output cursor changed concurrently: ${id}/${cursorKey}`);
  }

  async kill(id: string, reason: "user" | "timeout" = "user", sessionId?: string): Promise<boolean> {
    if (this.durability && sessionId) return this.killDurable(id, reason, sessionId);
    const state = this.shells.get(id);
    if (!state || state.status !== "running") return false;
    void reason;
    const confirmed = await killProcessTree(state.child.pid, () => state.child.kill());
    if (confirmed && state.status === "running") {
      state.status = "killed";
      state.finishedAt = new Date().toISOString();
      state.events.emit("end");
    }
    return confirmed;
  }

  private async killDurable(id: string, reason: "user" | "timeout", sessionId: string): Promise<boolean> {
    this.registerSession(sessionId);
    let job = this.durability!.kernel.getBackgroundJob(id);
    if (!job || job.kind !== "shell" || job.sessionId !== sessionId) return false;
    job = this.reconcileDurableJob(job);
    if (isTerminalJob(job)) return false;
    this.durability!.kernel.requestBackgroundJobCancellation(id);
    const pid = job.pid;
    if (!pid) return false;
    const sent = await killProcessTree(pid, () => {
      try { process.kill(pid, "SIGTERM"); return true; } catch { return false; }
    });
    if (!sent) return false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = this.durability!.kernel.getBackgroundJob(id)!;
      const supervisorState = readSupervisorState(job);
      if (supervisorState && (supervisorState.phase === "completed" || supervisorState.phase === "failed" || supervisorState.phase === "cancelled")) {
        job = this.reconcileDurableJob(job);
        return job.status === "cancelled" || job.status === "failed";
      }
      if (!processAlive(pid)) {
        const outputBytes = job.outputPath && existsSync(job.outputPath) ? statSync(job.outputPath).size : job.outputBytes;
        this.settleShellJob(job, "cancelled", null, null, outputBytes);
        return true;
      }
    }
    // A proven-dead supervisor without a terminal file is explicit orphaned
    // state, never a fabricated successful kill.
    if (!processAlive(pid)) {
      this.durability!.kernel.settleBackgroundJob(id, {
        status: "orphaned",
        error: { message: `Supervisor died after ${reason} kill without terminal state` },
      });
    }
    return false;
  }

  /** Explicit destructive cleanup. Normal session disposal deliberately does
   * not call this: durable jobs are supposed to survive host restart. */
  async killAll(): Promise<number> {
    let count = 0;
    for (const id of [...this.shells.keys()]) if (await this.kill(id)) count++;
    if (this.durability) {
      for (const sessionId of this.knownSessionIds) {
        for (const job of this.durability.kernel.listBackgroundJobs(sessionId, { kind: "shell", statuses: ["queued", "running"] })) {
          if (await this.kill(job.id, "user", sessionId)) count++;
        }
      }
    }
    return count;
  }

  /** Forget only in-memory handles. Detached supervisors and durable ownership
   * remain untouched and are rediscovered by the next host. */
  detachAll(): void {
    this.shells.clear();
    this.knownSessionIds.clear();
  }

  private reconcileDurableJob(job: BackgroundJobRecord): BackgroundJobRecord {
    if (!this.durability || isTerminalJob(job)) return job;
    const state = readSupervisorState(job);
    const outputBytes = job.outputPath && existsSync(job.outputPath) ? statSync(job.outputPath).size : job.outputBytes;
    if (!state) {
      if (job.status === "running" && job.pid && !processAlive(job.pid)) {
        return this.settleShellJob(job, "orphaned", {
          message: "Background supervisor disappeared before publishing terminal state",
        }, null, outputBytes);
      }
      return this.durability.kernel.updateBackgroundJobObservation(job.id, { outputBytes });
    }
    this.durability.kernel.updateBackgroundJobObservation(job.id, {
      outputBytes,
      heartbeatAtMs: state.heartbeatAtMs,
      pid: state.supervisorPid,
    });
    if (state.phase === "completed") return this.settleShellJob(job, "completed", null, state.exitCode, outputBytes);
    if (state.phase === "failed") {
      return this.settleShellJob(job, "failed", { message: state.error ?? `Shell exited ${state.exitCode ?? "unknown"}` }, state.exitCode, outputBytes);
    }
    if (state.phase === "cancelled") return this.settleShellJob(job, "cancelled", null, state.exitCode, outputBytes);
    const fresh = Date.now() - state.heartbeatAtMs <= SUPERVISOR_HEARTBEAT_STALE_MS;
    if (!fresh || !processAlive(state.supervisorPid)) {
      return this.settleShellJob(job, "orphaned", {
        message: fresh
          ? "Background supervisor pid is no longer alive"
          : "Background supervisor heartbeat is stale; process identity cannot be proven",
      }, null, outputBytes);
    }
    return this.durability.kernel.markBackgroundJobRunning(job.id, {
      pid: state.supervisorPid,
      heartbeatAtMs: state.heartbeatAtMs,
    });
  }

  private settleShellJob(
    job: BackgroundJobRecord,
    status: "completed" | "failed" | "cancelled" | "orphaned",
    error: JsonValue | null,
    exitCode: number | null,
    outputBytes: number,
  ): BackgroundJobRecord {
    const tail = readTail(job.outputPath, 16_000);
    const text = [
      `[background shell ${job.id} ${status}${exitCode === null ? "" : ` (exit ${exitCode})`}]`,
      tail ? `Latest output:\n${tail}` : "No output was captured.",
      job.outputPath ? `Complete output: ${job.outputPath}` : "",
    ].filter(Boolean).join("\n");
    return this.durability!.kernel.settleBackgroundJob(job.id, {
      status,
      result: { shellId: job.id, status, exitCode, outputPath: job.outputPath, outputBytes },
      error,
      exitCode,
      outputBytes,
      completion: {
        id: stableJobId("input", job.sessionId, job.id, "completion"),
        idempotencyKey: `background-job:${job.id}:completion`,
        payload: {
          kind: "background-job-completion",
          jobId: job.id,
          content: [{ type: "text", text }],
        },
      },
    });
  }
}

function snapshot(state: ShellState): ShellSnapshot {
  return {
    id: state.id,
    description: state.description,
    command: state.command,
    cwd: state.cwd,
    status: state.status,
    exitCode: state.exitCode,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    totalChars: state.totalChars,
  };
}

function durableSnapshot(job: BackgroundJobRecord, recovered: boolean): ShellSnapshot {
  const request = job.request && typeof job.request === "object" && !Array.isArray(job.request)
    ? job.request as Record<string, JsonValue>
    : {};
  const program = typeof request.program === "string" ? request.program : "shell";
  const args = Array.isArray(request.args) ? request.args.filter((value): value is string => typeof value === "string") : [];
  const status: ShellSnapshot["status"] = job.status === "completed"
    ? "exited"
    : job.status === "cancelled"
      ? "killed"
      : job.status === "failed"
        ? "errored"
        : job.status === "orphaned"
          ? "orphaned"
          : "running";
  return {
    id: job.id,
    description: job.description,
    command: `${program} ${args.join(" ")}`,
    cwd: typeof request.cwd === "string" ? request.cwd : "",
    status,
    exitCode: job.exitCode,
    startedAt: new Date(job.startedAtMs ?? job.createdAtMs).toISOString(),
    ...(job.finishedAtMs ? { finishedAt: new Date(job.finishedAtMs).toISOString() } : {}),
    totalChars: job.outputBytes,
    durable: true,
    pid: job.pid,
    ...(job.outputPath ? { outputPath: job.outputPath } : {}),
    recovered,
  };
}

function readSupervisorState(job: BackgroundJobRecord): ShellSupervisorState | null {
  if (!job.statePath || !job.processToken) return null;
  try {
    const parsed = JSON.parse(readFileSync(job.statePath, "utf8")) as ShellSupervisorState;
    if (parsed.version !== 1 || parsed.jobId !== job.id || parsed.token !== job.processToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function waitForSupervisorState(job: BackgroundJobRecord, timeoutMs: number): Promise<ShellSupervisorState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readSupervisorState(job);
    if (state && state.phase !== "launching") return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return readSupervisorState(job);
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killProcessTree(pid: number | undefined, fallback: () => boolean): Promise<boolean> {
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      return await new Promise<boolean>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => {
          try { resolve(fallback()); } catch { resolve(false); }
        });
        killer.once("close", (code) => resolve(code === 0));
      });
    }
    try {
      process.kill(-pid, "SIGTERM");
      return true;
    } catch {
      return fallback();
    }
  } catch {
    return false;
  }
}

function filterLines(text: string, filter: RegExp): string {
  return text.split("\n").filter((line) => {
    filter.lastIndex = 0;
    return filter.test(line);
  }).join("\n");
}

function completeUtf8Prefix(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim++) {
    const length = buffer.length - trim;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      return length;
    } catch {
      // A partial final code point may require up to three bytes of trim.
    }
  }
  return buffer.length;
}

function readTail(filename: string | null, maxBytes: number): string {
  if (!filename || !existsSync(filename)) return "";
  const fd = openSync(filename, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  const temp = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, filename);
  } catch {
    await rm(filename, { force: true });
    await rename(temp, filename);
  }
}

function stableJobId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return `${prefix}_${hash.digest("hex").slice(0, 32)}`;
}

function isTerminalJob(job: BackgroundJobRecord): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "orphaned";
}
