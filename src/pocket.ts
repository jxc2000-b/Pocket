// Core behavior, independent of Spectrum: route a message through Claude,
// apply it to the vault, run any allowlisted Shortcut, and describe what the
// transport should do (tapback, reply, extra messages, attachments).
//
// Reliability rule: every vault write is awaited here, before an Outcome with
// a 👍 is returned, so a 👍 always means the note is on disk.

import { Brain, type Decision } from "./brain.ts";
import { formatShortDate } from "./dates.ts";
import { SHORTCUTS, ShortcutRunner, confirmationFor } from "./shortcuts.ts";
import { isImageFile, type Memory, type Vault } from "./vault.ts";

export const NOT_FOUND = "You haven't told me that yet.";
export const SAVE_FAILED = "Sorry, I couldn't save that. Nothing was saved, please try again.";
export const VAULT_UNREADABLE = "Sorry, I couldn't open your memories right now. Nothing was saved.";
export const BRAIN_FAILED = "Sorry, I couldn't process that right now. Nothing was saved.";
export const MILESTONE = 100;

export interface Outcome {
  /** Tapback for the inbound message. */
  react?: "👍" | "❓";
  /** Answer to the specific question (sent as a threaded reply, or voice). */
  reply?: string;
  /** Extra short messages, e.g. Shortcut confirmations or errors. */
  notices: string[];
  /** Absolute file paths to send back (photo memories). */
  attachments: string[];
  /** Set when this save created the user's 100th memory. */
  milestone?: number;
  /** For logging. */
  intent?: Decision["intent"];
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?…)"”]$/.test(t) ? t : `${t}.`;
}

function fallbackTitle(text: string): string {
  return text.split(/\s+/).slice(0, 6).join(" ");
}

export class Pocket {
  constructor(
    readonly vault: Vault,
    readonly brain: Brain,
    readonly shortcuts: ShortcutRunner,
    readonly timeZone: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async handleText(sender: string, text: string): Promise<Outcome> {
    const out: Outcome = { notices: [], attachments: [] };
    const message = text.trim();
    if (!message) {
      out.react = "❓";
      return out;
    }

    let memories: Memory[];
    try {
      memories = await this.vault.list(sender);
    } catch (err) {
      console.error("[pocket] could not read vault:", err);
      out.reply = VAULT_UNREADABLE;
      return out;
    }
    let d: Decision;
    try {
      d = await this.brain.decide({
        message,
        memories,
        now: this.clock(),
        timeZone: this.timeZone,
        enabledActions: this.shortcuts.enabledActions(),
      });
    } catch (err) {
      console.error("[pocket] Claude call failed:", err);
      out.reply = BRAIN_FAILED;
      return out;
    }
    out.intent = d.intent;
    const byId = new Map(memories.map((m) => [m.id, m]));
    const findNote = (id: string): Memory | undefined =>
      byId.get(id) ?? memories.find((m) => m.id.toLowerCase() === id.toLowerCase() && id !== "");

    switch (d.intent) {
      case "save":
      case "update": {
        const target = findNote(d.target_note);
        const now = d.now || message;
        try {
          if (target) {
            await this.vault.update(sender, target.id, { now, original: message, entities: d.entities });
          } else {
            const title = d.title || d.target_note || fallbackTitle(message);
            await this.vault.save(sender, { title, now, original: message, entities: d.entities });
            if (memories.length + 1 === MILESTONE) out.milestone = MILESTONE;
          }
        } catch (err) {
          console.error("[pocket] vault write failed:", err);
          out.reply = SAVE_FAILED;
          return out; // no 👍, and no Shortcut actions for an unsaved memory
        }
        out.react = "👍";
        await this.runActions(d, out);
        return out;
      }

      case "recall":
      case "history": {
        const sources = d.source_notes.map(findNote).filter((m): m is Memory => !!m);
        if (!d.found || !d.answer || sources.length === 0) {
          out.reply = NOT_FOUND;
          return out;
        }
        if (d.intent === "recall") {
          const latest = sources.reduce((a, b) => (b.lastSaved > a.lastSaved ? b : a));
          out.reply = `${sentence(d.answer)} You saved that on ${formatShortDate(latest.lastSaved, this.timeZone, this.clock())}.`;
        } else {
          out.reply = sentence(d.answer);
        }
        for (const m of sources) {
          for (const e of m.embeds) {
            const path = this.vault.resolveEmbed(sender, e);
            if (path && isImageFile(path) && !out.attachments.includes(path)) out.attachments.push(path);
          }
        }
        return out;
      }

      case "forget": {
        const target = findNote(d.target_note);
        if (!target) {
          out.reply = "I couldn't find that memory, so there was nothing to forget.";
          return out;
        }
        try {
          await this.vault.forget(sender, target.id);
        } catch (err) {
          console.error("[pocket] forget failed:", err);
          out.reply = "Sorry, I couldn't forget that. It's still saved.";
          return out;
        }
        out.react = "👍";
        return out;
      }

      case "action": {
        if (d.actions.length === 0) {
          out.react = "❓";
          if (d.answer) out.reply = d.answer;
          return out;
        }
        await this.runActions(d, out);
        return out;
      }

      case "chat":
        out.reply = d.answer || "I'm Pocket. Text me anything you want to remember, then ask me later.";
        return out;

      case "unclear":
      default:
        out.react = "❓";
        if (d.answer) out.reply = d.answer;
        return out;
    }
  }

  private async runActions(d: Decision, out: Outcome): Promise<void> {
    for (const req of d.actions) {
      try {
        await this.shortcuts.run(req);
        out.notices.push(confirmationFor(req));
      } catch (err) {
        console.error(`[pocket] Shortcut "${SHORTCUTS[req.action].name}" failed:`, err);
        out.notices.push(`I couldn't run the "${SHORTCUTS[req.action].name}" Shortcut.`);
      }
    }
  }
}
