// Photo memories (stretch goal). An inbound image plus an optional caption is
// described by the model's vision, the image is stored in the vault, and the
// note embeds it (![[...]]) so it shows in Obsidian. Recall of a photo note
// sends the original image back (see Pocket.handleText).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileAsync, type ExecFileFn } from "./exec.ts";
import type { GenerateJson } from "./llm.ts";

type VisionMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const VISION_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/** Per-image size limit for inline (base64) model input. */
const MAX_VISION_BYTES = 5 * 1024 * 1024;

export const EXT_BY_IMAGE_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heic",
};

export function isImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

export interface PreparedImage {
  /** Bytes to store in the vault (Obsidian-viewable). */
  stored: Buffer;
  storedExt: string;
  /** Bytes and type sent to the model. */
  vision: Buffer;
  visionType: VisionMediaType;
}

export interface PhotoDescription {
  title: string;
  now: string;
  entities: string[];
}

export class PhotoError extends Error {}

export class Photos {
  constructor(
    private readonly generate: GenerateJson,
    private readonly execFile: ExecFileFn = execFileAsync,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /**
   * Make the image viewable in Obsidian (HEIC → JPEG) and small enough for
   * the model (longest side 1568px) using macOS `sips`. Off macOS, only images
   * the model accepts as-is are supported.
   */
  async prepare(data: Buffer, mimeType: string): Promise<PreparedImage> {
    const type = mimeType.toLowerCase().split(";")[0]!.trim();
    const ext = EXT_BY_IMAGE_MIME[type] ?? "jpg";
    if (this.platform === "darwin") {
      const dir = await mkdtemp(join(tmpdir(), "pocket-photo-"));
      try {
        const src = join(dir, `in.${ext}`);
        await writeFile(src, data);
        let stored = data;
        let storedExt = ext;
        if (ext === "heic") {
          const jpg = join(dir, "stored.jpg");
          await this.execFile("sips", ["-s", "format", "jpeg", src, "--out", jpg], { timeout: 30_000 });
          stored = await readFile(jpg);
          storedExt = "jpg";
        }
        const small = join(dir, "vision.jpg");
        await this.execFile("sips", ["-s", "format", "jpeg", "-Z", "1568", src, "--out", small], {
          timeout: 30_000,
        });
        return { stored, storedExt, vision: await readFile(small), visionType: "image/jpeg" };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const visionType = type === "image/jpg" ? "image/jpeg" : type;
    if (!VISION_TYPES.includes(visionType)) throw new PhotoError(`Unsupported image type ${mimeType}`);
    if (data.length > MAX_VISION_BYTES) throw new PhotoError("Image too large");
    return { stored: data, storedExt: ext, vision: data, visionType: visionType as VisionMediaType };
  }

  /** Ask the model what the photo shows, as a memory title and current value. */
  async describe(image: PreparedImage, caption: string): Promise<PhotoDescription> {
    const result = await this.generate({
      image: { data: image.vision, mimeType: image.visionType },
      text: `The user sent this photo to their memory assistant so they can find it later.${
        caption ? ` Their caption: "${caption}".` : " There is no caption."
      }

Return JSON:
- title: a short note name for what this photo is about, based on the caption when given (e.g. "Bin 3", "Camping gear bin", "Parking spot", "Wine label").
- now: one line listing what is visible that they would search for later (labels, numbers, items, places), e.g. "camping stuff: tent, sleeping bags, lantern".
- entities: people or named things clearly identified by the caption or visible text; usually empty.`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "now", "entities"],
        properties: {
          title: { type: "string" },
          now: { type: "string" },
          entities: { type: "array", items: { type: "string" } },
        },
      },
      effort: "low",
      maxTokens: 2048,
    });
    if (result.refused) throw new PhotoError("The model declined to describe the photo");
    const json = result.value as Partial<PhotoDescription> | undefined;
    const title = typeof json?.title === "string" ? json.title.trim() : "";
    const now = typeof json?.now === "string" ? json.now.trim() : "";
    const entities = Array.isArray(json?.entities)
      ? json.entities.filter((e): e is string => typeof e === "string" && e.trim() !== "")
      : [];
    return {
      title: title || caption || "Photo",
      now: now || caption || "photo",
      entities,
    };
  }
}
