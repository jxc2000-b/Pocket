import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Brain } from "../src/brain.ts";
import type { ExecFileFn } from "../src/exec.ts";
import { Photos, PhotoError, isImageMime } from "../src/photos.ts";
import { Pocket } from "../src/pocket.ts";
import { ShortcutRunner } from "../src/shortcuts.ts";
import { Vault } from "../src/vault.ts";
import { SENDER, TZ, decision, makeClock, mockLlm, tempDir } from "./helpers.ts";

let root: string;
let clock: ReturnType<typeof makeClock>;

beforeEach(async () => {
  root = await tempDir();
  clock = makeClock("2026-10-10T17:00:00Z");
});

describe("Photos.prepare", () => {
  it("uses supported images as-is off macOS and rejects others", async () => {
    const p = new Photos(mockLlm(), undefined, "linux");
    const img = await p.prepare(Buffer.from("png"), "image/png");
    expect(img).toMatchObject({ storedExt: "png", visionType: "image/png" });
    await expect(p.prepare(Buffer.from("heic"), "image/heic")).rejects.toBeInstanceOf(PhotoError);
    await expect(p.prepare(Buffer.alloc(6 * 1024 * 1024), "image/jpeg")).rejects.toBeInstanceOf(PhotoError);
  });

  it("converts HEIC to JPEG and downsizes for Claude with sips on macOS", async () => {
    const calls: string[][] = [];
    const exec: ExecFileFn = async (file, args) => {
      calls.push([file, ...args]);
      await writeFile(args[args.length - 1]!, args.includes("-Z") ? "small-jpeg" : "full-jpeg");
      return { stdout: "", stderr: "" };
    };
    const img = await new Photos(mockLlm(), exec, "darwin").prepare(Buffer.from("heic"), "image/heic");
    expect(calls.every((c) => c[0] === "sips")).toBe(true);
    expect(img.storedExt).toBe("jpg");
    expect(img.stored.toString()).toBe("full-jpeg");
    expect(img.vision.toString()).toBe("small-jpeg");
    expect(img.visionType).toBe("image/jpeg");
  });

  it("recognizes image MIME types", () => {
    expect(isImageMime("image/jpeg")).toBe(true);
    expect(isImageMime("audio/mp4")).toBe(false);
  });
});

describe("photo memories end to end (model mocked)", () => {
  it("saves the image in the vault, embeds it, 👍, and sends it back on recall", async () => {
    const claude = mockLlm(
      { title: "Bin 3", now: "camping stuff: tent, sleeping bags, lantern", entities: [] },
      decision({ intent: "recall", found: true, answer: "Bin 3", source_notes: ["Bin 3"] }),
    );
    const vault = new Vault(root, TZ, clock.now);
    const brain = new Brain(claude);
    const pocket = new Pocket(vault, brain, new ShortcutRunner([]), TZ, clock.now, new Photos(claude, undefined, "linux"));

    const out = await pocket.handlePhoto(SENDER, Buffer.from("jpeg-bytes"), "image/jpeg", "camping stuff");
    expect(out.react).toBe("👍");

    const imagePath = join(root, SENDER, "attachments", "bin-3.jpg");
    expect(await readFile(imagePath, "utf8")).toBe("jpeg-bytes");
    const note = await readFile(join(root, SENDER, "Bin 3.md"), "utf8");
    expect(note).toContain("![[+15551234567/attachments/bin-3.jpg]]");
    expect(note).toContain("**Now:** camping stuff: tent, sleeping bags, lantern");
    expect(note).toContain('"camping stuff (photo)"');

    // The vision request carried the image and caption.
    const vision = claude.calls[0]!;
    expect(vision.image).toEqual({ data: Buffer.from("jpeg-bytes"), mimeType: "image/jpeg" });
    expect(vision.text).toContain('"camping stuff"');

    const recall = await pocket.handleText(SENDER, "Which bin has my tent?");
    expect(recall.reply).toBe("Bin 3. You saved that on Oct 10.");
    expect(recall.attachments).toEqual([imagePath]);
  });

  it("does not 👍 when the photo cannot be read", async () => {
    const claude = mockLlm();
    const pocket = new Pocket(
      new Vault(root, TZ, clock.now),
      new Brain(claude),
      new ShortcutRunner([]),
      TZ,
      clock.now,
      new Photos(claude, undefined, "linux"),
    );
    const out = await pocket.handlePhoto(SENDER, Buffer.from("x"), "image/tiff");
    expect(out.react).toBeUndefined();
    expect(out.reply).toMatch(/can't read that photo/);
    expect(existsSync(join(root, SENDER))).toBe(false);
  });
});
