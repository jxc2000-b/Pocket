# Pocket Memory: Product Spec

> **Pitch:** "Text it now. Find it when you need it. Or just say it."

Pocket Memory is an iMessage contact you text, or send a voice note to, whenever you think "I'm going to forget this." Later you ask in plain language and it finds what you saved. It can also act on what you tell it by running Apple Shortcuts (Calendar, Reminders, Notes, HomeKit, Focus).

Built for a hackathon. ElevenLabs is a sponsor, so use ElevenLabs for all speech.

---

## Runtime and environment

- **Runs locally on the developer's own Mac.** Photon's Spectrum Cloud hosts only the iMessage line. The agent process (`pnpm start`) runs on the Mac, which provides the Obsidian vault on disk and the macOS `shortcuts` command.
- **SDK:** `spectrum-ts` with the cloud iMessage provider (`imessage.config()`). The entry point is `src/index.ts`. Its current echo loop is a placeholder to replace.
- **SDK reference:** `.agents/skills/spectrum/`. Read `content.md`, `messages.md`, `reactions-and-replies.md`, `spaces-and-users.md`, `providers/imessage.md` and `best-practices.md` before writing Spectrum code.
- **Secrets live in `.env`.** Never read, write or echo `.env`. Tell the user which variable names to add. Existing: `PROJECT_ID`, `PROJECT_SECRET`. Expected additions: an Anthropic API key, an ElevenLabs API key, and the vault path.
- **LLM:** Claude via the official `@anthropic-ai/sdk`, model `claude-opus-5-5`.

### Spectrum Pro plan constraints
- **One-on-one chats only.** Group chats require the Business plan, so don't build group features.
- **Testers must be registered** as project users in the Photon dashboard (up to 100) before the bot can message them. Otherwise sending fails with `Target not allowed for this project`.
- **Shared-pool numbers:** different users may see the bot texting from different numbers.
- **Unavailable:** iMessage mini apps (Business plan and above).

---

## Core memory behavior

| Intent | Example input | Expected behavior |
|---|---|---|
| **Save** | "Spare keys are in the green bag in the hall closet" | Persist it, then tapback 👍 |
| **Recall** | "Where are my spare keys?" (different wording from the save) | "Green bag in the hall closet. You saved that on Oct 10." |
| **Update** | "Moved the keys to the kitchen drawer" | Replace the current value and keep the old value in history |
| **History** | "Where did the keys used to be?" | Answer from history, with dates |
| **Forget** | "Forget where I keep my keys" | Remove the memory, then tapback 👍 |
| **Unknown** | "What's my passport number?" (never saved) | "You haven't told me that yet." Never invent an answer. |

Typical memory types: things and locations ("air filter is 16×20×1"), people ("Jamie's favorite dessert is tiramisu"), recommendations ("Sam recommended *Piranesi*"), decisions ("we picked the early flight to make dinner"), and ideas.

### Reliability rules (reliability is the product)
1. **Save before you confirm.** Send the 👍 tapback only after the write to disk succeeds, so a 👍 always means it was saved. On failure, say so plainly.
2. **Answers must be traceable.** Include when the information was saved, and keep the user's original wording available.
3. **No made-up answers.** Answer recall questions only from saved memories. At prototype scale, loading the user's full set of memories into the prompt and instructing Claude to answer only from it is preferred over semantic search.
4. **Keep memories per sender.** Scope every memory to the sender's address so users' memories never mix.
5. **Keep replies short.**

---

## Storage: Obsidian vault

Memories are plain Markdown files in an Obsidian vault on the Mac, not a database. The vault path comes from configuration.

- **One note per thing, person or idea**, with the current value at the top and a dated history below. Suggested shape:

  ```markdown
  # Spare keys
  **Now:** kitchen drawer  *(updated Oct 12)*

  ## History
  - Oct 10: "I put the spare keys in the green bag in the hall closet."
  - Oct 12: "Moved the spare keys to the kitchen drawer."
  ```

- **Link people and entities with `[[wikilinks]]`** (for example "Jamie's favorite dessert" links to `[[Jamie]]`) so Obsidian's graph view clusters related memories.
- **Expect hand edits.** The user may edit notes in Obsidian, so parsing must be tolerant and the bot's own structured fields minimal.
- **Separate users** with one subfolder per sender.
- **Demo visual:** iMessage on one half of the screen, Obsidian's graph view on the other, updating live as memories are saved.

---

## Native iMessage experience

Use iMessage features so the bot feels like a contact, not a webhook:

| Feature | Spectrum API | Use |
|---|---|---|
| Tapbacks | `message.react("👍")` | 👍 to confirm a save or forget, ❓ when the request is unclear |
| Typing indicator | `space.responding(async () => { ... })` | Wrap transcription, Claude calls and speech generation |
| Threaded replies | `message.reply(...)` | Answer the specific question asked |
| Streamed text | `text()` / `markdown()` accept an `AsyncIterable` or stream | Longer answers appear progressively |
| Effects (optional) | `effect(content, imessage.effect.message.confetti)` | Milestones only (for example the 100th memory) |

Filter out the bot's own messages with `message.direction === "outbound"`.

---

## Voice (ElevenLabs)

- **Save and ask by voice note.** Inbound voice notes arrive as `voice` content (`read()` returns the audio). Transcribe them with **ElevenLabs speech-to-text (Scribe)**, then handle the text like any other message. Example: "Parked on level 3, row G" gets saved and a 👍.
- **Answer by voice when asked by voice.** If the question came as a voice note, reply with a voice note generated by **ElevenLabs text-to-speech**, sent with Spectrum's `voice()` builder (pass `duration` for the waveform). Text questions get text answers.
- **Give Pocket a consistent voice:** use one distinctive ElevenLabs voice throughout.
- **Audio format:** iMessage voice bubbles expect AAC/M4A. If ElevenLabs returns MP3, convert it locally (macOS ships with `afconvert`).

---

## Apple Shortcuts bridge

The agent runs on the Mac, so it can run Shortcuts with the built-in command `shortcuts run "<Shortcut Name>"` (see `shortcuts help run` for passing input). Shortcuts run on that Mac using its signed-in Apple ID, so Calendar, Reminders and Notes sync to the user's iPhone through iCloud, and HomeKit works through the user's Home.

| User says | Pocket does |
|---|---|
| "Dentist Tuesday at 3pm" | Saves the memory **and** creates a Calendar event |
| "Remind me to buy air filters Saturday" | Saves the memory **and** creates a Reminder |
| "Save this as a note: gift ideas for mom…" | Creates an Apple Note |
| "I'm heading to bed" | Runs a HomeKit scene (for example lights off) |
| "I'm studying for 2 hours" | Turns on a Focus mode |

**Safety rule:** the agent may run **only an allowlist of named Shortcuts** defined in configuration, never arbitrary shell commands or arbitrary Shortcut names taken from the user's text. Actions with physical or attention side effects (HomeKit, Focus) must reply confirming what was done.

**Share sheet:** an iPhone Shortcut, "Send to Pocket", lets the user share any text, link or photo from any app into the bot's iMessage thread, where it's handled as a normal save. This is a user-side Shortcut; document how to set it up.

The builder must document which Shortcuts the user needs to create on the Mac, with the exact names the allowlist expects.

---

## Stretch goal: photo memories

- Inbound image attachments (`attachment` content with an image `mimeType`) plus an optional caption ("camping stuff") are described with Claude's vision and saved as a memory.
- The **image file is stored in the vault and embedded in the note** (`![[bin-3.jpg]]`) so it shows in Obsidian.
- Recall like "Which bin has my tent?" answers in text **and sends the original photo back** with `attachment()`.

---

## Acceptance scenarios

These double as the live demo. Each should work reliably:

- Three unrelated facts are texted. Each gets a 👍, and a note for each appears in the vault and graph.
- A voice note "parked on level 3, row G" is transcribed, saved and gets a 👍.
- "Where's the luggage?" finds a memory saved as "my suitcase is in the attic" and answers with the save date.
- After an update, recall returns the new value, and "where did it used to be?" returns the old one.
- A voice question ("where did I park?") gets an ElevenLabs voice-note reply.
- "Dentist Tuesday 3pm" saves the memory and creates a Calendar event through Shortcuts.
- A question about something never saved returns "You haven't told me that yet."
- A typing indicator shows whenever the bot is working.
- (Stretch) A photo of a bin is saved, and "which bin has my tent?" returns the answer and the photo.
