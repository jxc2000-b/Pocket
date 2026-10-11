// Apple Shortcuts bridge. Pocket can run ONLY the named Shortcuts below, and
// only when the name is also in the configured allowlist. The Shortcut name
// always comes from this table, never from user text, and the process is
// started with execFile (no shell), so user text can only ever reach a
// Shortcut as its input file.

import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ShortcutAction = "calendar_event" | "reminder" | "apple_note" | "bedtime" | "focus";

export interface ShortcutSpec {
  /** Exact Shortcut name the user must create on the Mac. */
  name: string;
  /** When the model should pick it. */
  when: string;
  /** True for actions with physical or attention side effects (HomeKit, Focus). */
  sideEffect: boolean;
}

export const SHORTCUTS: Record<ShortcutAction, ShortcutSpec> = {
  calendar_event: {
    name: "Pocket Calendar Event",
    when: "The message mentions a specific appointment/event with a day or time (e.g. 'Dentist Tuesday at 3pm'). Fill title, start, end.",
    sideEffect: false,
  },
  reminder: {
    name: "Pocket Reminder",
    when: "The user asks to be reminded to do something (e.g. 'Remind me to buy air filters Saturday'). Fill title and start (the due date/time, or empty).",
    sideEffect: false,
  },
  apple_note: {
    name: "Pocket Note",
    when: "The user explicitly asks to save something as an Apple Note (e.g. 'Save this as a note: ...'). Fill title and notes (the full body).",
    sideEffect: false,
  },
  bedtime: {
    name: "Pocket Bedtime",
    when: "The user says they are going to bed / heading to sleep. Runs the HomeKit bedtime scene (lights off).",
    sideEffect: true,
  },
  focus: {
    name: "Pocket Focus",
    when: "The user says they are studying/working/focusing for a while (e.g. 'I'm studying for 2 hours'). Fill minutes.",
    sideEffect: true,
  },
};

export const DEFAULT_SHORTCUT_NAMES: readonly string[] = Object.values(SHORTCUTS).map((s) => s.name);

export interface ShortcutRequest {
  action: ShortcutAction;
  title: string;
  /** ISO-8601 local date-time, e.g. "2026-10-14T15:00:00", or "". */
  start: string;
  /** ISO-8601 local date-time, or "". */
  end: string;
  notes: string;
  /** Duration in minutes, 0 when not applicable. */
  minutes: number;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFileCb(file, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });

export class ShortcutNotAllowedError extends Error {}

export function isShortcutAction(value: string): value is ShortcutAction {
  return Object.prototype.hasOwnProperty.call(SHORTCUTS, value);
}

export class ShortcutRunner {
  private readonly allow: Set<string>;

  constructor(
    allowlist: readonly string[],
    private readonly execFile: ExecFileFn = defaultExecFile,
  ) {
    this.allow = new Set(allowlist);
  }

  /** Actions whose Shortcut name is in the allowlist. */
  enabledActions(): ShortcutAction[] {
    return (Object.keys(SHORTCUTS) as ShortcutAction[]).filter((a) => this.allow.has(SHORTCUTS[a].name));
  }

  isEnabled(action: string): action is ShortcutAction {
    return isShortcutAction(action) && this.allow.has(SHORTCUTS[action].name);
  }

  /** JSON handed to the Shortcut as its input (read with "Get Dictionary from Input"). */
  static inputFor(req: ShortcutRequest): Record<string, string | number> {
    switch (req.action) {
      case "calendar_event":
        return { title: req.title, start: req.start, end: req.end, notes: req.notes };
      case "reminder":
        return { title: req.title, due: req.start, notes: req.notes };
      case "apple_note":
        return { title: req.title, body: req.notes };
      case "bedtime":
        return {};
      case "focus":
        return { minutes: req.minutes > 0 ? req.minutes : 60 };
    }
  }

  /** Run the allowlisted Shortcut for an action. Throws ShortcutNotAllowedError otherwise. */
  async run(req: ShortcutRequest): Promise<string> {
    if (!this.isEnabled(req.action)) {
      throw new ShortcutNotAllowedError(`Shortcut action "${String(req.action)}" is not allowlisted`);
    }
    const name = SHORTCUTS[req.action].name;
    const dir = await mkdtemp(join(tmpdir(), "pocket-shortcut-"));
    try {
      const inputPath = join(dir, "input.json");
      await writeFile(inputPath, JSON.stringify(ShortcutRunner.inputFor(req)), "utf8");
      const { stdout } = await this.execFile("shortcuts", ["run", name, "--input-path", inputPath], {
        timeout: 60_000,
      });
      return stdout.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Short confirmation text for a completed action. */
export function confirmationFor(req: ShortcutRequest): string {
  const when = formatWhen(req.start);
  switch (req.action) {
    case "calendar_event":
      return `Added to your calendar: ${req.title}${when ? `, ${when}` : ""}.`;
    case "reminder":
      return `Reminder set: ${req.title}${when ? `, ${when}` : ""}.`;
    case "apple_note":
      return `Saved to Apple Notes: ${req.title || "new note"}.`;
    case "bedtime":
      return "Done. Bedtime scene is on. Good night.";
    case "focus":
      return `Focus is on for ${req.minutes > 0 ? req.minutes : 60} minutes.`;
  }
}

function formatWhen(iso: string): string {
  if (!iso) return "";
  // The model gives local wall-clock time without an offset; format it as-is.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, m[4] ? +m[4] : 12, m[5] ? +m[5] : 0));
  const opts: Intl.DateTimeFormatOptions = { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" };
  if (m[4]) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  return new Intl.DateTimeFormat("en-US", opts).format(d);
}
