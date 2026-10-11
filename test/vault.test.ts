import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseNote, sanitizeFileName, senderFolderName, Vault } from "../src/vault.ts";
import { formatNoteDate } from "../src/dates.ts";
import { SENDER, TZ, makeClock, tempDir } from "./helpers.ts";

let root: string;
let clock: ReturnType<typeof makeClock>;
let vault: Vault;

beforeEach(async () => {
  root = await tempDir();
  clock = makeClock("2026-10-10T17:00:00Z");
  vault = new Vault(root, TZ, clock.now);
});

describe("save", () => {
  it("writes one note per thing in the sender's folder", async () => {
    const m = await vault.save(SENDER, {
      title: "Spare keys",
      now: "green bag in the hall closet",
      original: "Spare keys are in the green bag in the hall closet",
    });
    const path = join(root, "+15551234567", "Spare keys.md");
    expect(m.path).toBe(path);
    const text = await readFile(path, "utf8");
    expect(text).toContain("# Spare keys");
    expect(text).toContain("**Now:** green bag in the hall closet  *(updated Oct 10, 2026)*");
    expect(text).toContain("## History");
    expect(text).toContain('- Oct 10, 2026: "Spare keys are in the green bag in the hall closet"');
    expect(m.now).toBe("green bag in the hall closet");
    expect(m.history).toHaveLength(1);
    expect(formatNoteDate(m.lastSaved, TZ)).toBe("Oct 10, 2026");
  });

  it("links people with wikilinks and creates stub notes for them", async () => {
    await vault.save(SENDER, {
      title: "Jamie's favorite dessert",
      now: "tiramisu",
      original: "Jamie's favorite dessert is tiramisu",
      entities: ["Jamie"],
    });
    const text = await readFile(join(root, SENDER, "Jamie's favorite dessert.md"), "utf8");
    expect(text).toContain("**Related:** [[+15551234567/Jamie|Jamie]]");
    expect(await readFile(join(root, SENDER, "Jamie.md"), "utf8")).toBe("# Jamie\n");
  });

  it("does not overwrite an existing person note", async () => {
    await mkdir(join(root, SENDER), { recursive: true });
    await writeFile(join(root, SENDER, "Sam.md"), "# Sam\nMy coworker\n");
    await vault.save(SENDER, { title: "Piranesi", now: "recommended by Sam", original: "Sam recommended Piranesi", entities: ["Sam"] });
    expect(await readFile(join(root, SENDER, "Sam.md"), "utf8")).toBe("# Sam\nMy coworker\n");
  });

  it("treats a save to an existing title as an update", async () => {
    await vault.save(SENDER, { title: "Air filter", now: "16x20x1", original: "air filter is 16x20x1" });
    clock.set("2026-10-12T17:00:00Z");
    const m = await vault.save(SENDER, { title: "Air filter", now: "16x25x1", original: "actually it's 16x25x1" });
    expect(m.now).toBe("16x25x1");
    expect(m.history.map((h) => h.text)).toEqual(["air filter is 16x20x1", "actually it's 16x25x1"]);
  });

  it("keeps senders separate", async () => {
    await vault.save(SENDER, { title: "Spare keys", now: "closet", original: "keys in closet" });
    await vault.save("bob@example.com", { title: "Parking", now: "level 3", original: "parked level 3" });
    expect((await vault.list(SENDER)).map((m) => m.id)).toEqual(["Spare keys"]);
    expect((await vault.list("bob@example.com")).map((m) => m.id)).toEqual(["Parking"]);
  });

  it("sanitizes titles and sender folder names", () => {
    expect(sanitizeFileName("a/b: c?")).toBe("a b c");
    expect(sanitizeFileName("../../etc")).toBe("etc");
    expect(sanitizeFileName("   ")).toBe("Memory");
    expect(senderFolderName("Alice@Example.com")).toBe("alice@example.com");
    expect(senderFolderName("../x")).toBe("__x");
  });
});

describe("update and history", () => {
  it("replaces Now and appends to History, keeping the old value", async () => {
    await vault.save(SENDER, {
      title: "Spare keys",
      now: "green bag in the hall closet",
      original: "I put the spare keys in the green bag in the hall closet.",
    });
    clock.set("2026-10-12T17:00:00Z");
    const m = await vault.update(SENDER, "Spare keys", {
      now: "kitchen drawer",
      original: "Moved the spare keys to the kitchen drawer.",
    });
    expect(m.now).toBe("kitchen drawer");
    expect(m.history).toHaveLength(2);
    expect(formatNoteDate(m.history[0]!.date!, TZ)).toBe("Oct 10, 2026");
    expect(m.history[0]!.text).toBe("I put the spare keys in the green bag in the hall closet.");
    expect(formatNoteDate(m.history[1]!.date!, TZ)).toBe("Oct 12, 2026");
    const text = await readFile(m.path, "utf8");
    expect(text).toContain("**Now:** kitchen drawer  *(updated Oct 12, 2026)*");
    expect(text).not.toContain("**Now:** green bag");
  });

  it("adds new related links without duplicating existing ones", async () => {
    await vault.save(SENDER, { title: "Dinner plan", now: "Friday", original: "dinner Friday with Jamie", entities: ["Jamie"] });
    const m = await vault.update(SENDER, "Dinner plan", {
      now: "Saturday",
      original: "dinner moved to Saturday, Sam is coming too",
      entities: ["Jamie", "Sam"],
    });
    const text = await readFile(m.path, "utf8");
    expect(text.match(/\|Jamie\]\]/g)).toHaveLength(1);
    expect(text).toContain("[[+15551234567/Sam|Sam]]");
  });

  it("throws when updating a note that does not exist", async () => {
    await expect(vault.update(SENDER, "Nope", { now: "x", original: "x" })).rejects.toThrow();
  });
});

describe("forget", () => {
  it("moves the note to the vault trash and out of the sender's memories", async () => {
    await vault.save(SENDER, { title: "Spare keys", now: "closet", original: "keys in closet" });
    expect(await vault.forget(SENDER, "Spare keys")).toBe(true);
    expect(existsSync(join(root, SENDER, "Spare keys.md"))).toBe(false);
    expect(await vault.list(SENDER)).toEqual([]);
    const trashed = await readdir(join(root, ".trash", SENDER));
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/^Spare keys \(forgotten .*\)\.md$/);
  });

  it("returns false for unknown notes and rejects path tricks", async () => {
    expect(await vault.forget(SENDER, "Nope")).toBe(false);
    expect(await vault.get(SENDER, "../other/Spare keys")).toBeUndefined();
  });
});

describe("tolerant parsing of hand-edited notes", () => {
  it("handles plain 'Now:' without bold or date, and history without dates", () => {
    const p = parseNote("# Bike lock\nNow: 4521\n\n## History\n- set the code to 4521\n", "x", 2026);
    expect(p.title).toBe("Bike lock");
    expect(p.now).toBe("4521");
    expect(p.nowUpdated).toBeUndefined();
    expect(p.history).toEqual([{ text: "set the code to 4521" }]);
  });

  it("handles frontmatter, ISO and year-less dates, and extra prose", () => {
    const raw = [
      "---",
      "tags: [home]",
      "---",
      "# Wifi",
      "Some notes I typed myself.",
      "**Now**: hunter2 *(updated 2026-09-01)*",
      "",
      "### History",
      "* 2026-08-01: “old password”",
      "* Sep 1: \"changed it\"",
      "",
      "## Other",
      "- not history",
    ].join("\n");
    const p = parseNote(raw, "x", 2026);
    expect(p.title).toBe("Wifi");
    expect(p.now).toBe("hunter2");
    expect(p.nowUpdated?.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(p.history.map((h) => h.text)).toEqual(["old password", "changed it"]);
    expect(p.history[1]!.date?.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("falls back to the file name when there is no heading or structure at all", () => {
    const p = parseNote("just some text the user wrote about [[Jamie]] and ![[pic.jpg]]", "Loose note");
    expect(p.title).toBe("Loose note");
    expect(p.now).toBeUndefined();
    expect(p.history).toEqual([]);
    expect(p.links).toEqual(["Jamie"]);
    expect(p.embeds).toEqual(["pic.jpg"]);
  });

  it("updates a hand-edited note while preserving the user's text", async () => {
    await mkdir(join(root, SENDER), { recursive: true });
    const raw = [
      "# Car",
      "My notes about the car.",
      "",
      "## History",
      "- Oct 1, 2026: \"parked on level 2\"",
      "",
      "## Thoughts",
      "Should get it washed.",
      "",
    ].join("\n");
    await writeFile(join(root, SENDER, "Car.md"), raw);
    clock.set("2026-10-11T17:00:00Z");
    const m = await vault.update(SENDER, "Car", { now: "level 3, row G", original: "Parked on level 3, row G" });
    const text = await readFile(m.path, "utf8");
    expect(text).toBe(
      [
        "# Car",
        "**Now:** level 3, row G  *(updated Oct 11, 2026)*",
        "My notes about the car.",
        "",
        "## History",
        "- Oct 1, 2026: \"parked on level 2\"",
        "- Oct 11, 2026: \"Parked on level 3, row G\"",
        "",
        "## Thoughts",
        "Should get it washed.",
        "",
      ].join("\n"),
    );
    expect(m.history).toHaveLength(2);
  });

  it("adds a History section when the user deleted it", async () => {
    await mkdir(join(root, SENDER), { recursive: true });
    await writeFile(join(root, SENDER, "Gym.md"), "# Gym\nNow: locker 12\n");
    const m = await vault.update(SENDER, "Gym", { now: "locker 40", original: "new locker is 40" });
    expect(m.now).toBe("locker 40");
    expect(m.history).toHaveLength(1);
    expect(await readFile(m.path, "utf8")).toContain("## History\n- Oct 10, 2026: \"new locker is 40\"");
  });
});

describe("attachments", () => {
  it("stores attachments per sender and never resolves another sender's files", async () => {
    const a = await vault.saveAttachment(SENDER, Buffer.from("img"), "Bin 3", "jpg");
    expect(a.vaultPath).toBe("+15551234567/attachments/bin-3.jpg");
    expect(vault.resolveEmbed(SENDER, a.vaultPath)).toBe(a.absPath);
    expect(vault.resolveEmbed(SENDER, "bin-3.jpg")).toBe(a.absPath);
    expect(vault.resolveEmbed("bob@example.com", a.vaultPath)).toBeUndefined();
    const b = await vault.saveAttachment(SENDER, Buffer.from("img2"), "Bin 3", "jpg");
    expect(b.vaultPath).toBe("+15551234567/attachments/bin-3-2.jpg");
  });
});
