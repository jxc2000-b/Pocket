// Runtime configuration, read from environment variables (populated from
// `.env` by the start script). Nothing here prints secret values.

import { resolve } from "node:path";
import { homedir } from "node:os";
import type { LlmProvider } from "./llm.ts";
import { DEFAULT_SHORTCUT_NAMES } from "./shortcuts.ts";

export interface Config {
  projectId: string;
  projectSecret: string;
  /** Absolute path to the Obsidian vault folder Pocket writes into. */
  vaultPath: string;
  llm:
    | { provider: "gemini"; apiKey: string; model: string; fallbackModel: string }
    | { provider: "claude"; model: string };
  /** IANA timezone used to resolve "Tuesday at 3pm" and to format dates. */
  timeZone: string;
  elevenLabs: {
    apiKey: string | undefined;
    voiceId: string;
    sttModel: string;
    ttsModel: string;
  };
  /** Exact Shortcut names Pocket is allowed to run. */
  shortcutAllowlist: string[];
}

/** A distinctive premade ElevenLabs voice used when ELEVENLABS_VOICE_ID is unset. */
export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/**
 * Parse POCKET_SHORTCUTS_ALLOWLIST.
 * - unset or empty: every built-in Pocket Shortcut name is allowed
 * - "none": Shortcuts are disabled
 * - otherwise: comma-separated exact Shortcut names
 */
export function parseShortcutAllowlist(raw: string | undefined): string[] {
  const value = raw?.trim() ?? "";
  if (value === "") return [...DEFAULT_SHORTCUT_NAMES];
  if (value.toLowerCase() === "none") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Flash-Lite: the cheapest, lowest-latency Gemini tier, enough for routing. */
export const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
/** Tried when the main Gemini model is overloaded or too slow. */
export const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-flash-latest";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/**
 * Pick the model provider. POCKET_LLM ("gemini" or "claude") wins; otherwise
 * Gemini is used when GEMINI_API_KEY is set, else Claude.
 */
export function loadLlm(env: NodeJS.ProcessEnv): Config["llm"] {
  const choice = env.POCKET_LLM?.trim().toLowerCase();
  if (choice && choice !== "gemini" && choice !== "claude") {
    throw new Error(`POCKET_LLM must be "gemini" or "claude", got "${choice}".`);
  }
  const provider: LlmProvider = (choice as LlmProvider | undefined) ?? (env.GEMINI_API_KEY?.trim() ? "gemini" : "claude");
  if (provider === "gemini") {
    return {
      provider,
      apiKey: required(env, "GEMINI_API_KEY"),
      model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
      fallbackModel: env.GEMINI_FALLBACK_MODEL?.trim() || DEFAULT_GEMINI_FALLBACK_MODEL,
    };
  }
  if (!env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("Missing GEMINI_API_KEY (or ANTHROPIC_API_KEY to use Claude). Add one to .env.");
  }
  return { provider, model: env.CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${name}. Add it to .env.`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    projectId: required(env, "PROJECT_ID"),
    projectSecret: required(env, "PROJECT_SECRET"),
    vaultPath: expandHome(required(env, "POCKET_VAULT_PATH")),
    llm: loadLlm(env),
    timeZone:
      env.POCKET_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    elevenLabs: {
      apiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
      voiceId: env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID,
      sttModel: env.ELEVENLABS_STT_MODEL?.trim() || "scribe_v1",
      ttsModel: env.ELEVENLABS_TTS_MODEL?.trim() || "eleven_multilingual_v2",
    },
    shortcutAllowlist: parseShortcutAllowlist(env.POCKET_SHORTCUTS_ALLOWLIST),
  };
}
