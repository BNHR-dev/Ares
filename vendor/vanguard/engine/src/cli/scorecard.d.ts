import type { JsonValue } from "../kernel/contracts.js";
import type { RunOutcome } from "../kernel/run.js";
import { analyzePatch, encodePublicRunEvent, UsageLedger, type CodingSession, type FileJournal, type StreamObserver } from "../index.js";
import type { CliOptions } from "./options.js";
export interface ScorecardContext {
    readonly session: CodingSession;
    readonly options: CliOptions;
    readonly outcome: RunOutcome;
    readonly fileJournal: FileJournal;
    readonly scorecardFile: string;
    readonly journalFile: string;
    readonly configurationFile: string;
    readonly startedAt: number;
    readonly resumed: boolean;
    readonly usage?: UsageLedger | undefined;
    readonly delegation?: JsonValue | undefined;
}
export declare function writeScorecard(context: ScorecardContext): Promise<void>;
export declare function emptyPatchMetrics(): Awaited<ReturnType<typeof analyzePatch>>;
export declare function printAdvanceOutcome(outcome: RunOutcome, session: CodingSession, container: string, journalFile: string): void;
export declare function createStreamPresenter(markActivity: () => void): StreamObserver;
/** Merges the public-event stream presenter with usage accounting. */
export declare function combinedObserver(presenter: StreamObserver, usage: UsageLedger): StreamObserver;
export declare function streamPublicEvent(event: Parameters<typeof encodePublicRunEvent>[0]): void;
export declare function formatDuration(durationMs: number): string;
