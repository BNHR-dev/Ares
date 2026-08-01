import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  Session,
  SessionNotFoundError,
  deleteSession,
  listSessions,
  loadSessionRollout,
  loadSessionSnapshot,
  openWorkspaceSessionKernel,
  renameSession,
} from "../packages/core/dist/index.js";

const createdAt = "2026-01-02T03:04:05.000Z";

function message(id, role, text) {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    createdAt,
  };
}

function fenceOf(lease) {
  return {
    sessionId: lease.sessionId,
    generation: lease.generation,
    leaseToken: lease.leaseToken,
  };
}

function appendConversation(kernel, sessionId, userText, assistantText) {
  const lease = kernel.acquireRunnerLease(sessionId, `seed-${sessionId}`, 5_000);
  const fence = fenceOf(lease);
  kernel.appendMessage(fence, {
    id: `${sessionId}-user`,
    role: "user",
    parts: [{ type: "text", data: { type: "text", text: userText } }],
  });
  kernel.appendMessage(fence, {
    id: `${sessionId}-assistant`,
    role: "assistant",
    model: "canonical-model",
    parts: [{ type: "text", data: { type: "text", text: assistantText } }],
  });
  kernel.releaseRunnerLease(fence, {
    executionState: "completed",
    workOutcome: "not_applicable",
  });
}

async function writeLegacySession(workspace, sessionId, userText, provider = "legacy-provider") {
  const dir = path.join(workspace, ".ares", "sessions", sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({
    id: sessionId,
    workspace,
    provider: { name: provider, model: "legacy-model" },
    createdAt,
    label: `label-${sessionId}`,
  }), "utf8");
  const user = message(`${sessionId}-legacy-user`, "user", userText);
  const assistant = message(`${sessionId}-legacy-assistant`, "assistant", "legacy answer");
  const entries = [
    { seq: 4, ts: createdAt, event: { type: "turn_start", turnId: "legacy-turn", sessionId, userMessage: user } },
    { seq: 5, ts: createdAt, event: { type: "message_done", message: assistant } },
  ];
  await fs.writeFile(
    path.join(dir, "events.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return dir;
}

test("canonical list and resume ignore stale or absent JSON sidecars", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-canonical-authority-"));
  const kernel = await openWorkspaceSessionKernel(workspace);
  try {
    kernel.createSession({
      id: "canonical-stale",
      workspaceKey: workspace,
      title: "Canonical title",
      metadata: { provider: "canonical-provider", model: "canonical-model", createdAt },
    });
    appendConversation(kernel, "canonical-stale", "canonical prompt", "canonical answer");
    const canonicalEventCount = kernel.countEvents("canonical-stale");

    await writeLegacySession(workspace, "canonical-stale", "STALE JSON PROMPT", "stale-provider");

    kernel.createSession({
      id: "canonical-no-sidecar",
      workspaceKey: workspace,
      metadata: { provider: "db-only", model: "db-model", createdAt },
    });
    appendConversation(kernel, "canonical-no-sidecar", "database only prompt", "database only answer");

    const listed = await listSessions(workspace, 20);
    const stale = listed.find((entry) => entry.id === "canonical-stale");
    const dbOnly = listed.find((entry) => entry.id === "canonical-no-sidecar");
    assert.ok(stale);
    assert.equal(stale.label, "Canonical title");
    assert.equal(stale.provider.name, "canonical-provider");
    assert.equal(stale.preview, "canonical prompt");
    assert.equal(stale.eventCount, canonicalEventCount);
    assert.ok(dbOnly, "a canonical row is listed without any session directory");
    assert.equal(dbOnly.provider.name, "db-only");

    const snapshot = await loadSessionSnapshot(workspace, "canonical-stale");
    assert.equal(snapshot.meta.provider.name, "canonical-provider");
    assert.deepEqual(
      snapshot.messages.map((entry) => entry.content[0]?.text),
      ["canonical prompt", "canonical answer"],
    );
    assert.equal(snapshot.eventCount, canonicalEventCount);

    const dbOnlySnapshot = await loadSessionSnapshot(workspace, "canonical-no-sidecar");
    assert.equal(dbOnlySnapshot.meta.provider.name, "db-only");
    assert.equal(dbOnlySnapshot.nextSeq, 0, "missing audit JSON does not prevent canonical resume");
  } finally {
    kernel.close();
  }
});

test("canonical projection errors propagate instead of falling back to stale JSON", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-canonical-corrupt-"));
  const kernel = await openWorkspaceSessionKernel(workspace);
  try {
    kernel.createSession({
      id: "canonical-corrupt",
      workspaceKey: workspace,
      metadata: { provider: "canonical-provider", model: "canonical-model", createdAt },
    });
    const lease = kernel.acquireRunnerLease("canonical-corrupt", "corrupt-seed", 5_000);
    const fence = fenceOf(lease);
    kernel.appendContextEpoch(fence, {
      reason: "test malformed projection",
      summary: { text: "broken on purpose" },
      projection: [{ id: "missing-content", role: "assistant", createdAt }],
      sourceVersions: { lastMessageOrdinal: 0 },
    });
    kernel.releaseRunnerLease(fence, {
      executionState: "completed",
      workOutcome: "not_applicable",
    });
    await writeLegacySession(workspace, "canonical-corrupt", "unsafe stale fallback");

    await assert.rejects(
      loadSessionSnapshot(workspace, "canonical-corrupt"),
      /(?:content|map)/i,
    );
    await assert.rejects(
      listSessions(workspace, 20),
      /(?:content|map)/i,
    );
  } finally {
    kernel.close();
  }
});

test("legacy list and resume remain available only when no canonical database exists", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-legacy-authority-"));
  await writeLegacySession(workspace, "legacy-only", "legacy prompt");

  const listed = await listSessions(workspace, 20);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "legacy-only");
  assert.equal(listed[0].provider.name, "legacy-provider");

  const snapshot = await loadSessionSnapshot(workspace, "legacy-only");
  assert.equal(snapshot.messages[0].content[0].text, "legacy prompt");
  assert.equal(snapshot.nextSeq, 6);
});

test("canonical rename and tree deletion are transactional and tombstones shadow stale JSON", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-canonical-delete-"));
  const kernel = await openWorkspaceSessionKernel(workspace);
  try {
    kernel.createSession({ id: "root-session", workspaceKey: workspace, title: "Before" });
    kernel.createChildSession({
      id: "child-session",
      parentSessionId: "root-session",
      relation: "subagent",
      metadata: { subagentType: "worker" },
    });
    const rootDir = await writeLegacySession(workspace, "root-session", "stale root");
    const childDir = await writeLegacySession(workspace, "child-session", "stale child");

    assert.equal(await renameSession(workspace, "root-session", "After"), true);
    assert.equal(kernel.requireSession("root-session").title, "After");

    const lease = kernel.acquireRunnerLease("child-session", "active-child", 5_000);
    await assert.rejects(
      deleteSession(workspace, "root-session"),
      /active runner lease/i,
    );
    assert.equal(kernel.requireSession("root-session").archived, false);
    assert.equal(await fs.stat(rootDir).then(() => true), true);
    kernel.releaseRunnerLease(fenceOf(lease), {
      executionState: "completed",
      workOutcome: "not_applicable",
    });

    assert.equal(await deleteSession(workspace, "root-session"), true);
    assert.equal(kernel.getSession("root-session"), null);
    assert.equal(kernel.getSession("child-session"), null);
    assert.ok(kernel.getSessionTombstone("root-session"));
    assert.ok(kernel.getSessionTombstone("child-session"));
    await assert.rejects(fs.stat(rootDir), { code: "ENOENT" });
    await assert.rejects(fs.stat(childDir), { code: "ENOENT" });

    // A later backup restore of either JSON directory cannot resurrect a
    // finalized root or descendant after their canonical rows are gone.
    await writeLegacySession(workspace, "root-session", "restored stale root");
    await writeLegacySession(workspace, "child-session", "restored stale child");
    assert.equal((await listSessions(workspace, 20)).some((entry) =>
      entry.id === "root-session" || entry.id === "child-session"
    ), false);
    await assert.rejects(loadSessionSnapshot(workspace, "root-session"), SessionNotFoundError);
    await assert.rejects(loadSessionRollout(workspace, "child-session"), SessionNotFoundError);
    assert.equal(await renameSession(workspace, "root-session", "Resurrected"), false);
    assert.throws(
      () => kernel.createSession({ id: "root-session", workspaceKey: workspace }),
      /permanently deleted/i,
    );

    kernel.createSession({ id: "tombstoned", workspaceKey: workspace });
    await writeLegacySession(workspace, "tombstoned", "must stay hidden");
    kernel.prepareSessionDeletion("tombstoned");
    assert.equal((await listSessions(workspace, 20)).some((entry) => entry.id === "tombstoned"), false);
    await assert.rejects(
      loadSessionSnapshot(workspace, "tombstoned"),
      SessionNotFoundError,
    );
    assert.equal(kernel.finalizeSessionDeletion("tombstoned"), true);
    assert.ok(kernel.getSessionTombstone("tombstoned"));
    assert.equal((await listSessions(workspace, 20)).some((entry) => entry.id === "tombstoned"), false);
    await assert.rejects(loadSessionSnapshot(workspace, "tombstoned"), SessionNotFoundError);
  } finally {
    kernel.close();
  }
});

test("deleting a legacy-only session creates a durable authority before removing JSON", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-legacy-delete-tombstone-"));
  const sessionDir = await writeLegacySession(workspace, "legacy-deleted", "delete this legacy session");

  assert.equal(await deleteSession(workspace, "legacy-deleted"), true);
  await assert.rejects(fs.stat(sessionDir), { code: "ENOENT" });

  const kernel = await openWorkspaceSessionKernel(workspace);
  try {
    const tombstone = kernel.getSessionTombstone("legacy-deleted");
    assert.equal(tombstone?.deletionSource, "legacy");
    assert.equal(tombstone?.rootSessionId, "legacy-deleted");

    // Simulate a stale sync/backup restoring the complete legacy transcript.
    await writeLegacySession(workspace, "legacy-deleted", "restored after deletion");
    assert.deepEqual(await listSessions(workspace, 20), []);
    await assert.rejects(loadSessionSnapshot(workspace, "legacy-deleted"), SessionNotFoundError);
    await assert.rejects(loadSessionRollout(workspace, "legacy-deleted"), SessionNotFoundError);
    assert.equal(await renameSession(workspace, "legacy-deleted", "Back again"), false);

    // Session construction is the legacy resume/import reconciliation path.
    // It must not translate restored metadata back into a canonical row.
    assert.throws(
      () => new Session({
        sessionId: "legacy-deleted",
        workspace,
        provider: {
          name: "unused",
          async *stream() {
            throw new Error("provider must not run");
          },
        },
        model: "unused",
        systemPrompt: "must remain deleted",
        tools: [],
        sessionKernel: kernel,
        telemetryDir: path.join(workspace, "telemetry"),
        sessionRegistryHome: workspace,
      }),
      /permanently deleted/i,
    );

    // Retrying delete cleans a newly restored directory but reports that the
    // semantic deletion was already committed.
    assert.equal(await deleteSession(workspace, "legacy-deleted"), false);
    await assert.rejects(fs.stat(sessionDir), { code: "ENOENT" });
  } finally {
    kernel.close();
  }
});

test("setProvider updates canonical metadata without erasing subagent fields", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-canonical-provider-"));
  const kernel = await openWorkspaceSessionKernel(workspace);
  const unusedProvider = (name) => ({
    name,
    async *stream() {
      throw new Error("provider should not run in metadata test");
    },
  });
  try {
    kernel.createSession({
      id: "provider-session",
      workspaceKey: workspace,
      metadata: {
        provider: "old-provider",
        model: "old-model",
        createdAt,
        subagentType: "explore",
        description: "preserve me",
      },
    });
    const session = new Session({
      sessionId: "provider-session",
      workspace,
      provider: unusedProvider("old-provider"),
      model: "old-model",
      systemPrompt: "metadata test",
      tools: [],
      sessionKernel: kernel,
      telemetryDir: path.join(workspace, "telemetry"),
      sessionRegistryHome: workspace,
    });

    await session.setProvider(unusedProvider("new-provider"), "new-model");
    const metadata = kernel.requireSession("provider-session").metadata;
    assert.deepEqual(metadata, {
      createdAt,
      description: "preserve me",
      model: "new-model",
      provider: "new-provider",
      subagentType: "explore",
    });
    const [listed] = await listSessions(workspace, 20);
    assert.equal(listed.provider.name, "new-provider");
    assert.equal(listed.provider.model, "new-model");
  } finally {
    kernel.close();
  }
});
