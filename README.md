# Pocket Memory

> Text it now. Find it when you need it. Or just say it.

Pocket Memory is an iMessage contact you text, or send a voice note to, whenever you think "I'm going to forget this." Later you ask in plain language and it finds what you saved. It can also act on what you tell it by running Apple Shortcuts (Calendar, Reminders, Notes, HomeKit, Focus).

- **Save:** "Spare keys are in the green bag in the hall closet" → 👍 (only after the note is on disk)
- **Recall:** "Where are my spare keys?" → "Green bag in the hall closet. You saved that on Oct 10."
- **Update:** "Moved the keys to the kitchen drawer" → 👍, old value kept in History
- **History:** "Where did the keys used to be?" → answered from History, with dates
- **Forget:** "Forget where I keep my keys" → 👍
- **Unknown:** "What's my passport number?" → "You haven't told me that yet."
- **Voice:** send a voice note to save or ask; questions asked by voice get a voice answer (ElevenLabs)
- **Shortcuts:** "Dentist Tuesday 3pm" saves the memory and adds a Calendar event
- **Photos:** send a photo (optionally with a caption) to save it; "Which bin has my tent?" answers and sends the photo back

The full product spec is in [`POCKET_MEMORY.md`](./POCKET_MEMORY.md).

## How it runs

Photon's Spectrum Cloud hosts the iMessage line. The agent process (`pnpm start`) runs **on your Mac**, which provides the Obsidian vault on disk and the macOS `shortcuts` command. Gemini (`gemini-flash-latest` by default, via `@google/genai`) routes each message and answers questions strictly from your saved notes; ElevenLabs handles all speech.

```
iPhone ──iMessage──▶ Spectrum Cloud ──▶ pnpm start (your Mac)
                                          ├─ Gemini: classify, extract, answer from notes
                                          ├─ Obsidian vault: <vault>/<sender>/<Thing>.md
                                          ├─ ElevenLabs: Scribe STT / TTS (+ afconvert → m4a)
                                          └─ shortcuts run "<allowlisted name>"
```

## Requirements

- A Mac with macOS 12 or later (for the `shortcuts` command and `afconvert`), Node.js 22+, and pnpm
- [Obsidian](https://obsidian.md) with a vault folder
- A Spectrum Cloud project from the [Photon dashboard](https://app.photon.codes) (Pro plan: one-on-one chats only)
- A [Gemini API key](https://aistudio.google.com/apikey) (or an [Anthropic API key](https://console.anthropic.com) to use Claude instead)
- An [ElevenLabs API key](https://elevenlabs.io) (for voice notes)

## Setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create `.env` (copy `.env.example`) and fill in the values. The app loads `.env` on start.

   | Variable | Required | What it is |
   |---|---|---|
   | `PROJECT_ID` | yes | Spectrum project id (Photon dashboard → project Settings) |
   | `PROJECT_SECRET` | yes | Spectrum project secret (Photon dashboard → project Settings) |
   | `GEMINI_API_KEY` | yes* | Gemini API key |
   | `GEMINI_MODEL` | no | Gemini model id (default `gemini-flash-latest`) |
   | `ANTHROPIC_API_KEY` | no* | Claude API key, to use Claude (`claude-opus-5-5`) instead of Gemini |
   | `POCKET_LLM` | no | Force `gemini` or `claude`. Unset: Gemini if `GEMINI_API_KEY` is set, else Claude |
   | `POCKET_VAULT_PATH` | yes | Absolute path to your Obsidian vault folder (`~/` is allowed) |
   | `ELEVENLABS_API_KEY` | for voice | ElevenLabs API key. Without it, voice notes get a "text me instead" reply |
   | `ELEVENLABS_VOICE_ID` | no | Pocket's voice. Empty uses a default premade voice. Pick one in the ElevenLabs Voice Library and paste its id |
   | `ELEVENLABS_STT_MODEL` | no | Speech-to-text model, default `scribe_v1` |
   | `ELEVENLABS_TTS_MODEL` | no | Text-to-speech model, default `eleven_multilingual_v2` |
   | `POCKET_SHORTCUTS_ALLOWLIST` | no | Comma-separated exact Shortcut names Pocket may run. Empty = all five names below. `none` disables Shortcuts |
   | `POCKET_TIMEZONE` | no | IANA time zone such as `America/Los_Angeles`, used for "Tuesday at 3pm" and dates. Defaults to the Mac's zone |

   \* Set one of `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`.

   If startup fails with an authentication error, verify `PROJECT_ID` / `PROJECT_SECRET` in the Photon dashboard.

3. Register your testers (below), create the Shortcuts (below), then run:

   ```sh
   pnpm start
   ```

   Run it from a terminal app that has been granted access to Calendars, Reminders and Home (macOS prompts the first time each Shortcut runs; see "Test each Shortcut").

## Register testers in the Photon dashboard

On the Free and Pro plans the bot sends from a **shared pool** of numbers, and it can only message people registered as **project users**. Otherwise sends fail with `Target not allowed for this project`.

1. Open [app.photon.codes](https://app.photon.codes) and select your project.
2. Open the project's **Users** section and add each tester's iMessage address: their phone number in international format (`+15551234567`) or their Apple ID email. Up to 100 users.
3. Each tester texts the bot's number. Because numbers come from a shared pool, different testers may see Pocket texting from different numbers; each tester should save the number Pocket uses with them as a contact named "Pocket".

With the `photon` CLI (`npx skills add photon-hq/skills --skill photon-cli`), `photon spectrum lines list` shows the line(s) your project sends from.

Group chats need the Business plan, so Pocket ignores them and only answers one-on-one chats.

## Apple Shortcuts on the Mac

Pocket runs **only** these Shortcuts, by these exact names, and only if the name is in `POCKET_SHORTCUTS_ALLOWLIST` (or the allowlist is empty). It never runs a name taken from a message, and never runs shell commands. It runs them as:

```sh
shortcuts run "<name>" --input-path <file.json>
```

The input is a small JSON dictionary. In each Shortcut, start with **Get Dictionary from Input** (input: *Shortcut Input*), then **Get Dictionary Value** for the keys listed. Dates are local ISO date-times such as `2026-10-14T15:00:00`; Shortcuts converts them to dates when you plug them into a date field.

| Exact name | Input keys | What the Shortcut should do |
|---|---|---|
| `Pocket Calendar Event` | `title`, `start`, `end`, `notes` | **Add New Event** to your calendar: Title = `title`, Start Date = `start`, End Date = `end`, Notes = `notes`. |
| `Pocket Reminder` | `title`, `due`, `notes` | **Add New Reminder**: Title = `title`, Notes = `notes`. If `due` has any value, set the alert/due date to `due`. |
| `Pocket Note` | `title`, `body` | **Create Note** in Apple Notes with body `title`, a blank line, then `body`. |
| `Pocket Bedtime` | none | **Control Home**: run your bedtime scene (for example "Good Night" with lights off). |
| `Pocket Focus` | `minutes` | **Adjust Date**: add `minutes` minutes to *Current Date*, then **Set Focus**: turn on your Focus (for example "Do Not Disturb" or a "Study" Focus) until that time. |

Pocket replies after every action ("Added to your calendar: Dentist, Tue, Oct 14, 3:00 PM.", "Done. Bedtime scene is on.", "Focus is on for 120 minutes."), and says plainly if a Shortcut failed or does not exist.

### Test each Shortcut

Run each one once from the same terminal app you use for `pnpm start`, so macOS asks for Calendar/Reminders/Home permissions up front:

```sh
echo '{"title":"Test event","start":"2026-10-14T15:00:00","end":"2026-10-14T16:00:00","notes":""}' > /tmp/pocket-test.json
shortcuts run "Pocket Calendar Event" --input-path /tmp/pocket-test.json
```

To allow only some Shortcuts, list them, for example `POCKET_SHORTCUTS_ALLOWLIST=Pocket Calendar Event,Pocket Reminder`.

## "Send to Pocket" share sheet (iPhone)

This user-side Shortcut lets you share any text, link or photo from any app into your Pocket thread, where it is handled as a normal save.

1. On the iPhone, open **Shortcuts** → **+** and name the shortcut **Send to Pocket**.
2. Tap the **ⓘ** (details) button and turn on **Show in Share Sheet**. Set the accepted types to **Text, URLs, Safari web pages and Images**.
3. Add the action **If** *Shortcut Input* **has any value**… (optional), then:
   - For text and links, add a **Text** action containing `Save: ` followed by the *Shortcut Input* variable. The `Save:` prefix tells Pocket to always treat it as a save.
   - Add **Send Message**: Message = the Text from the previous step (or *Shortcut Input* directly for photos), Recipients = your **Pocket** contact.
4. Turn off **Show When Run** on the Send Message action so it sends in one tap.

Now Share → **Send to Pocket** from Safari, Photos, Notes or any app saves it. Photos shared this way become photo memories.

## The vault

Each sender gets a folder (named after their phone number or email). Each thing, person or idea is one note:

```markdown
# Spare keys
**Now:** kitchen drawer  *(updated Oct 12, 2026)*
**Related:** [[+15551234567/Jamie|Jamie]]

## History
- Oct 10, 2026: "I put the spare keys in the green bag in the hall closet."
- Oct 12, 2026: "Moved the spare keys to the kitchen drawer."
```

- People and named things become `[[wikilinks]]` (with a stub note), so Obsidian's graph view clusters related memories. Open the graph view next to iMessage for the demo; it updates live as memories are saved.
- **Hand edits are fine.** Parsing is tolerant: the `Now:` line, dates and the History section are all optional, and updates only replace the `Now:` line and append to History, leaving the rest of your text alone.
- **Forget** moves the note to the vault's `.trash/<sender>/` folder (Obsidian's trash), so it disappears from Pocket and the graph but can be recovered by hand.
- Photos are stored in `<sender>/attachments/` and embedded in their note with `![[...]]`. A short text sent within 5 seconds after a photo (and not a question) is used as its caption. On the Mac, `sips` converts HEIC photos to JPEG so Obsidian can show them.

## Development

```sh
pnpm test        # unit tests (vitest): vault, parsing, routing with the model mocked, voice, Shortcuts allowlist
pnpm typecheck   # tsc --noEmit
```

| File | Purpose |
|---|---|
| `src/index.ts` | Spectrum loop: outbound filtering, one-on-one only, per-sender queue, typing indicator, tapbacks, replies, voice |
| `src/pocket.ts` | Routing and reliability rules (write before 👍, no unsupported answers) |
| `src/llm.ts` | The JSON model call, for Gemini and Claude |
| `src/brain.ts` | Model call: intent, fields, and recall answered only from the loaded notes |
| `src/vault.ts` | Obsidian notes: read, write, update, history, forget, tolerant parsing |
| `src/voice.ts` | ElevenLabs Scribe and TTS, `afconvert` to m4a |
| `src/shortcuts.ts` | Allowlisted Shortcut runner |
| `src/photos.ts` | Photo memories (model vision) |
| `src/config.ts` | Environment variables |

Spectrum SDK reference: `.agents/skills/spectrum/` and the [Spectrum docs](https://photon.codes/docs/spectrum-ts).
