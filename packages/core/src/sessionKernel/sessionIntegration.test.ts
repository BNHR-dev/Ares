import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Message, StreamEvent, TurnEvent } from "@ares/protocol";
import { QueryEngine, type EngineTool, type Provider, type ProviderRequest } from "../queryEngine.js";
import { projectMessagesFromKernel, Session } from "../session.js";
import { SessionKernelStore, type BetterSqlite3Constructor } from "./index.js";

const requireFromAgent = createRequire(new URL("../../../agent/package.json", import.meta.url));
const BetterSqlite3 = requireFromAgent("better-sqlite3") as BetterSqlite3Constructor;

function createKernel(): { db: InstanceType<BetterSqlite3Constructor>; store: SessionKernelStore } {
  const db = new BetterSqlite3(":memory:");
  return { db, store: new SessionKernelStore(db) };
}

async function collect(stream: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function assistant(id: string, text = "done"): Message {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  };
}

function finalProvider(id: string, onRequest?: (request: ProviderRequest) => void | Promise<void>): Provider {
  return {
    name: "fixed-final",
    async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
      await onRequest?.(request);
      yield {
        type: "message_done",
        message: assistant(id),
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

test("Session durably admits before provider work and retries one idempotent input exactly once", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-admission-"));
  const { db, store } = createKernel();
  try {
    // FULL (2) is required because admission/settlement commits fence real side effects.
    assert.equal(db.pragma("synchronous", { simple: true }), 2);
    let providerCalls = 0;
    const sessionId = "admission-session";
    const provider = finalProvider("wire-admission-reply", async () => {
      providerCalls += 1;
      const input = store.listInputs(sessionId)[0];
      assert.equal(input?.state, "claimed", "provider cannot start before the durable input is claimed");
      assert.ok(
        store.listEvents(sessionId).some((event) => event.type === "input.admitted"),
        "canonical admission must precede provider execution",
      );
      const rollout = await readFile(
        path.join(workspace, ".ares", "sessions", sessionId, "events.jsonl"),
        "utf8",
      );
      assert.match(rollout, /"type":"input_admitted"/, "portable admission must also cross its flush barrier");
    });
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const admissions: string[] = [];
    session.observeEvents((event) => {
      if (event.type === "input_admitted") admissions.push(event.inputId);
    });

    const firstEvents = await collect(
      session.sendContent([{ type: "text", text: "build it" }], { inputId: "owner-request-1" }),
    );
    assert.equal(firstEvents[0]?.type, "turn_start", "wire compatibility keeps admission on the observer/audit tap");
    assert.equal(firstEvents.at(-1)?.type, "turn_end");
    assert.deepEqual(admissions, ["owner-request-1"]);
    assert.equal(providerCalls, 1);
    assert.equal(store.listInputs(sessionId).length, 1);
    assert.equal(store.listInputs(sessionId)[0]?.state, "consumed");

    // A network/UI retry after completion acknowledges the same durable input
    // but never calls the provider or creates another logical message.
    const duplicateEvents = await collect(
      session.sendContent([{ type: "text", text: "build it" }], { inputId: "owner-request-1" }),
    );
    assert.deepEqual(duplicateEvents, []);
    assert.deepEqual(admissions, ["owner-request-1", "owner-request-1"]);
    assert.equal(providerCalls, 1);
    assert.equal(store.listMessages(sessionId).filter((message) => message.role === "user").length, 1);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Session admits a concurrent input before FIFO wait and later streams it under exclusive execution", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-concurrent-admission-"));
  const { store } = createKernel();
  let releaseFirstProvider = (): void => {};
  let firstTurn: Promise<TurnEvent[]> | undefined;
  let secondTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalFirstProviderStarted!: () => void;
    const firstProviderStarted = new Promise<void>((resolve) => {
      signalFirstProviderStarted = resolve;
    });
    const firstProviderGate = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    let providerCalls = 0;
    let activeProviders = 0;
    let maxActiveProviders = 0;
    const provider: Provider = {
      name: "fifo-gated-final",
      async *stream(): AsyncGenerator<StreamEvent> {
        const call = ++providerCalls;
        activeProviders += 1;
        maxActiveProviders = Math.max(maxActiveProviders, activeProviders);
        try {
          if (call === 1) {
            signalFirstProviderStarted();
            await firstProviderGate;
          }
          yield {
            type: "message_done",
            message: assistant(`wire-concurrent-${call}`, `reply ${call}`),
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "end_turn",
          };
        } finally {
          activeProviders -= 1;
        }
      },
    };
    const sessionId = "concurrent-admission-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const admissions: string[] = [];
    session.observeEvents((event) => {
      if (event.type === "input_admitted") admissions.push(event.inputId);
    });

    firstTurn = collect(
      session.sendContent([{ type: "text", text: "first request" }], { inputId: "input-a" }),
    );
    await firstProviderStarted;
    secondTurn = collect(
      session.sendContent([{ type: "text", text: "second request" }], { inputId: "input-b" }),
    );

    const rolloutPath = path.join(workspace, ".ares", "sessions", sessionId, "events.jsonl");
    await waitFor(async () => {
      if (!admissions.includes("input-b") || store.getInput("input-b")?.state !== "admitted") return false;
      const rollout = await readFile(rolloutPath, "utf8");
      return rollout.includes('"type":"input_admitted"') && rollout.includes('"inputId":"input-b"');
    }, "input B did not cross SQLite, observer, and audit admission before waiting on input A");

    assert.deepEqual(admissions, ["input-a", "input-b"]);
    assert.equal(providerCalls, 1, "input B must not overlap input A's provider execution");
    assert.equal(maxActiveProviders, 1);
    assert.equal(store.getInput("input-a")?.state, "claimed");
    assert.equal(store.getInput("input-b")?.state, "admitted");

    releaseFirstProvider();
    const [firstEvents, secondEvents] = await Promise.all([firstTurn, secondTurn]);
    assert.equal(providerCalls, 2);
    assert.equal(maxActiveProviders, 1, "the provider/tool loop remains single-owner");
    assert.equal(store.getInput("input-a")?.state, "consumed");
    assert.equal(store.getInput("input-b")?.state, "consumed");

    const firstStarts = firstEvents.filter((event) => event.type === "turn_start");
    const secondStarts = secondEvents.filter((event) => event.type === "turn_start");
    assert.equal(firstStarts.length, 1);
    assert.equal(secondStarts.length, 1);
    assert.match(JSON.stringify(firstStarts[0]), /first request/);
    assert.match(JSON.stringify(secondStarts[0]), /second request/);
    assert.equal(firstEvents.at(-1)?.type, "turn_end");
    assert.equal(secondEvents.at(-1)?.type, "turn_end");
  } finally {
    releaseFirstProvider();
    await Promise.allSettled([firstTurn, secondTurn].filter((turn): turn is Promise<TurnEvent[]> => Boolean(turn)));
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("forced audit scheduling cannot make one sender stream another sender's input", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-caller-ownership-"));
  const { store } = createKernel();
  let releaseFirstAudit = (): void => {};
  let firstTurn: Promise<TurnEvent[]> | undefined;
  let secondTurn: Promise<TurnEvent[]> | undefined;
  try {
    const providerInputs: string[] = [];
    const provider = finalProvider("wire-owned", (request) => {
      const latestInput = [...request.messages]
        .reverse()
        .find((message) => message.role === "user" && message.content.some((block) => block.type === "text"));
      providerInputs.push(JSON.stringify(latestInput?.content ?? []));
    });
    const sessionId = "caller-ownership-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    // Force A to finish durable DB admission first but pause its portable audit
    // barrier. B crosses its later audit and reserves the local execution FIFO
    // first. A global-oldest claim would now make B steal A's stream.
    let signalFirstAuditReached!: () => void;
    let signalSecondAuditFlushed!: () => void;
    const firstAuditReached = new Promise<void>((resolve) => {
      signalFirstAuditReached = resolve;
    });
    const secondAuditFlushed = new Promise<void>((resolve) => {
      signalSecondAuditFlushed = resolve;
    });
    const firstAuditGate = new Promise<void>((resolve) => {
      releaseFirstAudit = resolve;
    });
    const internals = session as unknown as { flush: () => Promise<void> };
    const originalFlush = internals.flush.bind(session);
    let flushCalls = 0;
    internals.flush = async () => {
      flushCalls += 1;
      if (flushCalls === 1) {
        signalFirstAuditReached();
        await firstAuditGate;
      }
      await originalFlush();
      if (flushCalls === 2) signalSecondAuditFlushed();
    };

    firstTurn = collect(
      session.sendContent([{ type: "text", text: "caller A payload" }], { inputId: "z-caller-a" }),
    );
    await firstAuditReached;
    secondTurn = collect(
      session.sendContent([{ type: "text", text: "caller B payload" }], { inputId: "a-caller-b" }),
    );

    await secondAuditFlushed;
    assert.equal(store.getInput("z-caller-a")?.state, "admitted");
    assert.equal(store.getInput("a-caller-b")?.state, "admitted");
    assert.deepEqual(store.listInputs(sessionId).map((input) => input.admissionSequence), [1, 2]);
    assert.deepEqual(providerInputs, [], "B crossed its audit first but cannot overtake A's admission ticket");

    releaseFirstAudit();
    const [firstEvents, secondEvents] = await Promise.all([firstTurn, secondTurn]);
    assert.match(JSON.stringify(firstEvents.find((event) => event.type === "turn_start")), /caller A payload/);
    assert.doesNotMatch(JSON.stringify(firstEvents), /caller B payload/);
    assert.match(JSON.stringify(secondEvents.find((event) => event.type === "turn_start")), /caller B payload/);
    assert.doesNotMatch(JSON.stringify(secondEvents), /caller A payload/);
    assert.match(providerInputs[0] ?? "", /caller A payload/);
    assert.match(providerInputs[1] ?? "", /caller B payload/);
    assert.equal(store.getInput("z-caller-a")?.state, "consumed");
    assert.equal(store.getInput("a-caller-b")?.state, "consumed");
  } finally {
    releaseFirstAudit();
    await Promise.allSettled([firstTurn, secondTurn].filter((turn): turn is Promise<TurnEvent[]> => Boolean(turn)));
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an idle steering input behaves as the next queued turn", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-idle-steer-"));
  const { store } = createKernel();
  try {
    let requestSeen: ProviderRequest | undefined;
    const sessionId = "idle-steer-session";
    const session = new Session({
      sessionId,
      workspace,
      provider: finalProvider("wire-idle-steer", (request) => {
        requestSeen = request;
      }),
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    const events = await collect(
      session.sendContent(
        [{ type: "text", text: "use the smaller API" }],
        { inputId: "idle-steer", delivery: "steer" },
      ),
    );

    assert.equal(events[0]?.type, "turn_start");
    assert.equal(events.at(-1)?.type, "turn_end");
    assert.equal(store.getInput("idle-steer")?.state, "consumed");
    const visibleSteers = requestSeen?.messages.filter((message) => message.metadata?.source === "steer") ?? [];
    assert.equal(visibleSteers.length, 1);
    assert.match(JSON.stringify(visibleSteers[0]), /use the smaller API/);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("active steering waits for a settled tool boundary and is injected exactly once", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-active-steer-"));
  const { store } = createKernel();
  let releaseTool = (): void => {};
  let ownerTurn: Promise<TurnEvent[]> | undefined;
  let firstSteerSend: Promise<TurnEvent[]> | undefined;
  let duplicateSteerSend: Promise<TurnEvent[]> | undefined;
  try {
    let signalToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let toolActive = false;
    let toolCalls = 0;
    const holdTool: EngineTool = {
      schema: {
        name: "Hold",
        description: "Hold one tool round open",
        inputJsonSchema: { type: "object", additionalProperties: false },
        safety: "read-only",
        concurrency: "parallel-safe",
      },
      call: async () => {
        toolCalls += 1;
        toolActive = true;
        signalToolStarted();
        try {
          await toolGate;
          return { output: "held" };
        } finally {
          toolActive = false;
        }
      },
    };
    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    const sessionId = "active-steer-session";
    const provider: Provider = {
      name: "tool-then-final",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push({ ...request, messages: request.messages.map((message) => ({
          ...message,
          content: message.content.map((block) => ({ ...block })),
        })) });
        providerCalls += 1;
        if (providerCalls === 1) {
          yield { type: "tool_use_start", id: "hold-1", name: "Hold" };
          yield { type: "tool_use_input_done", id: "hold-1", input: {} };
          yield {
            type: "message_done",
            message: {
              ...assistant("wire-hold-request", ""),
              content: [{ type: "tool_use", id: "hold-1", name: "Hold", input: {} }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        assert.equal(toolActive, false, "the next provider round cannot overlap the active tool");
        assert.equal(store.getInput("steer-once")?.state, "consumed", "steer is acknowledged before provider reuse");
        yield {
          type: "message_done",
          message: assistant("wire-after-steer"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [holdTool],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    ownerTurn = collect(
      session.sendContent([{ type: "text", text: "start the original work" }], { inputId: "steer-owner" }),
    );
    await toolStarted;
    firstSteerSend = collect(
      session.sendContent(
        [{ type: "text", text: "correction: keep the public API unchanged" }],
        { inputId: "steer-once", delivery: "steer" },
      ),
    );
    duplicateSteerSend = collect(
      session.sendContent(
        [{ type: "text", text: "correction: keep the public API unchanged" }],
        { inputId: "steer-once", delivery: "steer" },
      ),
    );

    await waitFor(
      () => store.getInput("steer-once")?.state === "admitted",
      "steering input was not durably admitted while the tool was active",
    );
    assert.equal(toolActive, true);
    assert.equal(providerCalls, 1);
    assert.equal(store.listMessages(sessionId).some((message) => message.inputId === "steer-once"), false);

    releaseTool();
    const [ownerEvents, firstSteerEvents, duplicateSteerEvents] = await Promise.all([
      ownerTurn,
      firstSteerSend,
      duplicateSteerSend,
    ]);

    assert.equal(providerCalls, 2);
    assert.equal(toolCalls, 1);
    assert.equal(ownerEvents.at(-1)?.type, "turn_end");
    assert.deepEqual(firstSteerEvents, []);
    assert.deepEqual(duplicateSteerEvents, []);
    assert.equal(store.getInput("steer-once")?.state, "consumed");
    assert.equal(store.listInputs(sessionId).filter((input) => input.id === "steer-once").length, 1);
    assert.equal(store.listMessages(sessionId).filter((message) => message.inputId === "steer-once").length, 1);

    const secondMessages = requests[1]?.messages ?? [];
    const toolResultIndex = secondMessages.findIndex((message) =>
      message.content.some((block) => block.type === "tool_result" && block.tool_use_id === "hold-1"),
    );
    const steerIndexes = secondMessages
      .map((message, index) => message.metadata?.source === "steer" ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(steerIndexes.length, 1, "the provider sees one logical correction despite a concurrent retry");
    assert.ok(toolResultIndex >= 0 && toolResultIndex < steerIndexes[0]!, "steer is injected after the settled tool result");
    assert.match(JSON.stringify(secondMessages[steerIndexes[0]!]), /keep the public API unchanged/);

    const steerEvents = store.listEvents(sessionId).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.inputId === "steer-once";
    });
    assert.equal(steerEvents.filter((event) => event.type === "input.claimed").length, 1);
    assert.equal(steerEvents.filter((event) => event.type === "input.consumed").length, 1);
    assert.equal(steerEvents.find((event) => event.type === "input.consumed")?.generation, 1);
    assert.equal(store.getRun(sessionId, 2), null, "steer retries do not create a second runner generation");

    const replay = await collect(
      session.sendContent(
        [{ type: "text", text: "correction: keep the public API unchanged" }],
        { inputId: "steer-once", delivery: "steer" },
      ),
    );
    assert.deepEqual(replay, []);
    assert.equal(providerCalls, 2);
  } finally {
    releaseTool();
    await Promise.allSettled(
      [ownerTurn, firstSteerSend, duplicateSteerSend].filter(
        (turn): turn is Promise<TurnEvent[]> => Boolean(turn),
      ),
    );
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("steering acknowledgement failure requeues and replays one stable correction", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-steer-fault-"));
  const { store } = createKernel();
  let releaseFirstProvider = (): void => {};
  let ownerTurn: Promise<{ ok: true; events: TurnEvent[] } | { ok: false; error: unknown }> | undefined;
  let steeringTurn: Promise<TurnEvent[]> | undefined;
  try {
    let signalFirstProviderStarted!: () => void;
    const firstProviderStarted = new Promise<void>((resolve) => {
      signalFirstProviderStarted = resolve;
    });
    const firstProviderGate = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    const requests: ProviderRequest[] = [];
    let providerCalls = 0;
    const provider: Provider = {
      name: "steer-fault-recovery",
      async *stream(request): AsyncGenerator<StreamEvent> {
        requests.push({ ...request, messages: request.messages.map((message) => ({
          ...message,
          content: message.content.map((block) => ({ ...block })),
        })) });
        providerCalls += 1;
        if (providerCalls === 1) {
          signalFirstProviderStarted();
          await firstProviderGate;
        }
        yield {
          type: "message_done",
          message: assistant(`wire-steer-fault-${providerCalls}`),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const sessionId = "steer-fault-session";
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    const originalConsumeInput = store.consumeInput.bind(store);
    let failFirstSteeringAck = true;
    store.consumeInput = ((fence, inputId) => {
      if (inputId === "fault-steer" && failFirstSteeringAck) {
        failFirstSteeringAck = false;
        throw new Error("injected steering acknowledgement fault");
      }
      return originalConsumeInput(fence, inputId);
    }) as SessionKernelStore["consumeInput"];

    ownerTurn = collect(
      session.sendContent([{ type: "text", text: "original request" }], { inputId: "fault-owner" }),
    ).then(
      (events) => ({ ok: true as const, events }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await firstProviderStarted;
    steeringTurn = collect(
      session.sendContent(
        [{ type: "text", text: "fault-safe correction" }],
        { inputId: "fault-steer", delivery: "steer" },
      ),
    );
    await waitFor(
      () => store.getInput("fault-steer")?.state === "admitted",
      "fault steering input was not admitted",
    );

    releaseFirstProvider();
    const failedOwner = await ownerTurn;
    assert.equal(failedOwner.ok, false);
    if (failedOwner.ok) assert.fail("owner turn unexpectedly survived the injected acknowledgement fault");
    assert.match(String(failedOwner.error), /injected steering acknowledgement fault/);

    const recoveryEvents = await steeringTurn;
    assert.equal(recoveryEvents.at(-1)?.type, "turn_end");
    assert.equal(providerCalls, 2);
    assert.equal(
      store.getInput("fault-owner")?.state,
      "admitted",
      "the failed owner's input remains recoverable; the steering sender must not steal it",
    );
    assert.equal(store.getInput("fault-steer")?.state, "consumed");
    assert.equal(store.getRun(sessionId, 1)?.executionState, "failed");
    assert.equal(store.getRun(sessionId, 2)?.executionState, "completed");
    assert.equal(store.listMessages(sessionId).filter((message) => message.inputId === "fault-steer").length, 1);
    assert.equal(session.history().filter((message) => message.metadata?.source === "steer").length, 1);

    const recoveredSteers = requests[1]?.messages.filter((message) => message.metadata?.source === "steer") ?? [];
    assert.equal(recoveredSteers.length, 1);
    assert.match(JSON.stringify(recoveredSteers[0]), /fault-safe correction/);
    const steerEvents = store.listEvents(sessionId).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.inputId === "fault-steer";
    });
    assert.equal(steerEvents.filter((event) => event.type === "input.claimed").length, 2);
    assert.equal(steerEvents.filter((event) => event.type === "input.consumed").length, 1);
    assert.equal(steerEvents.find((event) => event.type === "input.consumed")?.generation, 2);
  } finally {
    releaseFirstProvider();
    const pendingTurns: Promise<unknown>[] = [];
    if (ownerTurn) pendingTurns.push(ownerTurn);
    if (steeringTurn) pendingTurns.push(steeringTurn);
    await Promise.allSettled(pendingTurns);
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("failed provider generation releases and requeues its claim for resume", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-requeue-"));
  const { store } = createKernel();
  try {
    let calls = 0;
    const provider: Provider = {
      name: "fail-then-recover",
      async *stream(): AsyncGenerator<StreamEvent> {
        calls += 1;
        if (calls === 1) throw new Error("simulated provider process loss");
        yield {
          type: "message_done",
          message: assistant("wire-recovered"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const session = new Session({
      sessionId: "requeue-session",
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    const failed = await collect(
      session.sendContent([{ type: "text", text: "survive this" }], { inputId: "recoverable-input" }),
    );
    const failedEnd = [...failed].reverse().find(
      (event): event is Extract<TurnEvent, { type: "turn_end" }> => event.type === "turn_end",
    );
    assert.equal(failedEnd?.status, "failed");
    assert.equal(store.listInputs("requeue-session")[0]?.state, "admitted");
    assert.equal(store.requireSession("requeue-session").executionState, "admitted");
    assert.equal(store.getRun("requeue-session", 1)?.executionState, "failed");
    assert.ok(store.listEvents("requeue-session").some((event) => event.type === "input.requeued"));

    const resumed = await collect(session.resumeTurn());
    const resumedEnd = [...resumed].reverse().find(
      (event): event is Extract<TurnEvent, { type: "turn_end" }> => event.type === "turn_end",
    );
    assert.equal(resumedEnd?.status, "completed");
    assert.equal(calls, 2);
    assert.equal(store.listInputs("requeue-session")[0]?.state, "consumed");
    assert.equal(store.listMessages("requeue-session").filter((message) => message.role === "user").length, 1);
    assert.equal(store.getRun("requeue-session", 2)?.executionState, "completed");
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("startup coordinator drains an orphan admitted before claim and publishes one durable detached result", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-orphan-before-claim-"));
  const { store } = createKernel();
  try {
    const sessionId = "orphan-before-claim";
    store.createSession({ id: sessionId, workspaceKey: workspace });
    store.admitInput({
      id: "orphan-input",
      sessionId,
      idempotencyKey: "orphan-input",
      delivery: "queue",
      payload: { content: [{ type: "text", text: "recover without a caller" }] },
    });
    let providerCalls = 0;
    const session = new Session({
      sessionId,
      workspace,
      provider: finalProvider("wire-orphan-recovered", () => {
        providerCalls += 1;
      }),
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });

    await session.waitForStartupRecovery();
    assert.equal(providerCalls, 1, "construction alone wakes recovery; resumeTurn is not required");
    assert.equal(store.getInput("orphan-input")?.state, "consumed");
    const result = store.getDetachedInputResult("orphan-input");
    assert.equal(result?.executionState, "completed");
    assert.ok(result?.outputMessageId);
    assert.ok(store.getMessage(result!.outputMessageId!));
    assert.equal(store.listDetachedInputResults(sessionId).length, 1);

    const transportRetry = await collect(
      session.sendContent(
        [{ type: "text", text: "recover without a caller" }],
        { inputId: "orphan-input" },
      ),
    );
    assert.deepEqual(transportRetry, []);
    assert.equal(providerCalls, 1, "a detached result is an acknowledgement, never replay authority");
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("startup coordinator takes over an expired claimed input without duplicating its logical request", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-orphan-after-claim-"));
  let now = 25_000;
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"), { now: () => now });
  try {
    const sessionId = "orphan-after-claim";
    store.createSession({ id: sessionId, workspaceKey: workspace });
    store.admitInput({
      id: "claimed-orphan",
      sessionId,
      idempotencyKey: "claimed-orphan",
      delivery: "queue",
      payload: { content: [{ type: "text", text: "claimed before the crash" }] },
    });
    const crashed = store.acquireRunnerLease(sessionId, "crashed-host", 250);
    store.claimInput(
      { sessionId, generation: crashed.generation, leaseToken: crashed.leaseToken },
      "claimed-orphan",
    );

    let providerCalls = 0;
    const session = new Session({
      sessionId,
      workspace,
      provider: finalProvider("wire-claimed-orphan", () => {
        providerCalls += 1;
      }),
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      sessionLeaseTtlMs: 250,
      sessionLeaseHeartbeatMs: 50,
      contextBudgetTokens: 0,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(providerCalls, 0, "a healthy prior lease is never stolen");
    now += 251;
    await session.waitForStartupRecovery();

    assert.equal(providerCalls, 1);
    assert.equal(store.getRun(sessionId, 1)?.executionState, "interrupted");
    assert.equal(store.getRun(sessionId, 2)?.executionState, "completed");
    assert.equal(store.getInput("claimed-orphan")?.state, "consumed");
    assert.equal(store.getDetachedInputResult("claimed-orphan")?.generation, 2);
    const inputEvents = store.listEvents(sessionId).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.inputId === "claimed-orphan";
    });
    assert.equal(inputEvents.filter((event) => event.type === "input.claimed").length, 2);
    assert.equal(inputEvents.filter((event) => event.type === "input.consumed").length, 1);
    assert.equal(inputEvents.filter((event) => event.type === "input.detached_result").length, 1);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a later caller may admit while startup recovery runs but cannot overtake or receive the orphan stream", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-orphan-order-"));
  const { store } = createKernel();
  let releaseOrphan = (): void => {};
  let laterTurn: Promise<TurnEvent[]> | undefined;
  try {
    const sessionId = "orphan-order";
    store.createSession({ id: sessionId, workspaceKey: workspace });
    store.admitInput({
      id: "orphan-head",
      sessionId,
      idempotencyKey: "orphan-head",
      delivery: "queue",
      payload: { content: [{ type: "text", text: "durable orphan head" }] },
    });
    let signalOrphanStarted!: () => void;
    const orphanStarted = new Promise<void>((resolve) => {
      signalOrphanStarted = resolve;
    });
    const orphanGate = new Promise<void>((resolve) => {
      releaseOrphan = resolve;
    });
    const requests: ProviderRequest[] = [];
    let calls = 0;
    const provider: Provider = {
      name: "orphan-order-provider",
      async *stream(request): AsyncGenerator<StreamEvent> {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          signalOrphanStarted();
          await orphanGate;
        }
        yield {
          type: "message_done",
          message: assistant(`wire-orphan-order-${calls}`, `reply ${calls}`),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    laterTurn = collect(
      session.sendContent([{ type: "text", text: "later caller payload" }], { inputId: "later-caller" }),
    );

    await orphanStarted;
    await waitFor(
      () => store.getInput("later-caller")?.state === "admitted",
      "later caller did not cross its independent admission barrier",
    );
    assert.equal(calls, 1);
    assert.equal(store.getInput("orphan-head")?.state, "claimed");
    assert.equal(store.getInput("later-caller")?.state, "admitted");
    assert.match(JSON.stringify(requests[0]?.messages), /durable orphan head/);
    assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /later caller payload/);

    releaseOrphan();
    await session.waitForStartupRecovery();
    const laterEvents = await laterTurn;
    assert.equal(calls, 2);
    assert.match(JSON.stringify(laterEvents.find((event) => event.type === "turn_start")), /later caller payload/);
    assert.doesNotMatch(JSON.stringify(laterEvents), /durable orphan head/);
    assert.equal(store.getDetachedInputResult("orphan-head")?.executionState, "completed");
    assert.equal(store.getDetachedInputResult("later-caller"), null, "the live sender owns normal delivery");
    assert.equal(store.getInput("later-caller")?.state, "consumed");
  } finally {
    releaseOrphan();
    if (laterTurn) await Promise.allSettled([laterTurn]);
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("QueryEngine withholds tool_start until durable pre-execution admission commits", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-tool-start-barrier-"));
  try {
    let round = 0;
    const provider: Provider = {
      name: "barrier-provider",
      async *stream(): AsyncGenerator<StreamEvent> {
        round += 1;
        if (round === 1) {
          yield { type: "tool_use_start", id: "barrier-tool", name: "Barrier" };
          yield { type: "tool_use_input_done", id: "barrier-tool", input: {} };
          yield {
            type: "message_done",
            message: {
              ...assistant("barrier-request", ""),
              content: [{ type: "tool_use", id: "barrier-tool", name: "Barrier", input: {} }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: assistant("barrier-finished"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    let releaseAdmission!: () => void;
    let markAdmissionStarted!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const admissionStarted = new Promise<void>((resolve) => {
      markAdmissionStarted = resolve;
    });
    const order: string[] = [];
    const tool: EngineTool = {
      schema: {
        name: "Barrier",
        description: "Exercise admission ordering",
        inputJsonSchema: { type: "object", additionalProperties: false },
        safety: "read-only",
        concurrency: "parallel-safe",
      },
      call: async () => {
        order.push("tool-call");
        return { output: "ok" };
      },
    };
    const engine = QueryEngine.forTesting({
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [tool],
      workspace,
      beforeToolExecution: async () => {
        order.push("admission-started");
        markAdmissionStarted();
        await admissionGate;
        order.push("admission-committed");
      },
      afterToolExecution: async () => {
        order.push("settlement-committed");
      },
      contextBudgetTokens: 0,
    }, "barrier-session");
    engine.appendUserMessage("run barrier");
    const events: TurnEvent[] = [];
    const pumping = (async () => {
      for await (const event of engine.streamTurn()) {
        if (event.type === "tool_start") order.push("tool-start-exposed");
        if (event.type === "tool_end") order.push("tool-end-exposed");
        events.push(event);
      }
    })();

    await admissionStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.some((event) => event.type === "tool_start"), false);
    assert.equal(order.includes("tool-call"), false);
    releaseAdmission();
    await pumping;
    assert.ok(order.indexOf("admission-committed") < order.indexOf("tool-start-exposed"), order.join(" -> "));
    assert.ok(order.indexOf("admission-committed") < order.indexOf("tool-call"), order.join(" -> "));
    assert.ok(order.indexOf("settlement-committed") < order.indexOf("tool-end-exposed"), order.join(" -> "));
    assert.ok(
      events.findIndex((event) => event.type === "tool_start") <
        events.findIndex((event) => event.type === "tool_end"),
      "stream ordering must still expose tool_start before tool_end",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool execution is durable before entry and settled before tool_end exposure", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-tool-"));
  const { store } = createKernel();
  try {
    const sessionId = "tool-session";
    let round = 0;
    const provider: Provider = {
      name: "one-tool",
      async *stream(): AsyncGenerator<StreamEvent> {
        round += 1;
        if (round === 1) {
          yield { type: "tool_use_start", id: "wire-tool-1", name: "Inspect" };
          yield { type: "tool_use_input_done", id: "wire-tool-1", input: { target: "state" } };
          yield {
            type: "message_done",
            message: {
              ...assistant("wire-tool-request", ""),
              content: [{ type: "tool_use", id: "wire-tool-1", name: "Inspect", input: { target: "state" } }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
          return;
        }
        yield {
          type: "message_done",
          message: assistant("wire-tool-finished"),
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };
    const tool: EngineTool = {
      schema: {
        name: "Inspect",
        description: "Inspect durable state",
        inputJsonSchema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
          additionalProperties: false,
        },
        safety: "read-only",
        concurrency: "parallel-safe",
      },
      call: async (_input, context) => {
        const run = store.listToolRuns(sessionId)[0];
        assert.equal(run?.executionState, "executing", "durable adapter-entry state must precede implementation");
        const decision = await context.requestPermission?.({
          toolName: "Inspect",
          input: { target: "state" },
          reason: "exercise permission ordering",
          suggestion: "allow_once",
        });
        assert.equal(decision, "allow_once");
        return { output: { ok: true, value: 42 } };
      },
    };
    let resolvePermission!: (decision: "allow_once") => void;
    const ownerDecision = new Promise<"allow_once">((resolve) => {
      resolvePermission = resolve;
    });
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [tool],
      sessionKernel: store,
      requestPermission: async () => ownerDecision,
      contextBudgetTokens: 0,
    });
    const observerStates: string[] = [];
    session.observeEvents((event) => {
      if (event.type === "tool_end") {
        observerStates.push(store.listToolRuns(sessionId)[0]?.executionState ?? "missing");
      }
    });

    const events: TurnEvent[] = [];
    for await (const event of session.send("inspect")) {
      if (event.type === "permission_request") {
        const toolRun = store.listToolRuns(sessionId)[0];
        assert.equal(toolRun?.executionState, "executing");
        assert.equal(
          store.listEvents(sessionId).some((stored) => stored.type === "tool.authorized"),
          false,
          "adapter entry must not be mislabeled as owner authorization while permission is pending",
        );
        resolvePermission("allow_once");
      }
      if (event.type === "tool_end") {
        assert.equal(store.listToolRuns(sessionId)[0]?.executionState, "succeeded");
        assert.equal(store.listMessages(sessionId).filter((message) => message.role === "tool").length, 1);
      }
      events.push(event);
    }
    assert.ok(events.some((event) => event.type === "tool_end"));
    assert.deepEqual(observerStates, ["succeeded"]);
    const toolRun = store.listToolRuns(sessionId)[0];
    assert.equal(toolRun?.executionState, "succeeded");
    assert.equal(toolRun?.verificationState, "not_required");
    assert.deepEqual(toolRun?.result, { ok: true, value: 42 });
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("provider message ids are namespaced in SQLite and restored for each session replay", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-kernel-message-id-"));
  const { store } = createKernel();
  try {
    const provider = finalProvider("provider-reused-message-id");
    const first = new Session({
      sessionId: "collision-a",
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const second = new Session({
      sessionId: "collision-b",
      workspace,
      provider,
      model: "fixed",
      systemPrompt: "test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    await collect(first.send("one"));
    await collect(second.send("two"));

    const firstStored = store.listMessages("collision-a").find((message) => message.role === "assistant");
    const secondStored = store.listMessages("collision-b").find((message) => message.role === "assistant");
    assert.ok(firstStored && secondStored);
    assert.notEqual(firstStored.id, secondStored.id);
    assert.notEqual(firstStored.id, "provider-reused-message-id");
    assert.notEqual(secondStored.id, "provider-reused-message-id");

    const firstReplay = projectMessagesFromKernel(store, "collision-a");
    const secondReplay = projectMessagesFromKernel(store, "collision-b");
    assert.equal(firstReplay.find((message) => message.role === "assistant")?.id, "provider-reused-message-id");
    assert.equal(secondReplay.find((message) => message.role === "assistant")?.id, "provider-reused-message-id");
    assert.equal(firstReplay.filter((message) => message.role === "assistant").length, 1);
    assert.equal(secondReplay.filter((message) => message.role === "assistant").length, 1);
  } finally {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
