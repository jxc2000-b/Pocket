import { describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL, loadLlm } from "../src/config.ts";
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
    expect(loadLlm({ GEMINI_API_KEY: "g" })).toEqual({ provider: "gemini", apiKey: "g", model: DEFAULT_GEMINI_MODEL });
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
