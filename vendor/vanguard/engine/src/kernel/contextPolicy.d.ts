import { type ContextPolicyPort, type TranscriptEntry } from "./contracts.js";
export declare class EvidenceContextPolicy implements ContextPolicyPort {
    private readonly options;
    /** See StickyContextPolicy: retrieval is advertised only where the tool exists. */
    constructor(options?: {
        readonly retrievableEvidence?: boolean;
    });
    select(task: string, transcript: readonly TranscriptEntry[], maxBytes: number, reservedTail?: readonly TranscriptEntry[]): readonly TranscriptEntry[];
}
