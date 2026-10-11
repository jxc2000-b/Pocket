// Pocket Memory: an iMessage contact that remembers things for you.
// Spectrum delivers messages from the cloud iMessage line; this process runs
// on the user's Mac, where the Obsidian vault and `shortcuts` live.
// Docs: https://photon.codes/docs/spectrum-ts

import { Spectrum, type Message, type Space } from "spectrum-ts";
import { effect, imessage } from "spectrum-ts/providers/imessage";
import { Brain } from "./brain.ts";
import { loadConfig } from "./config.ts";
import { Pocket, type Outcome } from "./pocket.ts";
import { ShortcutRunner } from "./shortcuts.ts";
import { Vault } from "./vault.ts";

// Load ./.env into process.env (values already set in the environment win).
try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}

const config = loadConfig();
const vault = new Vault(config.vaultPath, config.timeZone);
const shortcuts = new ShortcutRunner(config.shortcutAllowlist);
const pocket = new Pocket(vault, new Brain(), shortcuts, config.timeZone);

const app = await Spectrum({
  projectId: config.projectId,
  projectSecret: config.projectSecret,
  providers: [imessage.config()],
});

console.log(`[pocket] running. Vault: ${config.vaultPath}`);
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

/** One-on-one chats only (group chats need the Business plan). */
function isDirectChat(space: Space, message: Message): boolean {
  if (message.platform !== "imessage") return false;
  return imessage(space).type === "dm";
}

async function deliver(space: Space, message: Message, outcome: Outcome): Promise<void> {
  if (outcome.react) await message.react(outcome.react);
  if (outcome.reply) await message.reply(outcome.reply);
  for (const notice of outcome.notices) await space.send(notice);
  if (outcome.milestone) {
    await space.send(
      effect(`That's ${outcome.milestone} memories saved!`, imessage.effect.message.confetti),
    );
  }
}

async function handle(space: Space, message: Message, sender: string): Promise<void> {
  const content = message.content;
  switch (content.type) {
    case "text": {
      await space.responding(async () => {
        const outcome = await pocket.handleText(sender, content.text);
        console.log(`[pocket] ${sender}: ${outcome.intent ?? "?"}`);
        await deliver(space, message, outcome);
      });
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
  enqueue(sender, () => handle(space, message, sender));
}
