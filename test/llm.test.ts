import { describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_FALLBACK_MODEL, DEFAULT_GEMINI_MODEL, loadLlm } from "../src/config.ts";
import { parseJsonText } from "../src/llm.ts";

describe("parseJsonText", () => {
  it("parses plain JSON and JSON wrapped in prose or code fences", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonText("not json")).toBeUndefined();
    expect(parseJsonText(undefined)).toBeUndefined();
  });
});

describe("loadLlm", () => {
  it("uses Gemini when GEMINI_API_KEY is set", () => {
    expect(loadLlm({ GEMINI_API_KEY: "g" })).toEqual({
      provider: "gemini",
      apiKey: "g",
      model: DEFAULT_GEMINI_MODEL,
      fallbackModel: DEFAULT_GEMINI_FALLBACK_MODEL,
    });
    expect(loadLlm({ GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-x", ANTHROPIC_API_KEY: "a" })).toMatchObject({
      provider: "gemini",
      model: "gemini-x",
    });
  });

  it("falls back to Claude with only ANTHROPIC_API_KEY, or when POCKET_LLM=claude", () => {
    expect(loadLlm({ ANTHROPIC_API_KEY: "a" })).toEqual({ provider: "claude", model: DEFAULT_CLAUDE_MODEL });
    expect(loadLlm({ POCKET_LLM: "claude", GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }).provider).toBe("claude");
  });

  it("explains what is missing", () => {
    expect(() => loadLlm({})).toThrow(/GEMINI_API_KEY/);
    expect(() => loadLlm({ POCKET_LLM: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => loadLlm({ POCKET_LLM: "gpt" })).toThrow(/POCKET_LLM/);
  });
});

describe("geminiGenerateJson (network stubbed)", () => {
  it("sends system, image, schema and JSON mode, and parses the reply", async () => {
    const { geminiGenerateJson } = await import("../src/llm.ts");
    const { vi } = await import("vitest");
    let sent: { url: string; body: any } | undefined;
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: '{"title":"Bin 3"}' }] }, finishReason: "STOP" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const generate = geminiGenerateJson("test-key", "gemini-flash-latest");
      const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
      const result = await generate({
        system: "be brief",
        text: "what is this?",
        image: { data: Buffer.from("img"), mimeType: "image/jpeg" },
        schema,
        effort: "low",
        maxTokens: 100,
      });
      expect(result).toEqual({ refused: false, value: { title: "Bin 3" } });
      expect(sent!.url).toContain("models/gemini-flash-latest:generateContent");
      expect(sent!.body.systemInstruction.parts[0].text).toBe("be brief");
      expect(sent!.body.contents[0].parts[0].inlineData).toEqual({ mimeType: "image/jpeg", data: Buffer.from("img").toString("base64") });
      expect(sent!.body.contents[0].parts[1].text).toBe("what is this?");
      expect(sent!.body.generationConfig.responseMimeType).toBe("application/json");
      expect(sent!.body.generationConfig.responseJsonSchema).toEqual(schema);
      expect(sent!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a safety block as refused", async () => {
    const { geminiGenerateJson } = await import("../src/llm.ts");
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const r = await geminiGenerateJson("k", "m")({ text: "x", schema: {}, effort: "low", maxTokens: 10 });
      expect(r).toEqual({ refused: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("geminiGenerateJson retries", () => {
  const ok = () =>
    new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: '{"a":1}' }] }, finishReason: "STOP" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fail = (status: number) =>
    new Response(JSON.stringify({ error: { code: status, message: "busy", status: "UNAVAILABLE" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  const req = { text: "x", schema: {}, effort: "low" as const, maxTokens: 10 };

  async function run(statuses: number[], models: string[]) {
    const { geminiGenerateJson } = await import("../src/llm.ts");
    const { vi } = await import("vitest");
    const urls: string[] = [];
    const sleeps: number[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      urls.push(String(url));
      const s = statuses.shift();
      return s === undefined || s === 200 ? ok() : fail(s);
    });
    try {
      const generate = geminiGenerateJson("k", models, { attempts: 3, baseDelayMs: 10, sleep: async (ms) => void sleeps.push(ms) });
      return { result: await generate(req).catch((e: unknown) => e), urls, sleeps };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("retries a 503 with backoff and succeeds", async () => {
    const r = await run([503, 503, 200], ["main"]);
    expect(r.result).toEqual({ refused: false, value: { a: 1 } });
    expect(r.urls).toHaveLength(3);
    expect(r.sleeps).toEqual([10, 20]);
  });

  it("falls back to the next model when the first stays overloaded", async () => {
    const r = await run([503, 503, 503, 200], ["main", "lite"]);
    expect(r.result).toEqual({ refused: false, value: { a: 1 } });
    expect(r.urls.slice(0, 3).every((u) => u.includes("models/main:"))).toBe(true);
    expect(r.urls[3]).toContain("models/lite:");
  });

  it("drops the thinking level when a model rejects it, without spending a retry", async () => {
    const { geminiGenerateJson } = await import("../src/llm.ts");
    const { vi } = await import("vitest");
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.generationConfig.thinkingConfig) {
        return new Response(
          JSON.stringify({ error: { code: 400, message: "Thinking level is not supported for this model.", status: "INVALID_ARGUMENT" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return ok();
    });
    try {
      const generate = geminiGenerateJson("k", ["old"], { attempts: 1, sleep: async () => {} });
      expect(await generate({ ...req, effort: "medium" })).toEqual({ refused: false, value: { a: 1 } });
      expect(await generate(req)).toEqual({ refused: false, value: { a: 1 } });
      expect(bodies.map((b) => Boolean(b.generationConfig.thinkingConfig))).toEqual([true, false, false]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retry a non-transient error", async () => {
    const r = await run([400], ["main", "lite"]);
    expect((r.result as { status: number }).status).toBe(400);
    expect(r.urls).toHaveLength(1);
  });

  it("gives up with the last error when every model is overloaded", async () => {
    const r = await run([503, 503, 503, 503, 503, 503], ["main", "lite"]);
    expect((r.result as { status: number }).status).toBe(503);
    expect(r.urls).toHaveLength(6);
  });
});
