import { type ChildProcess } from "node:child_process";
import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import { WorkspaceBoundary } from "./workspace.js";
export interface SupervisedServiceOptions {
    readonly allowedCommands: readonly string[];
    readonly commandAliases?: Readonly<Record<string, {
        readonly executable: string;
        readonly argsPrefix: readonly string[];
    }>>;
    readonly deniedArgumentPrefixes?: readonly string[];
    readonly deniedArgumentSubstrings?: readonly string[];
    readonly maxServices?: number;
    readonly maxLogBytes?: number;
    readonly readyTimeoutMs?: number;
    readonly settleMs?: number;
    /** A service can never outlive its run; defaults to two hours. */
    readonly maxLifetimeMs?: number;
    readonly environment?: NodeJS.ProcessEnv;
}
interface ServiceRecord {
    readonly handle: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly child: ChildProcess;
    readonly startedAt: number;
    ready: boolean;
    readyDetail: string;
    exit: {
        readonly code: number | null;
        readonly signal: string;
        readonly at: number;
    } | undefined;
    log: Buffer;
    droppedBytes: number;
    lastOutputAt: number;
    readonly ports: Set<number>;
    lifetimeTimer: NodeJS.Timeout | undefined;
    stopping: boolean;
    containmentUncertain: boolean;
}
/** Loopback reachability derived from what the supervisor actually started. */
export interface LoopbackAllowance {
    allows(hostname: string, port: number): boolean;
}
export declare class SupervisedProcessRegistry implements LoopbackAllowance {
    #private;
    private readonly workspace;
    constructor(workspace: WorkspaceBoundary, options: SupervisedServiceOptions);
    /**
     * True only for a loopback host on a port a live service is actually
     * listening on. The allowance derives from the supervisor's own registry,
     * never from the model's request, so the default-deny network posture holds:
     * the model cannot ask to reach 127.0.0.1:22, it can only reach a port
     * Vanguard itself started.
     */
    allows(hostname: string, port: number): boolean;
    live(): readonly ServiceRecord[];
    snapshot(): JsonValue;
    start(command: string, args: readonly string[], relativeCwd: string, readyPattern: string | undefined, signal: AbortSignal): Promise<ToolResult>;
    status(handle: string): ToolResult;
    logs(handle: string, offset: number, maxBytes: number): ToolResult;
    stop(handle: string): Promise<ToolResult>;
    /** Stops every live service. Used before sealed verification and at session end. */
    stopAll(): Promise<readonly string[]>;
}
export declare class ServiceTool implements ToolPort {
    private readonly registry;
    readonly name = "run_service";
    readonly definition: ToolDefinition;
    constructor(registry: SupervisedProcessRegistry);
    execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}
export {};
