import { CONTINUATION_BACKOFF_MS } from "./runtime-config.js";

/**
 * No-progress backoff for goal continuations. A continuation run that only repeats the previous
 * run's tool calls (a poll), reads, or makes no tool calls at all is a no-progress run. Each one in
 * a row waits longer before the next continuation; any progress, and any run started by something
 * other than a continuation (Joel, a message, a watch), starts the count again.
 */

/** Tools that never change anything; a call to one is not progress on its own. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "get_goal"]);

export type RunKind = "continuation" | "external";

interface ToolCallLike {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
}

/** Each tool call in the run's assistant messages as `name args`, args as JSON. */
export function runToolCalls(messages: readonly unknown[]): string[] {
  const calls: string[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "assistant" || !Array.isArray(content)) continue;
    for (const part of content as ToolCallLike[]) {
      if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
      let args = "";
      try { args = JSON.stringify(part.arguments ?? null); } catch { args = String(part.arguments); }
      calls.push(`${part.name} ${args}`);
    }
  }
  return calls;
}

/** Progress: some call is neither read-only nor an exact repeat of a call from the previous run. */
export function madeProgress(calls: readonly string[], previous: ReadonlySet<string>): boolean {
  return calls.some((call) => !READ_ONLY_TOOLS.has(call.slice(0, call.indexOf(" "))) && !previous.has(call));
}

/** Wait before the next continuation after `streak` no-progress runs in a row; capped at the last step. */
export function backoffDelayMs(streak: number): number {
  if (streak <= 0) return 0;
  return CONTINUATION_BACKOFF_MS[Math.min(streak, CONTINUATION_BACKOFF_MS.length) - 1] ?? 0;
}

export function createContinuationBackoff() {
  let runKind: RunKind | null = null;
  let streak = 0;
  let previous: ReadonlySet<string> = new Set();

  return {
    /** A message started in the current run. External input outranks a continuation in the same run. */
    noteRunMessage(kind: RunKind): void {
      if (runKind !== "external") runKind = kind;
    },
    /** The run ended; returns the wait before the next continuation. */
    noteRunEnd(messages: readonly unknown[]): number {
      const calls = runToolCalls(messages);
      if (runKind === "continuation" && !madeProgress(calls, previous)) streak += 1;
      else streak = 0;
      previous = new Set(calls);
      runKind = null;
      return backoffDelayMs(streak);
    },
    /** The run ended on an abort, error or stale path that recovery owns; it neither counts nor resets. */
    discardRun(): void {
      runKind = null;
    },
    streak: (): number => streak,
  };
}
