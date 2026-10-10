import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { backoffDelayMs, createContinuationBackoff, madeProgress, runToolCalls } from "../src/continuation-backoff.js";
import { CONTINUATION_BACKOFF_MS } from "../src/runtime-config.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";
import { assistantMessage, createRuntimeHarness } from "./support/runtime-harness.js";

const withCalls = (...calls: Array<[string, unknown]>) => ({
  ...assistantMessage("stop", { input: 1, output: 1 }),
  content: calls.map(([name, args]) => ({ type: "toolCall", id: name, name, arguments: args })),
});

test("progress needs a call that is neither read-only nor a repeat of the previous run", () => {
  const poll = runToolCalls([withCalls(["bash", { command: "git log -1" }])]);
  assert.deepEqual(poll, ['bash {"command":"git log -1"}']);
  assert.equal(madeProgress(poll, new Set()), true);
  assert.equal(madeProgress(poll, new Set(poll)), false);
  assert.equal(madeProgress(runToolCalls([withCalls(["read", { path: "a" }])]), new Set()), false);
  assert.equal(madeProgress([], new Set()), false);
});

test("backoff waits 5, 15, then 60 minutes and stays capped", () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(backoffDelayMs), [0, ...CONTINUATION_BACKOFF_MS, CONTINUATION_BACKOFF_MS.at(-1)]);
  assert.equal(CONTINUATION_BACKOFF_MS.at(-1), 60 * 60_000);
});

test("only continuation runs count, and external input in the same run wins", () => {
  const backoff = createContinuationBackoff();
  backoff.noteRunMessage("continuation");
  assert.equal(backoff.noteRunEnd([withCalls()]), CONTINUATION_BACKOFF_MS[0]);
  backoff.noteRunMessage("continuation");
  backoff.noteRunMessage("external");
  assert.equal(backoff.noteRunEnd([]), 0);
  assert.equal(backoff.streak(), 0);
  assert.equal(backoff.noteRunEnd([]), 0, "a run with no observed start is not a continuation");
});

const continuationMessage = (sent: { message: { content: unknown; details?: unknown } }) => ({
  role: "custom",
  customType: CUSTOM_ENTRY_TYPE,
  content: sent.message.content,
  display: false,
  details: sent.message.details,
  timestamp: 1,
});

test("an idle goal backs off after no-progress continuations and resumes at once after an external wake", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "wait on other agents" });
    harness.sentMessages.length = 0;
    await harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop", { input: 1, output: 1 })] });
    mock.timers.tick(0);
    assert.equal(harness.sentMessages.length, 1, "first continuation is immediate");

    const poll = withCalls(["bash", { command: "check the queue" }]);
    const runContinuation = async (turnIndex: number, messages: unknown[]) => {
      const sent = harness.sentMessages.shift();
      assert.ok(sent);
      await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex });
      await harness.emit("message_start", { type: "message_start", message: continuationMessage(sent) });
      await harness.emit("agent_end", { type: "agent_end", messages });
    };

    await runContinuation(1, [poll]);
    mock.timers.tick(0);
    assert.equal(harness.sentMessages.length, 1, "a first poll is progress");

    await runContinuation(2, [poll]);
    mock.timers.tick(CONTINUATION_BACKOFF_MS[0]! - 1);
    assert.equal(harness.sentMessages.length, 0, "a repeated poll waits");
    mock.timers.tick(1);
    assert.equal(harness.sentMessages.length, 1);

    await runContinuation(3, [withCalls()]);
    mock.timers.tick(CONTINUATION_BACKOFF_MS[0]!);
    assert.equal(harness.sentMessages.length, 0, "the second no-progress run waits longer");

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 4, timestamp: 4 });
    await harness.emit("message_start", { type: "message_start", message: { role: "custom", customType: "intercom_message", content: "a reply", display: true, timestamp: 4 } });
    await harness.emit("agent_end", { type: "agent_end", messages: [withCalls(["edit", { path: "x" }])] });
    mock.timers.tick(0);
    assert.equal(harness.sentMessages.length, 1, "an external wake resets the backoff");
  } finally {
    mock.timers.reset();
  }
});
