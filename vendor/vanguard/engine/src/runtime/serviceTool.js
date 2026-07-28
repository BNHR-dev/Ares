import { spawn } from "node:child_process";
import { objectInput, optionalStringField, stringArrayField, stringField } from "./input.js";
import { sanitizedChildEnvironment } from "../engine/security.js";
import { asciiLowercase, compareOrdinal } from "../deterministicText.js";
import { terminateProcessTree } from "./processTree.js";
const DEFAULT_MAX_SERVICES = 3;
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 1_500;
const DEFAULT_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_LOG_RESPONSE_BYTES = 64 * 1024;
const MAX_READY_PATTERN = 200;
export class SupervisedProcessRegistry {
    workspace;
    #services = new Map();
    #options;
    #aliases;
    #deniedPrefixes;
    #deniedSubstrings;
    #environment;
    #allowed;
    #sequence = 0;
    constructor(workspace, options) {
        this.workspace = workspace;
        this.#allowed = new Set(options.allowedCommands.map(normalizeCommand));
        this.#aliases = new Map(Object.entries(options.commandAliases ?? {}).map(([name, alias]) => [normalizeCommand(name), alias]));
        this.#deniedPrefixes = options.deniedArgumentPrefixes ?? [];
        this.#deniedSubstrings = options.deniedArgumentSubstrings ?? [];
        this.#environment = options.environment ?? sanitizedChildEnvironment();
        this.#options = {
            allowedCommands: options.allowedCommands,
            maxServices: options.maxServices ?? DEFAULT_MAX_SERVICES,
            maxLogBytes: options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
            readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
            settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
            maxLifetimeMs: options.maxLifetimeMs ?? DEFAULT_LIFETIME_MS,
        };
    }
    allows(hostname, port) {
        if (!isLoopbackHost(hostname) || !Number.isInteger(port) || port <= 0)
            return false;
        for (const service of this.#services.values()) {
            if (service.exit === undefined && service.ports.has(port))
                return true;
        }
        return false;
    }
    live() {
        return [...this.#services.values()].filter((service) => service.exit === undefined);
    }
    snapshot() {
        return [...this.#services.values()]
            .sort((left, right) => compareOrdinal(left.handle, right.handle))
            .map((service) => describe(service));
    }
    async start(command, args, relativeCwd, readyPattern, signal) {
        const normalized = normalizeCommand(command);
        if (!this.#allowed.has(normalized)) {
            return {
                ok: false,
                output: {
                    error: "Command is not allowed as a service.",
                    command,
                    detail: "Services use the same allowlist as run_command; relaunch with --allow-command to widen it.",
                },
            };
        }
        const denied = args.find((argument) => this.#deniedPrefixes.some((prefix) => asciiLowercase(argument).startsWith(asciiLowercase(prefix))));
        if (denied !== undefined) {
            return { ok: false, output: { error: "Argument is blocked by process policy.", argument: denied } };
        }
        const deniedSubstring = this.#deniedSubstrings.find((substring) => args.some((argument) => asciiLowercase(argument).includes(asciiLowercase(substring))));
        if (deniedSubstring !== undefined) {
            return { ok: false, output: { error: "Argument contains a construct blocked by process policy.", construct: deniedSubstring } };
        }
        if (readyPattern !== undefined && readyPattern.length > MAX_READY_PATTERN) {
            return { ok: false, output: { error: `readyPattern may not exceed ${MAX_READY_PATTERN} characters.` } };
        }
        let ready;
        if (readyPattern !== undefined) {
            try {
                ready = new RegExp(readyPattern, "iu");
            }
            catch {
                return { ok: false, output: { error: "readyPattern is not a valid regular expression." } };
            }
        }
        if (this.live().length >= this.#options.maxServices) {
            return {
                ok: false,
                output: {
                    error: `At most ${this.#options.maxServices} services may run at once.`,
                    running: this.snapshot(),
                    guidance: "Stop one you no longer need before starting another.",
                },
            };
        }
        const cwd = await this.workspace.existing(relativeCwd);
        const alias = this.#aliases.get(normalized);
        const executable = alias?.executable ?? command;
        const argv = [...(alias?.argsPrefix ?? []), ...args];
        this.#sequence += 1;
        const handle = `service-${this.#sequence}`;
        const child = spawn(executable, argv, {
            cwd,
            shell: false,
            windowsHide: true,
            env: this.#environment,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const service = {
            handle,
            command: executable,
            args: argv,
            cwd,
            child,
            startedAt: Date.now(),
            ready: false,
            readyDetail: "",
            exit: undefined,
            log: Buffer.alloc(0),
            droppedBytes: 0,
            lastOutputAt: Date.now(),
            ports: new Set(),
            lifetimeTimer: undefined,
            stopping: false,
            containmentUncertain: false,
        };
        this.#services.set(handle, service);
        let settleTimer;
        let resolveReady;
        const readyRace = new Promise((resolve) => { resolveReady = resolve; });
        const settle = () => {
            if (settleTimer !== undefined)
                clearTimeout(settleTimer);
            settleTimer = setTimeout(() => resolveReady?.("ready"), this.#options.settleMs);
        };
        const append = (chunk) => {
            service.lastOutputAt = Date.now();
            for (const port of discoverPorts(chunk.toString("utf8")))
                service.ports.add(port);
            const combined = Buffer.concat([service.log, chunk]);
            if (combined.byteLength > this.#options.maxLogBytes) {
                const overflow = combined.byteLength - this.#options.maxLogBytes;
                service.droppedBytes += overflow;
                service.log = combined.subarray(overflow);
            }
            else {
                service.log = combined;
            }
            if (ready === undefined)
                settle();
            else if (ready.test(service.log.toString("utf8")))
                resolveReady?.("ready");
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.on("error", (error) => {
            append(Buffer.from(`\n[spawn error] ${error.message}\n`));
            service.exit = { code: null, signal: "", at: Date.now() };
            resolveReady?.("exited");
        });
        child.on("close", (code, closeSignal) => {
            service.exit = { code, signal: closeSignal ?? "", at: Date.now() };
            resolveReady?.("exited");
        });
        if (ready === undefined)
            settle();
        const readyTimer = setTimeout(() => resolveReady?.("timeout"), this.#options.readyTimeoutMs);
        const onAbort = () => resolveReady?.("timeout");
        signal.addEventListener("abort", onAbort, { once: true });
        let outcome;
        try {
            outcome = await readyRace;
        }
        finally {
            clearTimeout(readyTimer);
            if (settleTimer !== undefined)
                clearTimeout(settleTimer);
            signal.removeEventListener("abort", onAbort);
        }
        if (outcome === "exited") {
            this.#services.delete(handle);
            return {
                ok: false,
                output: {
                    error: "The service exited during startup.",
                    command: executable,
                    exitCode: service.exit?.code ?? -1,
                    signal: service.exit?.signal ?? "",
                    output: service.log.toString("utf8").slice(-8_000),
                },
            };
        }
        service.ready = outcome === "ready";
        service.readyDetail = outcome === "ready"
            ? (ready === undefined ? "running and settled" : "ready pattern matched")
            : `no ready signal within ${this.#options.readyTimeoutMs}ms`;
        service.lifetimeTimer = setTimeout(() => { void this.stop(handle); }, this.#options.maxLifetimeMs);
        service.lifetimeTimer.unref?.();
        return {
            ok: true,
            output: {
                ...describe(service),
                output: service.log.toString("utf8").slice(-8_000),
                ...(service.ports.size === 0
                    ? {}
                    : { reachable: [...service.ports].sort((a, b) => a - b).map((port) => `http://127.0.0.1:${port}`) }),
            },
        };
    }
    status(handle) {
        const service = this.#services.get(handle);
        if (service === undefined)
            return { ok: false, output: { error: `No service '${handle}'.`, running: this.snapshot() } };
        return { ok: true, output: describe(service) };
    }
    logs(handle, offset, maxBytes) {
        const service = this.#services.get(handle);
        if (service === undefined)
            return { ok: false, output: { error: `No service '${handle}'.`, running: this.snapshot() } };
        const total = service.log.byteLength;
        if (offset > total)
            return { ok: false, output: { error: `offset ${offset} is past the retained log (${total} bytes).` } };
        const slice = service.log.subarray(offset, offset + Math.min(maxBytes, MAX_LOG_RESPONSE_BYTES));
        const nextOffset = offset + slice.byteLength;
        return {
            ok: true,
            output: {
                handle,
                running: service.exit === undefined,
                retainedBytes: total,
                droppedBytes: service.droppedBytes,
                offset,
                returnedBytes: slice.byteLength,
                truncated: nextOffset < total,
                ...(nextOffset < total ? { nextOffset } : {}),
                output: slice.toString("utf8"),
            },
        };
    }
    async stop(handle) {
        const service = this.#services.get(handle);
        if (service === undefined)
            return { ok: false, output: { error: `No service '${handle}'.`, running: this.snapshot() } };
        const closed = await this.#terminate(service);
        return {
            ok: !service.containmentUncertain,
            output: {
                handle,
                stopped: true,
                directChildClosed: closed,
                exitCode: service.exit?.code ?? null,
                uptimeMs: (service.exit?.at ?? Date.now()) - service.startedAt,
                ...(service.containmentUncertain
                    ? { error: "Service stop could not prove tree closure.", containmentUncertain: true }
                    : {}),
            },
        };
    }
    async stopAll() {
        const stopped = [];
        for (const service of this.live()) {
            await this.#terminate(service);
            stopped.push(service.handle);
        }
        return stopped;
    }
    async #terminate(service) {
        if (service.exit !== undefined)
            return true;
        if (service.stopping)
            return service.exit !== undefined;
        service.stopping = true;
        if (service.lifetimeTimer !== undefined)
            clearTimeout(service.lifetimeTimer);
        const closed = await terminateProcessTree(service.child, () => service.exit !== undefined);
        if (!closed) {
            service.containmentUncertain = true;
            service.exit ??= { code: null, signal: "", at: Date.now() };
        }
        return closed;
    }
}
function describe(service) {
    return {
        handle: service.handle,
        command: service.command,
        args: [...service.args],
        running: service.exit === undefined,
        ready: service.ready,
        readyDetail: service.readyDetail,
        uptimeMs: (service.exit?.at ?? Date.now()) - service.startedAt,
        retainedLogBytes: service.log.byteLength,
        droppedLogBytes: service.droppedBytes,
        ports: [...service.ports].sort((a, b) => a - b),
        ...(service.exit === undefined ? {} : { exitCode: service.exit.code, signal: service.exit.signal }),
        ...(service.containmentUncertain ? { containmentUncertain: true } : {}),
    };
}
export class ServiceTool {
    registry;
    name = "run_service";
    definition = {
        name: this.name,
        description: "Start and manage a long-running process (development server, watcher) that run_command refuses. "
            + "start blocks until the service is ready or fails, and returns a handle; use logs to read its output, "
            + "status to check it, and stop when done. Every service is killed with its whole process tree at session end. "
            + "Once a service reports a port, fetch_url may reach it on 127.0.0.1.",
        inputSchema: {
            type: "object",
            properties: {
                operation: { type: "string", enum: ["start", "status", "logs", "stop", "list"] },
                command: { type: "string", description: "start: allowlisted executable." },
                args: { type: "array", items: { type: "string" }, description: "start: argument vector; no shell parsing." },
                cwd: { type: "string", description: "start: workspace-relative working directory." },
                readyPattern: {
                    type: "string",
                    description: "start: case-insensitive regex that marks readiness in the service's output, e.g. 'listening on'.",
                },
                handle: { type: "string", description: "status/logs/stop: the handle returned by start." },
                offset: { type: "integer", minimum: 0, description: "logs: byte offset for paging." },
                maxBytes: { type: "integer", minimum: 256, maximum: MAX_LOG_RESPONSE_BYTES, description: "logs: response cap." },
            },
            required: ["operation"],
            additionalProperties: false,
        },
        effect: "execute",
        evidenceAuthority: "independent-execution",
    };
    constructor(registry) {
        this.registry = registry;
    }
    async execute(input, context) {
        try {
            const fields = objectInput(input);
            const operation = stringField(fields, "operation");
            if (operation === "list")
                return { ok: true, output: { services: this.registry.snapshot() } };
            if (operation === "start") {
                return this.registry.start(stringField(fields, "command"), stringArrayField(fields, "args"), optionalStringField(fields, "cwd") ?? ".", optionalStringField(fields, "readyPattern"), context.signal);
            }
            const handle = stringField(fields, "handle");
            if (operation === "status")
                return this.registry.status(handle);
            if (operation === "stop")
                return this.registry.stop(handle);
            if (operation === "logs") {
                const offset = integerField(fields, "offset") ?? 0;
                const maxBytes = integerField(fields, "maxBytes") ?? MAX_LOG_RESPONSE_BYTES;
                return this.registry.logs(handle, offset, maxBytes);
            }
            return { ok: false, output: { error: `Unknown operation '${operation}'.` } };
        }
        catch (error) {
            return { ok: false, output: { error: error instanceof Error ? error.message : String(error) } };
        }
    }
}
function integerField(input, name) {
    const value = input[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Field '${name}' must be a non-negative integer.`);
    }
    return value;
}
function discoverPorts(text) {
    const ports = [];
    for (const match of text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]|:):?(\d{2,5})\b/giu)) {
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0 && port <= 65_535)
            ports.push(port);
    }
    return ports;
}
function isLoopbackHost(hostname) {
    const normalized = asciiLowercase(hostname).replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
function normalizeCommand(command) {
    return process.platform === "win32" ? asciiLowercase(command.trim()) : command.trim();
}
