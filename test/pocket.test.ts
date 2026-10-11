import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Brain } from "../src/brain.ts";
import { BRAIN_FAILED, NOT_FOUND, Pocket, SAVE_FAILED, VAULT_UNREADABLE } from "../src/pocket.ts";
import { ShortcutRunner, type ExecFileFn } from "../src/shortcuts.ts";
import { Vault } from "../src/vault.ts";
import { SENDER, TZ, decision, makeClock, mockClaude, tempDir } from "./helpers.ts";

let root: string;
let clock: ReturnType<typeof makeClock>;
let execCalls: Array<{ file: string; args: string[]; input: string }>;

const recordingExec: ExecFileFn = async (file, args) => {
  const inputPath = args[args.indexOf("--input-path") + 1]!;
  execCalls.push({ file, args, input: await readFile(inputPath, "utf8") });
  return { stdout: "", stderr: "" };
};

function makePocket(claude: ReturnType<typeof mockClaude>, allowlist = ["Pocket Calendar Event", "Pocket Bedtime"]) {
  const vault = new Vault(root, TZ, clock.now);
  const runner = new ShortcutRunner(allowlist, recordingExec);
  return { vault, pocket: new Pocket(vault, new Brain(claude), runner, TZ, clock.now) };
}

beforeEach(async () => {
  root = await tempDir();
  clock = makeClock("2026-10-10T17:00:00Z");
  execCalls = [];
});

describe("save / recall / update / history / forget / unknown", () => {
  it("runs the full memory lifecycle", async () => {
    const claude = mockClaude(
      decision({
        intent: "save",
        title: "Spare keys",
        now: "green bag in the hall closet",
      }),
      decision({ intent: "recall", found: true, answer: "Green bag in the hall closet", source_notes: ["Spare keys"] }),
      decision({ intent: "update", target_note: "Spare keys", now: "kitchen drawer" }),
      decision({ intent: "recall", found: true, answer: "Kitchen drawer", source_notes: ["Spare keys"] }),
      decision({
        intent: "history",
        found: true,
        answer: "On Oct 10 they were in the green bag in the hall closet",
        source_notes: ["Spare keys"],
      }),
      decision({ intent: "forget", target_note: "Spare keys" }),
      decision({ intent: "recall", found: false }),
    );
    const { pocket, vault } = makePocket(claude);
    const path = join(root, SENDER, "Spare keys.md");

    // Save: note is on disk by the time the 👍 outcome is returned.
    let out = await pocket.handleText(SENDER, "Spare keys are in the green bag in the hall closet");
    expect(out.react).toBe("👍");
    expect(out.reply).toBeUndefined();
    expect(existsSync(path)).toBe(true);

    // Recall, with save date.
    out = await pocket.handleText(SENDER, "Where are my spare keys?");
    expect(out.reply).toBe("Green bag in the hall closet. You saved that on Oct 10.");
    expect(out.react).toBeUndefined();

    // Update two days later.
    clock.set("2026-10-12T18:00:00Z");
    out = await pocket.handleText(SENDER, "Moved the keys to the kitchen drawer");
    expect(out.react).toBe("👍");
    const m = (await vault.get(SENDER, "Spare keys"))!;
    expect(m.now).toBe("kitchen drawer");
    expect(m.history.map((h) => h.text)).toEqual([
      "Spare keys are in the green bag in the hall closet",
      "Moved the keys to the kitchen drawer",
    ]);

    out = await pocket.handleText(SENDER, "Where are the keys?");
    expect(out.reply).toBe("Kitchen drawer. You saved that on Oct 12.");

    out = await pocket.handleText(SENDER, "Where did the keys used to be?");
    expect(out.reply).toBe("On Oct 10 they were in the green bag in the hall closet.");

    out = await pocket.handleText(SENDER, "Forget where I keep my keys");
    expect(out.react).toBe("👍");
    expect(existsSync(path)).toBe(false);

    out = await pocket.handleText(SENDER, "Where are my keys?");
    expect(out.reply).toBe(NOT_FOUND);

    // The memories handed to Claude are this sender's notes.
    const recallPrompt = claude.calls[1]!.messages[0]!.content as string;
    expect(recallPrompt).toContain('<note id="Spare keys"');
  });

  it("answers 'You haven't told me that yet.' when Claude cites a note that does not exist", async () => {
    const { pocket } = makePocket(
      mockClaude(decision({ intent: "recall", found: true, answer: "A1234567", source_notes: ["Passport"] })),
    );
    const out = await pocket.handleText(SENDER, "What's my passport number?");
    expect(out.reply).toBe(NOT_FOUND);
  });

  it("answers not-found when found=false even if an answer was produced", async () => {
    const { pocket, vault } = makePocket(
      mockClaude(decision({ intent: "recall", found: false, answer: "Probably the drawer", source_notes: ["Spare keys"] })),
    );
    await vault.save(SENDER, { title: "Spare keys", now: "closet", original: "keys in closet" });
    const out = await pocket.handleText(SENDER, "Where's my passport?");
    expect(out.reply).toBe(NOT_FOUND);
  });

  it("keeps users' memories separate", async () => {
    const claude = mockClaude(
      decision({ intent: "save", title: "Spare keys", now: "closet" }),
      decision({ intent: "recall", found: false }),
    );
    const { pocket } = makePocket(claude);
    await pocket.handleText(SENDER, "keys in the closet");
    await pocket.handleText("bob@example.com", "where are my keys?");
    expect(claude.calls[1]!.messages[0]!.content as string).toContain("(none saved yet)");
  });

  it("does not 👍 when the write fails", async () => {
    class FailingVault extends Vault {
      override async save(): Promise<never> {
        throw new Error("disk full");
      }
    }
    const vault = new FailingVault(root, TZ, clock.now);
    const claude = mockClaude(decision({ intent: "save", title: "Spare keys", now: "closet" }));
    const pocket = new Pocket(vault, new Brain(claude), new ShortcutRunner([], recordingExec), TZ, clock.now);
    const out = await pocket.handleText(SENDER, "keys in the closet");
    expect(out.react).toBeUndefined();
    expect(out.reply).toBe(SAVE_FAILED);
  });

  it("does not call Claude or 👍 when the vault cannot be read", async () => {
    await writeFile(join(root, SENDER), "not a folder");
    const claude = mockClaude(decision({ intent: "save", title: "Spare keys", now: "closet" }));
    const { pocket } = makePocket(claude);
    const out = await pocket.handleText(SENDER, "keys in the closet");
    expect(out.react).toBeUndefined();
    expect(out.reply).toBe(VAULT_UNREADABLE);
    expect(claude.calls).toHaveLength(0);
  });

  it("says so plainly when Claude is unreachable", async () => {
    const { pocket } = makePocket(mockClaude(new Error("boom")));
    const out = await pocket.handleText(SENDER, "keys in the closet");
    expect(out.reply).toBe(BRAIN_FAILED);
    expect(out.react).toBeUndefined();
  });

  it("reacts ❓ when unclear", async () => {
    const { pocket } = makePocket(mockClaude(decision({ intent: "unclear", answer: "What should I remember?" })));
    const out = await pocket.handleText(SENDER, "hmm");
    expect(out.react).toBe("❓");
    expect(out.reply).toBe("What should I remember?");
  });

  it("falls back to a new note when update targets an unknown note", async () => {
    const { pocket, vault } = makePocket(
      mockClaude(decision({ intent: "update", target_note: "Nope", title: "Bike", now: "garage" })),
    );
    const out = await pocket.handleText(SENDER, "bike is in the garage");
    expect(out.react).toBe("👍");
    expect((await vault.get(SENDER, "Bike"))?.now).toBe("garage");
  });

  it("reports when there is nothing to forget", async () => {
    const { pocket } = makePocket(mockClaude(decision({ intent: "forget", target_note: "Nope" })));
    const out = await pocket.handleText(SENDER, "forget my locker code");
    expect(out.react).toBeUndefined();
    expect(out.reply).toMatch(/couldn't find/);
  });
});

describe("Shortcuts from messages", () => {
  it("saves the memory and creates a Calendar event", async () => {
    const { pocket, vault } = makePocket(
      mockClaude(
        decision({
          intent: "save",
          title: "Dentist",
          now: "Tuesday Oct 13, 3pm",
          actions: [
            { action: "calendar_event", title: "Dentist", start: "2026-10-13T15:00:00", end: "2026-10-13T16:00:00", notes: "", minutes: 0 },
          ],
        }),
      ),
    );
    const out = await pocket.handleText(SENDER, "Dentist Tuesday 3pm");
    expect(out.react).toBe("👍");
    expect(await vault.get(SENDER, "Dentist")).toBeDefined();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.file).toBe("shortcuts");
    expect(execCalls[0]!.args.slice(0, 3)).toEqual(["run", "Pocket Calendar Event", "--input-path"]);
    expect(JSON.parse(execCalls[0]!.input)).toEqual({
      title: "Dentist",
      start: "2026-10-13T15:00:00",
      end: "2026-10-13T16:00:00",
      notes: "",
    });
    expect(out.notices).toEqual(["Added to your calendar: Dentist, Tue, Oct 13, 3:00 PM."]);
  });

  it("confirms side-effect actions and saves nothing for action-only messages", async () => {
    const { pocket, vault } = makePocket(
      mockClaude(
        decision({
          intent: "action",
          actions: [{ action: "bedtime", title: "", start: "", end: "", notes: "", minutes: 0 }],
        }),
      ),
    );
    const out = await pocket.handleText(SENDER, "I'm heading to bed");
    expect(execCalls.map((c) => c.args[1])).toEqual(["Pocket Bedtime"]);
    expect(out.notices[0]).toMatch(/Bedtime scene is on/);
    expect(await vault.list(SENDER)).toEqual([]);
  });

  it("never runs a Shortcut that is not allowlisted, even if Claude asks", async () => {
    const { pocket } = makePocket(
      mockClaude(
        decision({
          intent: "action",
          actions: [{ action: "focus", title: "", start: "", end: "", notes: "", minutes: 120 }],
        }),
      ),
      ["Pocket Calendar Event"],
    );
    const out = await pocket.handleText(SENDER, "I'm studying for 2 hours");
    expect(execCalls).toEqual([]);
    expect(out.react).toBe("❓");
  });
});
