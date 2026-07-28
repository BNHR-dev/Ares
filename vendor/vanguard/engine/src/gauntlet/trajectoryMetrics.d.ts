import type { RunEvent } from "../kernel/contracts.js";
export interface TrajectoryMetrics {
    readonly modelDecisions: number;
    readonly toolCalls: number;
    readonly toolFailures: number;
    readonly localTestFailures: number;
    readonly testHarnessFailures: number;
    readonly toolFrictionFailures: number;
    readonly completionClaims: number;
    readonly verificationAttempts: number;
    readonly verificationFailures: number;
    readonly policyBlocks: number;
    /** Durable/logical history rewrites. Legacy unclassified events count here. */
    readonly contextCompactions: number;
    /** Per-request bounded views that leave durable/logical history unchanged. */
    readonly contextProjections: number;
    readonly recoveryDecisions: number;
    readonly retriesScheduled: number;
    readonly retriesExhausted: number;
    readonly replansRequired: number;
    readonly recoveryDelayMs: number;
    readonly failuresByCode: Readonly<Record<string, number>>;
    readonly failuresByDisposition: Readonly<Record<string, number>>;
    readonly toolCallsByName: Readonly<Record<string, number>>;
    /**
     * What the model was actually sent, measured rather than assumed. Long-run
     * degradation is a context-composition problem, and "machinery crowded out
     * the evidence" and "evidence crowded out the contract" look identical from
     * the outside while wanting opposite fixes.
     */
    readonly context?: ContextCompositionMetrics;
}
export interface ContextCompositionMetrics {
    readonly samples: number;
    readonly meanSelectedBytes: number;
    readonly maxSelectedBytes: number;
    /** Mean share of the projected request, 0-1, keyed by transcript role. */
    readonly meanShareByRole: Readonly<Record<string, number>>;
    /** Peak fraction of the learned context budget any single request used. */
    readonly maxBudgetUtilization: number;
}
export declare function analyzeTrajectory(events: readonly RunEvent[]): TrajectoryMetrics;
