import type { JsonValue } from "../kernel/contracts.js";
import { WorkspaceBoundary } from "../runtime/workspace.js";
import type { HookDeclaration, HookWhen } from "./config.js";
import { ExtensionPermissionPolicy } from "./customTools.js";
export interface ExtensionAuditEvent {
    readonly type: "hook.outcome" | "mcp.lifecycle";
    readonly name: string;
    readonly status: "passed" | "failed" | "timed-out" | "started" | "stopped";
    readonly detail: JsonValue;
}
export interface ExtensionAuditPort {
    record(event: ExtensionAuditEvent): Promise<void>;
}
/** Durable hash-chained audit for hook outcomes and MCP lifecycle events. */
export declare class FileExtensionAuditJournal implements ExtensionAuditPort {
    #private;
    readonly file: string;
    private constructor();
    static open(file: string): Promise<FileExtensionAuditJournal>;
    record(event: ExtensionAuditEvent): Promise<void>;
    readValidated(): Promise<readonly ExtensionAuditEvent[]>;
}
export interface HookOutcome {
    readonly hook: string;
    readonly when: HookWhen;
    readonly passed: boolean;
    readonly blocked: boolean;
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
}
/**
 * The call a tool-scoped hook is deciding about. Delivered on stdin as one
 * JSON line so a hook can inspect the actual arguments — without it a
 * `before-tool` hook could only ever block every call or none.
 */
export interface HookToolContext {
    readonly tool: string;
    readonly input: JsonValue;
    /** Present only for `after-tool`: the result the tool produced. */
    readonly ok?: boolean;
    readonly output?: JsonValue;
}
export declare class HookRunner {
    #private;
    private readonly workspace;
    private readonly policy;
    private readonly hooks;
    private readonly audit;
    private readonly maxOutputBytes;
    constructor(workspace: WorkspaceBoundary, policy: ExtensionPermissionPolicy, hooks: readonly HookDeclaration[], audit: ExtensionAuditPort, environment?: NodeJS.ProcessEnv, maxOutputBytes?: number);
    run(when: HookWhen, signal: AbortSignal, context?: HookToolContext): Promise<readonly HookOutcome[]>;
}
