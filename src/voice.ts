// ElevenLabs speech: Scribe speech-to-text for inbound voice notes and
// text-to-speech for spoken answers. iMessage voice bubbles expect AAC/M4A,
// so the MP3 from ElevenLabs is converted locally with macOS `afconvert`.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileAsync, type ExecFileFn } from "./exec.ts";

const API = "https://api.elevenlabs.io/v1";

export interface VoiceOptions {
  apiKey: string | undefined;
  voiceId: string;
  sttModel: string;
  ttsModel: string;
}

export interface VoiceDeps {
  fetch?: typeof fetch;
  execFile?: ExecFileFn;
  platform?: NodeJS.Platform;
}

export interface SpokenAudio {
  data: Buffer;
  mimeType: string;
  name: string;
  /** Seconds, for the waveform UI. */
  duration?: number;
}

export class VoiceError extends Error {}

const EXT_BY_MIME: Record<string, string> = {
  "audio/x-caf": "caf",
  "audio/caf": "caf",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/amr": "amr",
};

export function extensionFor(mimeType: string, name?: string): string {
  const fromName = name && /\.([a-z0-9]{2,4})$/i.exec(name)?.[1];
  if (fromName) return fromName.toLowerCase();
  return EXT_BY_MIME[mimeType.toLowerCase().split(";")[0]!.trim()] ?? "m4a";
}

/** Parse `afinfo` output for the duration in seconds. */
export function parseAfinfoDuration(stdout: string): number | undefined {
  const m = /estimated duration:\s*([\d.]+)\s*sec/i.exec(stdout);
  return m ? Number(m[1]) : undefined;
}

export class Voice {
  private readonly fetch: typeof fetch;
  private readonly execFile: ExecFileFn;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly opts: VoiceOptions,
    deps: VoiceDeps = {},
  ) {
    this.fetch = deps.fetch ?? fetch;
    this.execFile = deps.execFile ?? execFileAsync;
    this.platform = deps.platform ?? process.platform;
  }

  get enabled(): boolean {
    return !!this.opts.apiKey;
  }

  private key(): string {
    if (!this.opts.apiKey) throw new VoiceError("ELEVENLABS_API_KEY is not set");
    return this.opts.apiKey;
  }

  /** Transcribe a voice note with ElevenLabs Scribe. */
  async transcribe(audio: Buffer, mimeType: string, name?: string): Promise<string> {
    const apiKey = this.key();
    let data = audio;
    let ext = extensionFor(mimeType, name);
    let type = mimeType;
    // iPhone voice notes are often CAF, which is safest to convert first.
    if (ext === "caf" && this.platform === "darwin") {
      data = await this.convert(audio, "caf", "m4a");
      ext = "m4a";
      type = "audio/mp4";
    }
    const form = new FormData();
    form.append("model_id", this.opts.sttModel);
    form.append("file", new Blob([new Uint8Array(data)], { type }), `voice-note.${ext}`);
    const res = await this.fetch(`${API}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
    if (!res.ok) throw new VoiceError(`ElevenLabs speech-to-text failed: HTTP ${res.status}`);
    const json = (await res.json()) as { text?: unknown };
    return typeof json.text === "string" ? json.text.trim() : "";
  }

  /** Speak text in Pocket's voice. Returns M4A on macOS, MP3 elsewhere. */
  async speak(text: string): Promise<SpokenAudio> {
    const apiKey = this.key();
    const res = await this.fetch(
      `${API}/text-to-speech/${encodeURIComponent(this.opts.voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: this.opts.ttsModel }),
      },
    );
    if (!res.ok) throw new VoiceError(`ElevenLabs text-to-speech failed: HTTP ${res.status}`);
    const mp3 = Buffer.from(await res.arrayBuffer());
    // 128 kbps MP3: a good fallback estimate when afinfo is unavailable.
    const estimate = Math.max(1, Math.round((mp3.length * 8) / 128_000));

    if (this.platform === "darwin") {
      try {
        const { data, duration } = await this.convertWithDuration(mp3, "mp3", "m4a");
        return { data, mimeType: "audio/mp4", name: "pocket.m4a", duration: duration ?? estimate };
      } catch (err) {
        console.warn("[voice] afconvert failed, sending MP3:", err);
      }
    }
    return { data: mp3, mimeType: "audio/mpeg", name: "pocket.mp3", duration: estimate };
  }

  private async convert(input: Buffer, fromExt: string, toExt: "m4a"): Promise<Buffer> {
    return (await this.convertWithDuration(input, fromExt, toExt)).data;
  }

  private async convertWithDuration(
    input: Buffer,
    fromExt: string,
    toExt: "m4a",
  ): Promise<{ data: Buffer; duration?: number }> {
    const dir = await mkdtemp(join(tmpdir(), "pocket-audio-"));
    try {
      const src = join(dir, `in.${fromExt}`);
      const dst = join(dir, `out.${toExt}`);
      await writeFile(src, input);
      await this.execFile("afconvert", ["-f", "m4af", "-d", "aac", src, dst], { timeout: 30_000 });
      let duration: number | undefined;
      try {
        duration = parseAfinfoDuration((await this.execFile("afinfo", [dst], { timeout: 10_000 })).stdout);
      } catch {
        duration = undefined;
      }
      return { data: await readFile(dst), duration };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
