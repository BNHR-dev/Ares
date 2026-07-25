import type { JsonValue } from "../kernel/contracts.js";
import { type CommandSpec } from "../runtime/projectVerification.js";
import { type SecurityProfile } from "../index.js";
export interface CliOptions {
    readonly workspace: string;
    readonly task: string;
    readonly provider: "openai" | "anthropic" | "deepseek" | "kimi" | "ollama" | "openai-compatible" | "http";
    /** Environment variable naming the API key for an openai-compatible endpoint. */
    readonly credentialVariable?: string;
    readonly model: string;
    /** Credential source. Defaults to the provider's API-key environment variable. */
    readonly auth?: "api-key" | "oauth";
    /** Runtime-enforced capability profile for delegated children. */
    readonly agentProfile: "coder" | "explore" | "plan";
    /** What the pre-claim gate accepts after a mutation. Defaults to independent execution. */
    readonly executionEvidence?: "independent" | "syntax";
    readonly endpoint?: string;
    readonly verification: CommandSpec;
    readonly adaptiveVerification?: boolean;
    readonly allowedCommands: readonly string[];
    readonly maxSteps: number;
    readonly maxDurationMs: number;
    readonly commandTimeoutMs: number;
    readonly commandIdleTimeoutMs?: number;
    /** Reasoning depth for OpenAI and Kimi; defaults to medium (env: VANGUARD_REASONING_EFFORT). "max" is Kimi's unbounded ceiling; OpenAI clamps it to high. */
    readonly reasoningEffort?: "low" | "medium" | "high" | "max";
    readonly maxContextBytes: number;
    readonly maxFailedVerificationAttempts: number;
    readonly protectedPaths: readonly string[];
    readonly editableRoots: readonly string[];
    readonly securityProfile?: SecurityProfile;
    readonly restrictProcess: boolean;
    readonly verifierEvidence: "full" | "summary";
    readonly publicCheck?: CommandSpec;
    readonly exposeRawProcess: boolean;
    readonly disableExtensions: boolean;
    readonly extensions?: JsonValue;
    readonly extensionInstructions?: string;
}
export declare function parseArgumentMap(args: readonly string[]): Map<string, string[]>;
export declare function parseOptions(args: readonly string[], behavior?: {
    requireTask?: boolean;
}): Promise<CliOptions>;
export declare function resolveTaskInput(values: ReadonlyMap<string, string[]>, requiredTask: boolean): Promise<string>;
export declare function readRunConfiguration(file: string): Promise<CliOptions>;
export declare function parseResumeSession(args: readonly string[]): string;
/**
 * In-place mode is an explicit opt-in: the agent edits the real project tree
 * directly and the session copy becomes the pristine review/undo baseline.
 */
export declare function inPlaceRequested(args: readonly string[]): boolean;
/**
 * Direct mode edits the launch directory with no fingerprint, no session copy,
 * and no baseline — the zero-ceremony mode. Implies in-place.
 */
export declare function directRequested(args: readonly string[]): boolean;
/**
 * Isolated mode (disposable copy) is the fallback, and can be forced when a
 * clean git repository would otherwise default to direct.
 */
export declare function isolatedRequested(args: readonly string[]): boolean;
/**
 * Workspace mode resolution: explicit flags/env win first. With no explicit
 * choice, a clean git repository already provides review (git diff), undo
 * (git checkout), and a drift baseline, so Vanguard skips the copy and
 * fingerprint tax and works direct. Anything else keeps the isolated copy.
 */
export declare function sessionModeFor(args: readonly string[], workspace: string): Promise<{
    inPlace?: boolean;
    direct?: boolean;
}>;
export declare function requiredArgument(args: readonly string[], name: string): string;
export declare function commandAliases(workspaceRoot: string, restricted: boolean, writableRoots: readonly string[]): Record<string, {
    executable: string;
    argsPrefix: string[];
}>;
export declare function parseBoolean(value: string, name: string): boolean;
export declare function parseSecurityProfile(value: string): SecurityProfile;
export declare function parseEvidenceMode(value: string): "full" | "summary";
export declare function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number;
export declare function required(values: ReadonlyMap<string, string[]>, name: string): string;
export declare function single(values: ReadonlyMap<string, string[]>, name: string): string | undefined;
export declare function printUsage(): void;
