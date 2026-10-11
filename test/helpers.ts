import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CreateMessage, Decision } from "../src/brain.ts";

export const TZ = "America/Los_Angeles";
export const SENDER = "+15551234567";

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pocket-test-"));
}

/** A mutable clock for tests. */
export function makeClock(iso: string): { now: () => Date; set: (iso: string) => void } {
  let current = new Date(iso);
  return { now: () => current, set: (v) => (current = new Date(v)) };
}

export function decision(partial: Partial<Decision>): Decision {
  return {
    intent: "unclear",
    target_note: "",
    title: "",
    now: "",
    entities: [],
    found: false,
    answer: "",
    source_notes: [],
    actions: [],
    ...partial,
  };
}

export function fakeResponse(body: unknown, stop_reason: BetaMessage["stop_reason"] = "end_turn"): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body), citations: null }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as BetaMessage;
}

/** Mock Claude: returns queued decisions in order and records requests. */
export function mockClaude(...replies: Array<unknown>): CreateMessage & { calls: Parameters<CreateMessage>[0][] } {
  const calls: Parameters<CreateMessage>[0][] = [];
  const fn = (async (params) => {
    calls.push(params);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return fakeResponse(next);
  }) as CreateMessage & { calls: Parameters<CreateMessage>[0][] };
  fn.calls = calls;
  return fn;
}
