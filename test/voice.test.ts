import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ExecFileFn } from "../src/exec.ts";
import { Voice, extensionFor, parseAfinfoDuration } from "../src/voice.ts";

const opts = { apiKey: "test-key", voiceId: "voice123", sttModel: "scribe_v1", ttsModel: "eleven_multilingual_v2" };

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return handler(String(url), init!);
  }) as typeof fetch;
  return { fn, calls };
}

describe("Voice.transcribe", () => {
  it("posts the audio to ElevenLabs Scribe and returns the text", async () => {
    const f = fakeFetch(() => Response.json({ text: " Parked on level 3, row G " }));
    const v = new Voice(opts, { fetch: f.fn, platform: "linux" });
    const text = await v.transcribe(Buffer.from("audio"), "audio/mp4", "note.m4a");
    expect(text).toBe("Parked on level 3, row G");
    expect(f.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect((f.calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    const form = f.calls[0]!.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v1");
    expect((form.get("file") as File).name).toBe("voice-note.m4a");
  });

  it("converts CAF to M4A on macOS before uploading", async () => {
    const execs: string[][] = [];
    const exec: ExecFileFn = async (file, args) => {
      execs.push([file, ...args]);
      if (file === "afconvert") await writeFile(args[args.length - 1]!, "m4a-bytes");
      return { stdout: "estimated duration: 2.5 sec", stderr: "" };
    };
    const f = fakeFetch(() => Response.json({ text: "hi" }));
    const v = new Voice(opts, { fetch: f.fn, execFile: exec, platform: "darwin" });
    await v.transcribe(Buffer.from("caf"), "audio/x-caf");
    expect(execs[0]!.slice(0, 5)).toEqual(["afconvert", "-f", "m4af", "-d", "aac"]);
    const file = (f.calls[0]!.init.body as FormData).get("file") as File;
    expect(file.name).toBe("voice-note.m4a");
    expect(await file.text()).toBe("m4a-bytes");
  });

  it("throws on HTTP errors and when no key is configured", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 401 }));
    await expect(new Voice(opts, { fetch: f.fn }).transcribe(Buffer.from("a"), "audio/mp4")).rejects.toThrow(/401/);
    const off = new Voice({ ...opts, apiKey: undefined });
    expect(off.enabled).toBe(false);
    await expect(off.transcribe(Buffer.from("a"), "audio/mp4")).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});

describe("Voice.speak", () => {
  it("requests TTS with the configured voice and converts to M4A with duration on macOS", async () => {
    const f = fakeFetch(() => new Response(new Uint8Array(32000)));
    const exec: ExecFileFn = async (file, args) => {
      if (file === "afconvert") await writeFile(args[args.length - 1]!, "m4a");
      return { stdout: file === "afinfo" ? "File: out.m4a\nestimated duration: 3.250 sec\n" : "", stderr: "" };
    };
    const v = new Voice(opts, { fetch: f.fn, execFile: exec, platform: "darwin" });
    const audio = await v.speak("Level 3, row G.");
    expect(f.calls[0]!.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128",
    );
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({
      text: "Level 3, row G.",
      model_id: "eleven_multilingual_v2",
    });
    expect(audio).toMatchObject({ mimeType: "audio/mp4", name: "pocket.m4a", duration: 3.25 });
    expect(audio.data.toString()).toBe("m4a");
  });

  it("falls back to MP3 with an estimated duration off macOS", async () => {
    const f = fakeFetch(() => new Response(new Uint8Array(32000)));
    const audio = await new Voice(opts, { fetch: f.fn, platform: "linux" }).speak("hi");
    expect(audio).toMatchObject({ mimeType: "audio/mpeg", name: "pocket.mp3", duration: 2 });
  });
});

describe("helpers", () => {
  it("parses afinfo duration and picks extensions", () => {
    expect(parseAfinfoDuration("estimated duration: 12.04 sec")).toBe(12.04);
    expect(parseAfinfoDuration("nothing")).toBeUndefined();
    expect(extensionFor("audio/x-caf")).toBe("caf");
    expect(extensionFor("application/octet-stream", "Audio Message.caf")).toBe("caf");
    expect(extensionFor("weird/type")).toBe("m4a");
  });
});
