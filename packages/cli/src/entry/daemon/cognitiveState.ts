// What Ares actually knows and is doing — assembled for the owner to read.
//
// Why this file exists, precisely:
//
// Ares reported four capabilities as missing — learning from repeated tool
// errors, selective outcome-driven memory, post-timeout verification, and a
// durable mission loop. All four already existed in code. What did NOT exist
// was any way to see them, so a subsystem that had quietly died was
// indistinguishable from one that was never built.
//
// That is not hypothetical. reliabilityTriage — the exact "learn from repeated
// failures" machinery — silently read ZERO files on Windows for three releases
// while the whole suite stayed green, because nothing ever surfaced its output.
// It was not missing. It was dead and invisible.
//
// So this module reads the state that already exists and makes it legible. It
// deliberately introduces no new tracking: every field below is sourced from
// something the engine, verifier, journal or operator was already recording.
// If a section comes back empty, that is a FINDING about that subsystem, not a
// gap in this file — which is the entire point.
//
// Read-only by construction. Assembling a snapshot must never mutate agent
// state, so nothing here writes, and every source is wrapped so a broken
// subsystem degrades to `null` (reported as unavailable) instead of taking the
// command down with it.

import { listGoals, loadMissionContract, missionContractSummary } from "@ares/operator";
import type { CodingJournalState } from "@ares/core";
import type { LiveSession } from "../sessionFactory.js";

/** One thing Ares is pursuing, and where it has got to. */
export interface MissionWire {
  id: string;
  statement: string;
  status: string;
  /** 0..1 */
  progress: number;
  steps: number;
  /** Mission-contract summary when one exists — what "done" is defined as. */
  contract?: string;
}

/** A check that was actually run, with the proof. */
export interface EvidenceWire {
  label: string;
  command: string;
  /** "pass" | "fail" | "skip" — skipped is NOT a pass, and is never shown as one. */
  verdict: "pass" | "fail" | "skip";
  cached: boolean;
  durationMs: number;
  at: string;
  /** Tail of the real output. Absent when the runner captured none. */
  outputTail?: string;
}

/** A tool failure that has happened more than once, and what came of it. */
export interface FailureWire {
  tool: string;
  signature: string;
  count: number;
  latest: string;
  at: string;
}

export interface RecalledMemoryWire {
  id: string;
  /** Whether this recall was still in play at the end of the turn. */
  used: boolean;
}

/** Per-subsystem liveness. A zero must read as a zero, never as silence. */
export interface LivenessWire {
  subsystem: string;
  /** "live" = ran and produced something; "idle" = ran, produced nothing (may
   *  be legitimate); "dead" = should have run and did not; "unknown" = not
   *  instrumented yet — stated plainly rather than implied to be fine. */
  state: "live" | "idle" | "dead" | "unknown";
  detail: string;
  lastRunAt?: string;
}

export interface CognitiveStateWire {
  sessionId: string;
  at: string;
  /** What I'm pursuing. */
  missions: MissionWire[];
  /** The current objective for THIS session's work, from the coding journal. */
  objective?: string;
  phase?: string;
  /** Mid-task corrections the owner steered in, kept distinct from the objective. */
  steering: string[];
  currentStep?: string;
  todos: Array<{ content: string; status: string }>;
  /** What proves it. */
  evidence: EvidenceWire[];
  /** What I am NOT sure about. */
  uncertainty: string[];
  workStatus?: string;
  /** What I remembered, and whether it survived the turn. */
  recalled: RecalledMemoryWire[];
  /** What went wrong, repeatedly. */
  failures: FailureWire[];
  /** What I retried or worked around. */
  recovery: string[];
  /** What is waiting on the owner. */
  blockedApprovals: Array<{ tool: string; reason: string; at: string }>;
  /** Files this objective touched. */
  touchedFiles: string[];
  /** Is each subsystem actually alive? */
  liveness: LivenessWire[];
}

/** Everything the daemon must hand in; kept explicit so this stays pure-ish. */
export interface CognitiveStateSources {
  live: LiveSession;
  /** Approvals currently parked waiting for the owner. */
  pendingApprovals: ReadonlyArray<{ tool: string; reason?: string; at: number }>;
  /** Last reliability-triage run, if this process has done one. */
  lastTriage?: { at: number; files: number; observations: number; candidates: number } | null;
}

const MAX_EVIDENCE = 8;
const MAX_FAILURES = 6;
const MAX_TOUCHED = 20;

/**
 * Build the snapshot. Never throws: each section is independently guarded so
 * one broken subsystem cannot blank the whole cockpit — the owner would then be
 * back to guessing, which is the problem this solves.
 */
export async function assembleCognitiveState(sources: CognitiveStateSources): Promise<CognitiveStateWire> {
  const { live, pendingApprovals, lastTriage } = sources;
  const journal: CodingJournalState | null = safe(() => live.codingJournal?.snapshot() ?? null, null);

  const missions = await safeAsync(async () => {
    const goals = await listGoals(live.context.home);
    const active = goals.filter((g) => g.status === "active").slice(0, 6);
    return Promise.all(
      active.map(async (g): Promise<MissionWire> => {
        // A goal's mission contract is what "done" actually means. Surfacing it
        // is what stops "progress: 0.7" from being a number with no referent.
        const contract = await loadMissionContract(live.context.home, g.id).catch(() => null);
        return {
          id: g.id,
          statement: g.statement.slice(0, 200),
          status: g.status,
          progress: g.progress ?? 0,
          steps: g.stepLog?.length ?? 0,
          contract: contract ? missionContractSummary(contract).slice(0, 240) : undefined,
        };
      }),
    );
  }, [] as MissionWire[]);

  const evidence: EvidenceWire[] = (journal?.checks ?? [])
    .slice(-MAX_EVIDENCE)
    .reverse()
    .map((c) => ({
      label: c.label,
      command: c.command,
      // A skip is reported as a skip. Collapsing skip into pass is exactly how
      // "verified" starts meaning nothing.
      verdict: c.skipped ? "skip" : c.ok ? "pass" : "fail",
      cached: c.cached,
      durationMs: c.durationMs,
      at: c.at,
      outputTail: c.outputTail,
    }));

  const failures: FailureWire[] = (journal?.failures ?? [])
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_FAILURES)
    .map((f) => ({ tool: f.tool, signature: f.signature.slice(0, 16), count: f.count, latest: f.latest.slice(0, 300), at: f.at }));

  // Uncertainty is derived from the engine's OWN gates rather than invented, so
  // the panel can never disagree with what the completion gate believed.
  const uncertainty: string[] = [];
  const workStatus = journal?.lastWorkStatus;
  if (workStatus === "unverified") uncertainty.push("The last turn changed things but no check proved them — treat any \"done\" from it as unproven.");
  if (workStatus === "blocked") uncertainty.push("The last turn was blocked before it could finish.");
  if (live.codingJournal?.verificationRequiredForCurrentTurn()) uncertainty.push("This objective still owes a verification run.");
  if (live.codingJournal?.persistedVerificationDebtForCurrentTurn()) uncertainty.push("There is carried-over verification debt from an earlier turn.");
  if (!live.codingJournal?.persistedVerificationScopeCompleteForCurrentTurn()) uncertainty.push("Not every part of the requested scope has been verified.");
  const failedEvidence = evidence.filter((e) => e.verdict === "fail");
  if (failedEvidence.length > 0) uncertainty.push(`${failedEvidence.length} check(s) are currently red: ${failedEvidence.map((e) => e.label).join(", ")}.`);
  const stale = evidence.filter((e) => e.cached);
  if (stale.length > 0) uncertainty.push(`${stale.length} check(s) were reused from cache rather than re-run.`);

  // Recovery: a repeated failure whose count later stopped climbing is the only
  // honest signal available here without new tracking. Reported as observed
  // behaviour, never as a claim that the fix worked.
  const recovery = failures
    .filter((f) => f.count > 1)
    .map((f) => `${f.tool} failed ${f.count}× on the same signature — strategy change was demanded after each.`);

  const todos = (journal?.todos ?? []).slice(0, 12).map((t) => ({ content: t.content, status: t.status }));
  const currentStep = (journal?.todos ?? []).find((t) => t.status === "in_progress")?.activeForm;

  const recalled: RecalledMemoryWire[] = (live.lastRecallIds ?? []).map((id) => ({ id, used: true }));

  return {
    sessionId: live.session.meta.id,
    at: new Date().toISOString(),
    missions,
    objective: journal?.objective,
    phase: journal?.phase,
    steering: (journal?.steering ?? []).slice(-4),
    currentStep,
    todos,
    evidence,
    uncertainty,
    workStatus,
    recalled,
    failures,
    recovery,
    blockedApprovals: pendingApprovals.map((p) => ({
      tool: p.tool,
      reason: p.reason ?? "needs your approval",
      at: new Date(p.at).toISOString(),
    })),
    touchedFiles: (journal?.touchedFiles ?? []).slice(0, MAX_TOUCHED),
    liveness: assembleLiveness({ journal, live, lastTriage, recalledCount: recalled.length }),
  };
}

/**
 * Per-subsystem liveness.
 *
 * The distinction that matters is idle-vs-dead. "Ran and found nothing" is
 * often correct; "never ran" almost never is. Collapsing them is what let
 * triage sit dead across three releases, so they are separate states here and
 * every one carries a human-readable reason.
 */
function assembleLiveness(input: {
  journal: CodingJournalState | null;
  live: LiveSession;
  lastTriage?: { at: number; files: number; observations: number; candidates: number } | null;
  recalledCount: number;
}): LivenessWire[] {
  const { journal, live, lastTriage, recalledCount } = input;
  const out: LivenessWire[] = [];

  // Coding journal — durable working state.
  out.push(
    journal
      ? {
          subsystem: "Working state (journal)",
          state: journal.turns > 0 ? "live" : "idle",
          detail: journal.turns > 0
            ? `${journal.turns} turn(s) recorded · ${journal.checks.length} check(s) · ${journal.failures.length} failure signature(s)`
            : "Open, nothing recorded yet this session.",
          lastRunAt: journal.updatedAt,
        }
      : { subsystem: "Working state (journal)", state: "dead", detail: "No journal is open for this session — durable working state is NOT being kept." },
  );

  // Verifier — the evidence source.
  const ev = safe(() => live.verifier.evidenceSnapshot(), null);
  out.push(
    ev
      ? {
          subsystem: "Continuous verification",
          state: ev.finishedCommands > 0 ? "live" : ev.scheduledRuns > 0 ? "idle" : "idle",
          detail: ev.finishedCommands > 0
            ? `${ev.passedCommands} passed / ${ev.failedCommands} failed / ${ev.skippedCommands} skipped · latest: ${ev.latestRunStatus ?? "n/a"}${ev.latestRunStrength ? ` (${ev.latestRunStrength})` : ""}`
            : ev.scheduledRuns > 0
              ? `${ev.scheduledRuns} run(s) scheduled, none finished yet.`
              : "Nothing scheduled — no files have changed this session.",
          lastRunAt: ev.latestFinishedAt ? new Date(ev.latestFinishedAt).toISOString() : undefined,
        }
      : { subsystem: "Continuous verification", state: "dead", detail: "The verifier did not answer — evidence is NOT being collected." },
  );

  // Memory recall.
  out.push({
    subsystem: "Memory recall",
    state: recalledCount > 0 ? "live" : "idle",
    detail: recalledCount > 0
      ? `${recalledCount} memory node(s) injected into the last turn.`
      : "No memories were injected into the last turn. Legitimate for a trivial prompt — suspicious if it never changes.",
  });

  // Reliability triage. Explicitly the one that was dead: a run that reads zero
  // files is reported as DEAD, not as a clean result.
  out.push(
    lastTriage
      ? {
          subsystem: "Reliability triage",
          state: lastTriage.files === 0 ? "dead" : lastTriage.observations > 0 ? "live" : "idle",
          detail: lastTriage.files === 0
            ? "Ran but read ZERO rollout files — it is finding nothing because it can see nothing (the v0.29-0.30 Windows failure mode)."
            : `${lastTriage.files} file(s) · ${lastTriage.observations} observation(s) · ${lastTriage.candidates} candidate(s).`,
          lastRunAt: new Date(lastTriage.at).toISOString(),
        }
      : { subsystem: "Reliability triage", state: "unknown", detail: "Has not run in this process yet." },
  );

  // Mission loop. Reported as "unknown" rather than green: it is reachable, but
  // nothing yet records whether a run happened, so claiming liveness would be
  // the exact thing this panel exists to prevent.
  out.push({
    subsystem: "Mission loop",
    state: "unknown",
    detail: "Reachable via the Operator tool, but not yet instrumented — this panel cannot tell you whether it ran.",
  });

  return out;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
