// C1 — microcompact rung (feat/core-consolidation, coding-win track).
//
// The cheap layer beneath heavy compaction: when history passes ~60% of the
// compaction threshold, the engine clears OLD compactable tool_result BODIES
// (keeping the most recent N) in place with NO model call — so context stays lean
// and the expensive summarizer fires far later, while every assistant reasoning
// step and user message is preserved (unlike a blunt trim). The "slow / lobotomy" fix.
//
// usage.inputTokens=0 keeps tokenScale pinned at 1.0 (calibration skips realPrompt<=0),
// so the threshold math is deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  QueryEngine,
  Session,
  openWorkspaceSessionKernel,
  projectMessagesFromKernel,
} from "../packages/core/dist/index.js";

const PLACEHOLDER = "[old tool output cleared to save context";

function tenReadsThenIdle() {
  let calls = 0;
  const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
  return {
    name: "mc-provider",
    ids,
    async *stream() {
      calls += 1;
      if (calls === 1) {
        for (const id of ids) {
          yield { type: "tool_use_start", id, name: "Read" };
          yield { type: "tool_use_input_done", id, input: {} };
        }
        yield {
          type: "message_done",
          message: {
            id: "tools",
            role: "assistant",
            content: ids.map((id) => ({ type: "tool_use", id, name: "Read", input: {} })),
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: `done${calls}`, role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

// A "Read" tool whose result is ~1600 chars: 10 of them ≈ 4000 est tokens, which
// lands in (0.6*T, T] for T=5000 — micro fires, heavy does not.
const readTool = {
  schema: { name: "Read", description: "fake read", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe" },
  async call() {
    return { output: "L".repeat(1600) };
  },
};

function toolResults(engine) {
  const out = [];
  for (const m of engine.history()) {
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

test("C1: microcompact clears old tool bodies past the threshold, keeps the most recent N", async () => {
  const provider = tenReadsThenIdle();
  const engine = QueryEngine.forTesting(
    {
      provider,
      model: "m",
      systemPrompt: "s",
      tools: [readTool],
      workspace: process.platform === "win32" ? "D:\\Ares" : "/tmp",
      maxTurns: 5,
      compactionThresholdTokens: 5000,
    },
    "sess_microcompact",
  );

  // Turn 1: produce 10 big Read results. Maintenance runs again at the settled
  // tool→model boundary, so the large results are compacted before call #2.
  engine.appendUserMessage("gather");
  const events = [];
  for await (const e of engine.streamTurn()) events.push(e);
  assert.equal(toolResults(engine).length, 10, "ten tool results recorded");
  assert.equal(toolResults(engine).filter((r) => r.content.startsWith(PLACEHOLDER)).length, 4, "old results clear before the next model call");

  const micro = events.find((e) => e.type === "system_reminder_injected" && /microcompacted/.test(e.text));
  assert.ok(micro, "a microcompact event is emitted");
  assert.equal(micro.source, "compaction");
  assert.match(micro.text, /microcompacted 4 old tool output/);

  const results = toolResults(engine);
  const cleared = results.filter((r) => typeof r.content === "string" && r.content.startsWith(PLACEHOLDER));
  const kept = results.filter((r) => r.content === "L".repeat(1600));
  assert.equal(cleared.length, 4, "oldest 4 cleared");
  assert.equal(kept.length, 6, "most recent 6 kept at full fidelity");

  const projection = events.find((e) => e.type === "compaction" && e.method === "micro");
  assert.ok(projection, "the exact microcompacted projection is emitted for durable hosts");
  assert.equal(projection.summarizedMessages, 0);
  assert.ok(projection.tokensAfter < projection.tokensBefore);

  // No heavy compaction recap was created (microcompact kept us under threshold).
  const hadHeavy = events.some((e) => e.type === "compaction" && e.method !== "micro");
  assert.equal(hadHeavy, false, "heavy summarizer did not need to run");
});

test("C1: microcompaction persists an exact SQLite epoch and survives restart", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-micro-epoch-"));
  const kernel = await openWorkspaceSessionKernel(workspace);
  const sessionId = "sess_microcompact_epoch";
  try {
    const session = new Session({
      workspace,
      sessionId,
      provider: tenReadsThenIdle(),
      model: "m",
      systemPrompt: "s",
      tools: [readTool],
      maxTurns: 5,
      compactionThresholdTokens: 5_000,
      sessionKernel: kernel,
    });

    const events = [];
    for await (const event of session.send("gather")) events.push(event);

    const projection = events.find((event) => event.type === "compaction" && event.method === "micro");
    assert.ok(projection, "micro projection crossed the Session persistence boundary");
    const epoch = kernel.getLatestContextEpoch(sessionId);
    assert.ok(epoch, "microcompaction created a canonical context epoch");
    assert.equal(epoch.reason, "context-microcompaction");
    assert.equal(epoch.summary.method, "micro");
    assert.deepEqual(projectMessagesFromKernel(kernel, sessionId), session.history());
    assert.equal(
      projectMessagesFromKernel(kernel, sessionId)
        .flatMap((message) => message.content)
        .filter((block) => block.type === "tool_result" && typeof block.content === "string" && block.content.startsWith(PLACEHOLDER))
        .length,
      4,
      "restart preserves the reduced bodies instead of re-inflating source messages",
    );
  } finally {
    kernel.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
