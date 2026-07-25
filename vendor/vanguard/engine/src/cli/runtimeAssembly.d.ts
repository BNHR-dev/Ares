import type { JsonValue, UserChannelPort } from "../kernel/contracts.js";
import type { AgentKernel as AgentKernelType, RunOutcome } from "../kernel/run.js";
import { FileJournal, WorkspaceMutationPolicy, UsageLedger, type CodingSession } from "../index.js";
import { type CliOptions } from "./options.js";
export interface ExecutionRuntime {
    readonly kernel: AgentKernelType;
    readonly mutationPolicyDescription: string;
    /** Extension-derived task augmentation (skills, instructions) for direct-run tasks. */
    readonly taskAugmentation?: string;
    readonly journalActivity: () => number;
    readonly usage?: UsageLedger;
    readonly dispose?: () => Promise<void>;
    readonly delegationSnapshot?: () => JsonValue;
}
export declare function buildConversationRuntime(session: CodingSession, options: CliOptions, fileJournal: FileJournal, userChannel: UserChannelPort | undefined): ExecutionRuntime;
export declare function buildExecutionRuntime(session: CodingSession, options: CliOptions, fileJournal: FileJournal, interactive: boolean, userChannel?: UserChannelPort): Promise<ExecutionRuntime>;
export declare function taskAddendum(options: CliOptions, mutationPolicy: WorkspaceMutationPolicy): string;
export declare function runWithBudgets(options: CliOptions, journalActivity: () => number, controller: AbortController, run: (signal: AbortSignal) => Promise<RunOutcome>): Promise<RunOutcome>;
