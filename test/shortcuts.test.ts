import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseShortcutAllowlist } from "../src/config.ts";
import {
  DEFAULT_SHORTCUT_NAMES,
  SHORTCUTS,
  ShortcutNotAllowedError,
  ShortcutRunner,
  confirmationFor,
  type ExecFileFn,
  type ShortcutRequest,
} from "../src/shortcuts.ts";

const req = (partial: Partial<ShortcutRequest> & Pick<ShortcutRequest, "action">): ShortcutRequest => ({
  title: "",
  start: "",
  end: "",
  notes: "",
  minutes: 0,
  ...partial,
});

function recorder() {
  const calls: Array<{ file: string; args: string[]; input: string; inputPath: string; timeout: number }> = [];
  const exec: ExecFileFn = async (file, args, options) => {
    const inputPath = args[args.indexOf("--input-path") + 1]!;
    calls.push({ file, args, input: await readFile(inputPath, "utf8"), inputPath, timeout: options.timeout });
    return { stdout: "ok\n", stderr: "" };
  };
  return { calls, exec };
}

describe("allowlist enforcement", () => {
  it("runs only allowlisted Shortcuts, by their fixed name, via execFile argv", async () => {
    const r = recorder();
    const runner = new ShortcutRunner(["Pocket Reminder"], r.exec);
    expect(runner.enabledActions()).toEqual(["reminder"]);

    await runner.run(req({ action: "reminder", title: "Buy air filters", start: "2026-10-17T09:00:00" }));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.file).toBe("shortcuts");
    expect(r.calls[0]!.args).toEqual(["run", "Pocket Reminder", "--input-path", r.calls[0]!.inputPath]);
    expect(JSON.parse(r.calls[0]!.input)).toEqual({ title: "Buy air filters", due: "2026-10-17T09:00:00", notes: "" });
    expect(existsSync(r.calls[0]!.inputPath)).toBe(false); // temp input cleaned up

    await expect(runner.run(req({ action: "bedtime" }))).rejects.toBeInstanceOf(ShortcutNotAllowedError);
    expect(r.calls).toHaveLength(1);
  });

  it("rejects action names that are not in the built-in table, whatever the allowlist says", async () => {
    const r = recorder();
    const runner = new ShortcutRunner(["Delete All Files", ...DEFAULT_SHORTCUT_NAMES], r.exec);
    const bogus = { ...req({ action: "reminder" }), action: "Delete All Files" } as unknown as ShortcutRequest;
    await expect(runner.run(bogus)).rejects.toBeInstanceOf(ShortcutNotAllowedError);
    expect(runner.isEnabled("Delete All Files")).toBe(false);
    expect(runner.isEnabled("toString")).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  it("passes user text only inside the JSON input file, never as an argument", async () => {
    const r = recorder();
    const runner = new ShortcutRunner(DEFAULT_SHORTCUT_NAMES, r.exec);
    const evil = `"; rm -rf ~; echo "`;
    await runner.run(req({ action: "apple_note", title: evil, notes: "gift ideas for mom" }));
    expect(r.calls[0]!.args.slice(0, 2)).toEqual(["run", "Pocket Note"]);
    expect(r.calls[0]!.args.join(" ")).not.toContain("rm -rf");
    expect(JSON.parse(r.calls[0]!.input)).toEqual({ title: evil, body: "gift ideas for mom" });
  });

  it("sends Focus minutes with a default", async () => {
    const r = recorder();
    const runner = new ShortcutRunner(DEFAULT_SHORTCUT_NAMES, r.exec);
    await runner.run(req({ action: "focus", minutes: 120 }));
    await runner.run(req({ action: "focus" }));
    expect(r.calls.map((c) => JSON.parse(c.input))).toEqual([{ minutes: 120 }, { minutes: 60 }]);
  });
});

describe("configuration", () => {
  it("parses POCKET_SHORTCUTS_ALLOWLIST", () => {
    expect(parseShortcutAllowlist(undefined)).toEqual([...DEFAULT_SHORTCUT_NAMES]);
    expect(parseShortcutAllowlist("")).toEqual([...DEFAULT_SHORTCUT_NAMES]);
    expect(parseShortcutAllowlist("none")).toEqual([]);
    expect(parseShortcutAllowlist(" Pocket Reminder , Pocket Focus ,")).toEqual(["Pocket Reminder", "Pocket Focus"]);
  });

  it("has the documented Shortcut names", () => {
    expect(Object.values(SHORTCUTS).map((s) => s.name)).toEqual([
      "Pocket Calendar Event",
      "Pocket Reminder",
      "Pocket Note",
      "Pocket Bedtime",
      "Pocket Focus",
    ]);
  });
});

describe("confirmations", () => {
  it("confirms what was done", () => {
    expect(confirmationFor(req({ action: "reminder", title: "Buy air filters", start: "2026-10-17" }))).toBe(
      "Reminder set: Buy air filters, Sat, Oct 17.",
    );
    expect(confirmationFor(req({ action: "focus", minutes: 120 }))).toBe("Focus is on for 120 minutes.");
  });
});
