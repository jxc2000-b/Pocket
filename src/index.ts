// Pocket Memory: an iMessage contact that remembers things for you.
// Spectrum delivers messages from the cloud iMessage line; this process runs
// on the user's Mac, where the Obsidian vault and `shortcuts` live.
// Docs: https://photon.codes/docs/spectrum-ts

import { Spectrum, attachment, voice, type ContentInput, type Message, type Space } from "spectrum-ts";
import { effect, imessage } from "spectrum-ts/providers/imessage";
import { Brain } from "./brain.ts";
import { loadConfig } from "./config.ts";
import { claudeGenerateJson, geminiGenerateJson } from "./llm.ts";
import { Photos, isImageMime } from "./photos.ts";
import { Pocket, type Outcome } from "./pocket.ts";
import { ShortcutRunner } from "./shortcuts.ts";
import { Vault } from "./vault.ts";
import { Voice } from "./voice.ts";

// Load ./.env into process.env (values already set in the environment win).
try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}

const config = loadConfig();
const vault = new Vault(config.vaultPath, config.timeZone);
const shortcuts = new ShortcutRunner(config.shortcutAllowlist);
const generate =
  config.llm.provider === "gemini"
    ? geminiGenerateJson(config.llm.apiKey, [config.llm.model, config.llm.fallbackModel])
    : claudeGenerateJson(config.llm.model);
const brain = new Brain(generate);
const pocket = new Pocket(vault, brain, shortcuts, config.timeZone, undefined, new Photos(generate));
const speech = new Voice(config.elevenLabs);

const app = await Spectrum({
  projectId: config.projectId,
  projectSecret: config.projectSecret,
  providers: [imessage.config()],
});

console.log(`[pocket] running on ${config.llm.provider} (${config.llm.model}). Vault: ${config.vaultPath}`);
if (!speech.enabled) console.warn("[pocket] ELEVENLABS_API_KEY not set: voice notes are disabled.");
console.log(`[pocket] Shortcuts enabled: ${shortcuts.enabledActions().join(", ") || "none"}`);

// One message at a time per sender, so notes are never written concurrently
// and replies stay in order. Different senders run in parallel.
const queues = new Map<string, Promise<void>>();
function enqueue(sender: string, job: () => Promise<void>): void {
  const prev = queues.get(sender) ?? Promise.resolve();
  const next = prev
    .then(job)
    .catch((err) => console.error(`[pocket] error handling message from ${sender}:`, err))
    .finally(() => {
      if (queues.get(sender) === next) queues.delete(sender);
    });
  queues.set(sender, next);
}

// Photo captions usually arrive as a separate text right after the image.
// When an image comes in, wait briefly for a short, non-question text from the
// same sender and use it as the caption instead of handling it separately.
const CAPTION_WAIT_MS = 5_000;
const captionWaiters = new Map<string, (text: string) => void>();

function expectCaption(sender: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const settle = (text: string) => {
      clearTimeout(timer);
      if (captionWaiters.get(sender) === settle) captionWaiters.delete(sender);
      resolve(text);
    };
    const timer = setTimeout(() => settle(""), CAPTION_WAIT_MS);
    captionWaiters.get(sender)?.(""); // an earlier photo stops waiting
    captionWaiters.set(sender, settle);
  });
}

function offerCaption(sender: string, text: string): boolean {
  const settle = captionWaiters.get(sender);
  if (!settle || text.length > 200 || text.trim().endsWith("?")) return false;
  settle(text);
  return true;
}

/** One-on-one chats only (group chats need the Business plan). */
function isDirectChat(space: Space, message: Message): boolean {
  if (message.platform !== "imessage") return false;
  return imessage(space).type === "dm";
}

/** Threaded reply; if the provider skips it, send into the chat instead. */
async function replyTo(space: Space, message: Message, content: ContentInput): Promise<void> {
  const sent = await message.reply(content);
  if (!sent) await space.send(content);
}

async function deliver(space: Space, message: Message, outcome: Outcome, spoken: boolean): Promise<void> {
  if (outcome.react) await message.react(outcome.react);
  if (outcome.reply) {
    let sentAsVoice = false;
    if (spoken && speech.enabled) {
      try {
        const audio = await speech.speak(outcome.reply);
        await replyTo(
          space,
          message,
          voice(audio.data, { name: audio.name, mimeType: audio.mimeType, duration: audio.duration }),
        );
        sentAsVoice = true;
      } catch (err) {
        console.error("[pocket] text-to-speech failed, replying in text:", err);
      }
    }
    if (!sentAsVoice) await replyTo(space, message, outcome.reply);
  }
  for (const path of outcome.attachments) await space.send(attachment(path));
  for (const notice of outcome.notices) await space.send(notice);
  if (outcome.milestone) {
    await space.send(
      effect(`That's ${outcome.milestone} memories saved!`, imessage.effect.message.confetti),
    );
  }
}

async function handle(
  space: Space,
  message: Message,
  sender: string,
  captionPromise?: Promise<string>,
): Promise<void> {
  const content = message.content;
  switch (content.type) {
    case "text": {
      await space.responding(async () => {
        const outcome = await pocket.handleText(sender, content.text);
        console.log(`[pocket] ${sender}: text -> ${outcome.intent ?? "?"}`);
        await deliver(space, message, outcome, false);
      });
      return;
    }
    case "voice": {
      await space.responding(async () => {
        if (!speech.enabled) {
          await replyTo(space, message, "Voice notes aren't set up yet. Please text me instead.");
          return;
        }
        let transcript: string;
        try {
          transcript = await speech.transcribe(await content.read(), content.mimeType, content.name);
        } catch (err) {
          console.error("[pocket] transcription failed:", err);
          await replyTo(space, message, "Sorry, I couldn't transcribe that voice note. Nothing was saved.");
          return;
        }
        if (!transcript) {
          await message.react("❓");
          await replyTo(space, message, "I couldn't make out that voice note.");
          return;
        }
        const outcome = await pocket.handleText(sender, transcript);
        console.log(`[pocket] ${sender}: voice -> ${outcome.intent ?? "?"}`);
        await deliver(space, message, outcome, true);
      });
      return;
    }
    case "attachment": {
      if (!isImageMime(content.mimeType)) return;
      const caption = captionPromise ? await captionPromise : "";
      await space.responding(async () => {
        const outcome = await pocket.handlePhoto(sender, await content.read(), content.mimeType, caption);
        console.log(`[pocket] ${sender}: photo -> ${outcome.react ? "saved" : "not saved"}`);
        await deliver(space, message, outcome, false);
      });
      return;
    }
    case "group": {
      // A photo sent together with its caption may arrive as one group.
      const items = content.items.map((m) => m.content);
      const image = items.find((c) => c.type === "attachment" && isImageMime(c.mimeType));
      const caption = items
        .flatMap((c) => (c.type === "text" ? [c.text] : []))
        .join(" ")
        .trim();
      if (image?.type === "attachment") {
        await space.responding(async () => {
          const outcome = await pocket.handlePhoto(sender, await image.read(), image.mimeType, caption);
          await deliver(space, message, outcome, false);
        });
      } else if (caption) {
        await space.responding(async () => {
          await deliver(space, message, await pocket.handleText(sender, caption), false);
        });
      }
      return;
    }
    default:
      return; // reactions, typing, read receipts, etc.
  }
}

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue; // never react to our own sends
  const sender = message.sender?.id;
  if (!sender) continue;
  if (!isDirectChat(space, message)) continue;
  const content = message.content;
  let caption: Promise<string> | undefined;
  if (content.type === "attachment" && isImageMime(content.mimeType)) caption = expectCaption(sender);
  else if (content.type === "text" && offerCaption(sender, content.text)) continue;
  enqueue(sender, () => handle(space, message, sender, caption));
}
