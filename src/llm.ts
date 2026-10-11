// The one kind of model call Pocket makes: a prompt (optionally with an
// image) that must come back as JSON matching a schema. Gemini and Claude
// both implement it; config picks which one runs.

import Anthropic from "@anthropic-ai/sdk";
import { FinishReason, GoogleGenAI, ThinkingLevel } from "@google/genai";

export interface JsonRequest {
  system?: string;
  text: string;
  image?: { data: Buffer; mimeType: string };
  schema: Record<string, unknown>;
  /** How hard the model should think; providers map it as they can. */
  effort: "low" | "medium";
  maxTokens: number;
}

/** `refused` means the provider's safety layer declined to answer. */
export type JsonResult = { refused: false; value: unknown } | { refused: true };

export type GenerateJson = (req: JsonRequest) => Promise<JsonResult>;

export type LlmProvider = "gemini" | "claude";

/** Parse model text as JSON, tolerating prose or code fences around the object. */
export function parseJsonText(text: string | undefined): unknown {
  const t = text?.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

const GEMINI_BLOCKED: readonly string[] = [
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
];

/** Gemini statuses worth retrying: rate limited, overloaded, or a server hiccup. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && RETRYABLE_STATUS.has(status);
}

export interface RetryOptions {
  /** Attempts per model before moving to the next one. */
  attempts: number;
  /** Delay before the first retry; doubles each time. */
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY: RetryOptions = {
  attempts: 3,
  baseDelayMs: 1000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Gemini with retries: each model gets a few attempts with exponential
 * backoff on overload/rate-limit errors, then the next model in `models` is
 * tried. Other errors (bad key, bad request) fail immediately.
 */
export function geminiGenerateJson(
  apiKey: string,
  models: string | string[],
  retry: Partial<RetryOptions> = {},
): GenerateJson {
  const opts = { ...DEFAULT_RETRY, ...retry };
  const chain = (Array.isArray(models) ? models : [models]).filter((m, i, all) => m && all.indexOf(m) === i);
  const once = geminiOnce(new GoogleGenAI({ apiKey }));
  // Models that rejected a thinking level; they are called without one after.
  const noThinking = new Set<string>();
  return async (req) => {
    let lastErr: unknown;
    for (const model of chain) {
      for (let attempt = 0; attempt < opts.attempts; attempt++) {
        try {
          const started = Date.now();
          const result = await once(model, req, !noThinking.has(model));
          console.log(`[pocket] ${model} answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
          return result;
        } catch (err) {
          if (!noThinking.has(model) && isThinkingRejected(err)) {
            console.warn(`[pocket] ${model} does not accept a thinking level; retrying without it`);
            noThinking.add(model);
            attempt--;
            continue;
          }
          if (!isRetryable(err)) throw err;
          lastErr = err;
          const status = (err as { status: number }).status;
          console.warn(`[pocket] ${model} returned ${status} (attempt ${attempt + 1}/${opts.attempts})`);
          if (attempt + 1 < opts.attempts) await opts.sleep(opts.baseDelayMs * 2 ** attempt);
        }
      }
    }
    throw lastErr;
  };
}

/**
 * Pocket's calls are short classifications, so keep model thinking light: it
 * is most of the latency. Older models only take a token budget and reject a
 * level, which isThinkingRejected detects.
 */
const THINKING_BY_EFFORT: Record<JsonRequest["effort"], ThinkingLevel> = {
  low: ThinkingLevel.MINIMAL,
  medium: ThinkingLevel.LOW,
};

function isThinkingRejected(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown } | null;
  return e?.status === 400 && typeof e.message === "string" && /thinking/i.test(e.message);
}

function geminiOnce(ai: GoogleGenAI): (model: string, req: JsonRequest, thinking: boolean) => Promise<JsonResult> {
  return async (model, req, thinking) => {
    const parts: Array<Record<string, unknown>> = [];
    if (req.image) parts.push({ inlineData: { mimeType: req.image.mimeType, data: req.image.data.toString("base64") } });
    parts.push({ text: req.text });
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        ...(req.system ? { systemInstruction: req.system } : {}),
        responseMimeType: "application/json",
        responseJsonSchema: req.schema,
        maxOutputTokens: req.maxTokens,
        ...(thinking ? { thinkingConfig: { thinkingLevel: THINKING_BY_EFFORT[req.effort] } } : {}),
      },
    });
    const finish = response.candidates?.[0]?.finishReason;
    if (response.promptFeedback?.blockReason || (finish && GEMINI_BLOCKED.includes(finish))) return { refused: true };
    return { refused: false, value: parseJsonText(response.text) };
  };
}

export function claudeGenerateJson(model: string): GenerateJson {
  const client = new Anthropic();
  return async (req) => {
    const response = await client.messages.create({
      model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }] } : {}),
      output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
      messages: [
        {
          role: "user",
          content: req.image
            ? [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: req.image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                    data: req.image.data.toString("base64"),
                  },
                },
                { type: "text", text: req.text },
              ]
            : req.text,
        },
      ],
    });
    if (response.stop_reason === "refusal") return { refused: true };
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { refused: false, value: parseJsonText(text) };
  };
}
