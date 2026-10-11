// The model (Gemini or Claude, see llm.ts): classify the message, extract
// fields, and answer recall questions
// strictly from the sender's loaded memories. At prototype scale every
// memory goes into the prompt; there is no semantic search.

import { describeNow, formatNoteDate } from "./dates.ts";
import { SHORTCUTS, isShortcutAction, type ShortcutAction, type ShortcutRequest } from "./shortcuts.ts";
import type { GenerateJson } from "./llm.ts";
import type { Memory } from "./vault.ts";

export const INTENTS = ["save", "update", "recall", "history", "forget", "action", "chat", "unclear"] as const;
export type Intent = (typeof INTENTS)[number];

export interface Decision {
  intent: Intent;
  /** Existing note id for update/forget (and the matched note for save), else "". */
  target_note: string;
  /** Title for a new note. */
  title: string;
  /** Concise current value. */
  now: string;
  /** People/entities to [[link]]. */
  entities: string[];
  /** For recall/history: whether the answer exists in the memories. */
  found: boolean;
  /** Reply text for recall/history/chat/unclear. */
  answer: string;
  /** Note ids the answer came from. */
  source_notes: string[];
  actions: ShortcutRequest[];
}

export interface DecideInput {
  message: string;
  memories: Memory[];
  now: Date;
  timeZone: string;
  enabledActions: ShortcutAction[];
}

const UNCLEAR: Decision = {
  intent: "unclear",
  target_note: "",
  title: "",
  now: "",
  entities: [],
  found: false,
  answer: "",
  source_notes: [],
  actions: [],
};

export function buildSystemPrompt(enabledActions: ShortcutAction[]): string {
  const actionLines = enabledActions.length
    ? enabledActions.map((a) => `- ${a}: ${SHORTCUTS[a].when}`).join("\n")
    : "- (none enabled; always return an empty actions array)";
  return `You are the router for Pocket Memory, an iMessage contact people text (or send voice notes to) whenever they think "I'm going to forget this." You read the user's saved memories and their new message, and return one JSON object.

Memories are Markdown notes, one per thing, person or idea. Each has an id, a "Now:" current value, and a dated "History" of what the user said. Users sometimes edit notes by hand, so read the whole note text.

Choose exactly one intent:
- save: the user is telling you something new worth remembering (things and locations, people's preferences, recommendations, decisions, ideas, links, appointments). Messages starting with "Save:" or containing only a link or shared text are saves. Set title to a short, natural note name for the thing, person or idea (for example "Spare keys", "Air filter size", "Jamie's favorite dessert", "Piranesi"). If an existing note is about the same thing, use update instead.
- update: the message changes the current value of something already saved ("Moved the keys to the kitchen drawer"). Set target_note to that note's exact id.
- recall: a question about current information ("Where are my spare keys?"). Match by meaning, not wording: "luggage" matches a note about a suitcase.
- history: a question about past values ("Where did the keys used to be?"). Answer from History entries and include their dates.
- forget: the user asks you to forget/delete a memory. Set target_note to that note's exact id.
- action: a command for one of the actions below with nothing worth remembering ("I'm heading to bed").
- chat: greetings, thanks, or questions about what you can do. Reply in one short sentence. Never state facts about the user here.
- unclear: you cannot tell what they want. Put a short clarifying question in answer.

Field rules:
- now: the concise current value, in the user's terms ("kitchen drawer", "16x20x1", "tiramisu", "early flight, to make dinner"). For save/update only.
- entities: people and named entities mentioned (e.g. "Jamie", "Sam", "Piranesi"), for linking. Do not include the note's own title. Keep names as written.
- found / answer / source_notes: for recall and history only. Answer ONLY from the memories given. If the memories do not contain the answer, set found=false, answer="" and source_notes=[]. Never guess, never use general knowledge, never invent. For recall, answer in a few words with no date (the app appends when it was saved), e.g. "Green bag in the hall closet." For history, include the dates from the note. source_notes lists the exact ids you used.
- Leave fields that do not apply as "" / [] / false.
- Keep every reply short: this is a text message.

Actions (Apple Shortcuts). Add an entry to actions only when the message clearly calls for it; actions may accompany save (an appointment is both saved and put on the calendar). Use local wall-clock ISO date-times without offset ("2026-10-14T15:00:00") resolved against the current time given; if no end time, set end one hour after start. Unused action fields are "" or 0.
${actionLines}`;
}

export function decisionSchema(enabledActions: ShortcutAction[]): Record<string, unknown> {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["intent", "target_note", "title", "now", "entities", "found", "answer", "source_notes", "actions"],
    properties: {
      intent: { type: "string", enum: [...INTENTS] },
      target_note: str,
      title: str,
      now: str,
      entities: { type: "array", items: str },
      found: { type: "boolean" },
      answer: str,
      source_notes: { type: "array", items: str },
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action", "title", "start", "end", "notes", "minutes"],
          properties: {
            action: { type: "string", enum: enabledActions.length ? enabledActions : ["none"] },
            title: str,
            start: str,
            end: str,
            notes: str,
            minutes: { type: "integer" },
          },
        },
      },
    },
  };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function renderMemories(memories: Memory[], timeZone: string): string {
  if (memories.length === 0) return "<memories>\n(none saved yet)\n</memories>";
  const notes = memories.map(
    (m) =>
      `<note id="${escapeAttr(m.id)}" last_saved="${formatNoteDate(m.lastSaved, timeZone)}">\n${m.raw.trim()}\n</note>`,
  );
  return `<memories>\n${notes.join("\n")}\n</memories>`;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];

/** Validate/coerce the model's JSON into a Decision. Unknown shapes become "unclear". */
export function normalizeDecision(value: unknown, enabledActions: ShortcutAction[]): Decision {
  if (!value || typeof value !== "object") return { ...UNCLEAR };
  const v = value as Record<string, unknown>;
  const intent = INTENTS.includes(v.intent as Intent) ? (v.intent as Intent) : "unclear";
  const actions: ShortcutRequest[] = [];
  if (Array.isArray(v.actions)) {
    for (const a of v.actions) {
      if (!a || typeof a !== "object") continue;
      const r = a as Record<string, unknown>;
      const action = str(r.action);
      if (!isShortcutAction(action) || !enabledActions.includes(action)) continue;
      actions.push({
        action,
        title: str(r.title),
        start: str(r.start),
        end: str(r.end),
        notes: str(r.notes),
        minutes: typeof r.minutes === "number" && Number.isFinite(r.minutes) ? Math.max(0, Math.round(r.minutes)) : 0,
      });
    }
  }
  return {
    intent,
    target_note: str(v.target_note),
    title: str(v.title),
    now: str(v.now),
    entities: strArr(v.entities),
    found: v.found === true,
    answer: str(v.answer),
    source_notes: strArr(v.source_notes),
    actions,
  };
}

export class Brain {
  constructor(private readonly generate: GenerateJson) {}

  async decide(input: DecideInput): Promise<Decision> {
    const result = await this.generate({
      system: buildSystemPrompt(input.enabledActions),
      text: `Current time: ${describeNow(input.now, input.timeZone)}\n\n${renderMemories(
        input.memories,
        input.timeZone,
      )}\n\n<message>\n${input.message}\n</message>`,
      schema: decisionSchema(input.enabledActions),
      effort: "medium",
      maxTokens: 16000,
    });
    if (result.refused) return { ...UNCLEAR };
    return normalizeDecision(result.value, input.enabledActions);
  }
}
