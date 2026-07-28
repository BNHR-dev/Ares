import { type ContextPolicyPort, type TranscriptEntry } from "./contracts.js";
/** Raised instead of silently sending a request larger than the sealed budget. */
export declare class ContextBudgetExceededError extends Error {
    readonly requiredBytes: number;
    readonly budgetBytes: number;
    constructor(requiredBytes: number, budgetBytes: number);
}
export declare class StickyContextPolicy implements ContextPolicyPort {
    #private;
    private readonly options;
    /**
     * `retrievableEvidence` is set by the runtime that also offers
     * `read_evidence`, so compacted exchanges advertise retrieval only where the
     * tool exists — never inviting a call the runtime cannot serve.
     */
    constructor(options?: {
        readonly retrievableEvidence?: boolean;
    });
    select(task: string, transcript: readonly TranscriptEntry[], maxBytes: number, reservedTail?: readonly TranscriptEntry[]): readonly TranscriptEntry[];
}
