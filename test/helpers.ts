import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/brain.ts";
import type { GenerateJson, JsonRequest } from "../src/llm.ts";

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

/** Mock model: returns queued JSON values in order and records requests. */
export function mockLlm(...replies: Array<unknown>): GenerateJson & { calls: JsonRequest[] } {
  const calls: JsonRequest[] = [];
  const fn = (async (req) => {
    calls.push(req);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { refused: false, value: next };
  }) as GenerateJson & { calls: JsonRequest[] };
  fn.calls = calls;
  return fn;
}
