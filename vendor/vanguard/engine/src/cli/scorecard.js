import { writeFile } from "node:fs/promises";
import { analyzeTrajectory, analyzePatch, scoreExecutionQuality, classifyOutcome, createStreamLifecyclePresenter, encodePublicRunEvent, } from "../index.js";
export async function writeScorecard(context) {
    const { session, options, outcome } = context;
    const events = await context.fileJournal.readValidated();
    const trajectory = analyzeTrajectory(events);
    const contracted = events.find((event) => event.type === "run.contracted")?.data;
    const contractedTask = contracted !== null && typeof contracted === "object" && !Array.isArray(contracted)
        && typeof contracted.task === "string" ? contracted.task : undefined;
    const task = options.task.length > 0 ? options.task : contractedTask ?? "";
    const patch = session.materialized
        ? await analyzePatch(session.sourceRoot, session.workspaceRoot)
        : emptyPatchMetrics();
    const verified = outcome.status === "completed";
    const classification = classifyOutcome(outcome);
    const executionQuality = scoreExecutionQuality(verified, trajectory, patch);
    const scorecard = {
        version: 3,
        sessionId: session.id,
        sourceRoot: session.sourceRoot,
        workspaceRoot: session.workspaceRoot,
        provider: options.provider,
        model: options.model,
        task,
        verification: options.verification,
        outcome,
        trajectory,
        patch,
        grade: {
            verified,
            classification,
            score: classification === "infrastructure_error" ? null : verified ? 1 : 0,
            executionQuality,
            steps: outcome.steps,
        },
        usage: context.usage?.usage() ?? null,
        estimatedCost: context.usage?.estimatedCost() ?? null,
        latency: context.usage?.latencyMs() ?? null,
        cacheEfficiency: context.usage?.cacheEfficiency() ?? null,
        durationMs: Date.now() - context.startedAt,
        journalFile: context.journalFile,
        completedAt: new Date().toISOString(),
        resumed: context.resumed,
        sessionFile: session.metadataFile,
        configurationFile: context.configurationFile,
        extensions: options.extensions ?? null,
        delegation: context.delegation ?? null,
    };
    await writeFile(context.scorecardFile, JSON.stringify(scorecard, null, 2));
    process.stdout.write(`${JSON.stringify({ ...scorecard, scorecardFile: context.scorecardFile }, null, 2)}\n`);
}
export function emptyPatchMetrics() {
    return {
        changedFiles: [],
        filesAdded: 0,
        filesDeleted: 0,
        filesModified: 0,
        beforeBytes: 0,
        afterBytes: 0,
        beforeLines: 0,
        afterLines: 0,
    };
}
export function printAdvanceOutcome(outcome, session, container, journalFile) {
    process.stdout.write(`${JSON.stringify({
        outcome,
        sessionId: session.id,
        sessionRoot: container,
        workspaceRoot: session.workspaceRoot,
        journalFile,
    }, null, 2)}\n`);
}
export function createStreamPresenter(markActivity) {
    return createStreamLifecyclePresenter(streamPublicEvent, markActivity);
}
export function combinedObserver(presenter, usage) {
    const ledger = usage.observer();
    return {
        started: (attempt) => presenter.started?.(attempt),
        delta: (text) => presenter.delta(text),
        thinking: (text) => presenter.thinking?.(text),
        activity: () => presenter.activity?.(),
        reset: () => presenter.reset?.(),
        committed: () => presenter.committed?.(),
        failed: (reason) => presenter.failed?.(reason),
        usage: (value) => {
            ledger.usage?.(value);
            presenter.usage?.(value);
        },
    };
}
export function streamPublicEvent(event) {
    if (process.env.VANGUARD_EVENT_STREAM !== "1")
        return;
    process.stderr.write(encodePublicRunEvent(event));
}
export function formatDuration(durationMs) {
    const seconds = Math.max(0, Math.floor(durationMs / 1_000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}
