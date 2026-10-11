// Obsidian vault storage. One subfolder per sender, one Markdown note per
// thing/person/idea:
//
//   # Spare keys
//   **Now:** kitchen drawer  *(updated Oct 12, 2026)*
//   **Related:** [[+15551234567/Jamie|Jamie]]
//
//   ## History
//   - Oct 10, 2026: "I put the spare keys in the green bag in the hall closet."
//   - Oct 12, 2026: "Moved the spare keys to the kitchen drawer."
//
// Notes may be edited by hand in Obsidian, so parsing is tolerant: every
// structured piece is optional, and updates rewrite only the lines they own,
// leaving everything else as the user wrote it.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { formatNoteDate, parseNoteDate } from "./dates.ts";

export interface HistoryEntry {
  date?: Date;
  text: string;
}

export interface ParsedNote {
  title: string;
  now?: string;
  nowUpdated?: Date;
  history: HistoryEntry[];
  /** Display names of [[wikilinks]] in the note (embeds excluded). */
  links: string[];
  /** Targets of ![[embeds]] in the note. */
  embeds: string[];
  raw: string;
}

export interface Memory extends ParsedNote {
  /** File name without ".md"; stable identifier shown to the model. */
  id: string;
  path: string;
  mtime: Date;
  /** Most recent date the note records (Now/History), else file mtime. */
  lastSaved: Date;
}

export interface SaveInput {
  title: string;
  now: string;
  /** The user's original wording, kept verbatim in History. */
  original: string;
  entities?: string[];
  /** Vault-relative path of an attachment to embed (photo memories). */
  embed?: string;
  date?: Date;
}

export interface UpdateInput {
  now: string;
  original: string;
  entities?: string[];
  embed?: string;
  date?: Date;
}

const NOW_RE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*now\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
const RELATED_RE = /^\s*(?:\*\*|__)?\s*related\s*(?:\*\*|__)?\s*:/i;
const HISTORY_HEADING_RE = /^(#{1,6})\s*history\b/i;
const HEADING_RE = /^(#{1,6})\s/;
const LIST_ITEM_RE = /^\s*[-*+]\s+(.*)$/;
const LINK_RE = /(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/** Characters Obsidian and filesystems dislike in file names. */
export function sanitizeFileName(name: string, fallback = "Memory"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .slice(0, 80)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Folder name for a sender address (phone number or email). */
export function senderFolderName(address: string): string {
  const cleaned = address
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+@._-]/g, "_")
    .replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
}

function stripQuotes(s: string): string {
  const t = s.trim();
  const m = /^["“'](.*)["”']$/s.exec(t);
  return (m ? m[1]! : t).trim();
}

function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, " ").trim();
}

/** Split "Now:" value from a trailing "*(updated Oct 12)*" marker. */
function parseNowValue(value: string, fallbackYear: number): { now: string; updated?: Date } {
  const m = /\s*[*_]?\(\s*(?:updated|saved|as of)?\s*:?\s*([^)]*)\)[*_]?\s*$/i.exec(value);
  if (m) {
    const date = parseNoteDate(m[1]!, fallbackYear);
    if (date) {
      return { now: value.slice(0, m.index).replace(/[*_\s]+$/, "").trim(), updated: date };
    }
  }
  return { now: value.replace(/^[*_\s]+|[*_\s]+$/g, "").trim() };
}

function parseHistoryItem(item: string, fallbackYear: number): HistoryEntry {
  const m = /^(?:\*\*|__)?([^:]{3,40}?)(?:\*\*|__)?\s*[:—–-]\s+(.*)$/s.exec(item);
  if (m) {
    const date = parseNoteDate(m[1]!.replace(/[*_]/g, ""), fallbackYear);
    if (date) return { date, text: stripQuotes(m[2]!) };
  }
  return { text: stripQuotes(item) };
}

function historySection(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((l) => HISTORY_HEADING_RE.test(l.trim()));
  if (start < 0) return undefined;
  const level = HISTORY_HEADING_RE.exec(lines[start]!.trim())![1]!.length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i]!.trim());
    if (h && h[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Parse a note's Markdown. Never throws; missing pieces are simply absent. */
export function parseNote(raw: string, fallbackTitle: string, fallbackYear = new Date().getUTCFullYear()): ParsedNote {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let lines = text.split("\n");

  // Skip YAML frontmatter if the user added some.
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) bodyStart = close + 1;
  }
  lines = lines.slice(bodyStart);

  const h1 = lines.find((l) => /^#\s+\S/.test(l.trim()));
  const title = h1 ? h1.trim().replace(/^#\s+/, "").trim() : fallbackTitle;

  const section = historySection(lines);
  let now: string | undefined;
  let nowUpdated: Date | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (section && i >= section.start && i < section.end) continue;
    const m = NOW_RE.exec(lines[i]!);
    if (m) {
      const parsed = parseNowValue(m[1]!, fallbackYear);
      now = parsed.now;
      nowUpdated = parsed.updated;
      break;
    }
  }

  const history: HistoryEntry[] = [];
  if (section) {
    for (let i = section.start + 1; i < section.end; i++) {
      const m = LIST_ITEM_RE.exec(lines[i]!);
      if (m && m[1]!.trim()) history.push(parseHistoryItem(m[1]!, fallbackYear));
    }
  }

  const links: string[] = [];
  const embeds: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[2]!.trim();
    if (m[1] === "!") embeds.push(target);
    else links.push((m[3] ?? basename(target)).trim());
  }

  return { title, now, nowUpdated, history, links, embeds, raw: text };
}

function latestDate(note: ParsedNote): Date | undefined {
  let best = note.nowUpdated;
  for (const h of note.history) {
    if (h.date && (!best || h.date > best)) best = h.date;
  }
  return best;
}

export class Vault {
  constructor(
    readonly root: string,
    readonly timeZone: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  senderDir(sender: string): string {
    return join(this.root, senderFolderName(sender));
  }

  private notePath(sender: string, id: string): string {
    return join(this.senderDir(sender), `${id}.md`);
  }

  private wikilink(sender: string, entity: string): string {
    const name = sanitizeFileName(entity);
    return `[[${senderFolderName(sender)}/${name}|${entity.replace(/[[\]|]/g, "").trim()}]]`;
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    const dir = join(path, "..");
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  }

  /** All memories for a sender, sorted by id. */
  async list(sender: string): Promise<Memory[]> {
    const dir = this.senderDir(sender);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const ids = names
      .filter((n) => n.toLowerCase().endsWith(".md") && !n.startsWith("."))
      .map((n) => n.slice(0, -3))
      .sort((a, b) => a.localeCompare(b));
    const out: Memory[] = [];
    for (const id of ids) {
      const m = await this.get(sender, id);
      if (m) out.push(m);
    }
    return out;
  }

  async get(sender: string, id: string): Promise<Memory | undefined> {
    if (!id || id.includes("/") || id.includes("\\") || id.startsWith(".")) return undefined;
    const path = this.notePath(sender, id);
    let raw: string;
    let mtime: Date;
    try {
      raw = await readFile(path, "utf8");
      mtime = (await stat(path)).mtime;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const parsed = parseNote(raw, id, dayYear(this.clock()));
    return { ...parsed, id, path, mtime, lastSaved: latestDate(parsed) ?? mtime };
  }

  /**
   * Create a note for a new memory. If a note with the same title already
   * exists, the memory is applied as an update to it instead.
   */
  async save(sender: string, input: SaveInput): Promise<Memory> {
    const id = sanitizeFileName(input.title);
    if (existsSync(this.notePath(sender, id))) {
      return this.update(sender, id, input);
    }
    const date = formatNoteDate(input.date ?? this.clock(), this.timeZone);
    const lines = [`# ${oneLine(input.title)}`, `**Now:** ${oneLine(input.now)}  *(updated ${date})*`];
    const entities = this.cleanEntities(input.entities, id);
    if (entities.length) {
      lines.push(`**Related:** ${entities.map((e) => this.wikilink(sender, e)).join(", ")}`);
    }
    if (input.embed) lines.push("", `![[${input.embed}]]`);
    lines.push("", "## History", `- ${date}: "${oneLine(input.original)}"`, "");
    await this.writeAtomic(this.notePath(sender, id), lines.join("\n"));
    await this.ensureEntityNotes(sender, entities);
    return (await this.get(sender, id))!;
  }

  /** Replace the current value and append the change to History. */
  async update(sender: string, id: string, input: UpdateInput): Promise<Memory> {
    const existing = await this.get(sender, id);
    if (!existing) throw new Error(`No memory named "${id}"`);
    const date = formatNoteDate(input.date ?? this.clock(), this.timeZone);
    const lines = existing.raw.split("\n");
    const section = historySection(lines);

    // 1. Now line: replace in place, or insert after the title.
    const nowLine = `**Now:** ${oneLine(input.now)}  *(updated ${date})*`;
    let nowIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (section && i >= section.start && i < section.end) continue;
      if (NOW_RE.test(lines[i]!)) {
        nowIdx = i;
        break;
      }
    }
    if (nowIdx >= 0) {
      lines[nowIdx] = nowLine;
    } else {
      const h1 = lines.findIndex((l) => /^#\s+\S/.test(l.trim()));
      nowIdx = h1 >= 0 ? h1 + 1 : 0;
      lines.splice(nowIdx, 0, nowLine);
    }

    // 2. Related links: add any entity not already linked anywhere in the note.
    const linked = new Set(existing.links.map((l) => l.toLowerCase()));
    const missing = this.cleanEntities(input.entities, id).filter((e) => !linked.has(e.toLowerCase()));
    let afterMeta = nowIdx + 1;
    if (missing.length) {
      const links = missing.map((e) => this.wikilink(sender, e)).join(", ");
      const relIdx = lines.findIndex((l) => RELATED_RE.test(l));
      if (relIdx >= 0) {
        lines[relIdx] = `${lines[relIdx]!.trimEnd()}, ${links}`;
        afterMeta = Math.max(afterMeta, relIdx + 1);
      } else {
        lines.splice(nowIdx + 1, 0, `**Related:** ${links}`);
        afterMeta = nowIdx + 2;
      }
    }

    // 3. Optional embed (photo memory).
    if (input.embed && !existing.embeds.includes(input.embed)) {
      lines.splice(afterMeta, 0, "", `![[${input.embed}]]`);
    }

    // 4. History: append after the last non-blank line of the section.
    const entry = `- ${date}: "${oneLine(input.original)}"`;
    const hist = historySection(lines);
    if (hist) {
      let insertAt = hist.start + 1;
      for (let i = hist.start + 1; i < hist.end; i++) {
        if (lines[i]!.trim() !== "") insertAt = i + 1;
      }
      lines.splice(insertAt, 0, entry);
    } else {
      while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
      lines.push("", "## History", entry);
    }

    let out = lines.join("\n");
    if (!out.endsWith("\n")) out += "\n";
    await this.writeAtomic(existing.path, out);
    await this.ensureEntityNotes(sender, missing);
    return (await this.get(sender, id))!;
  }

  /**
   * Forget a memory: move the note into the vault's `.trash` folder (Obsidian's
   * own trash location, hidden from search and graph). Returns false if absent.
   */
  async forget(sender: string, id: string): Promise<boolean> {
    const existing = await this.get(sender, id);
    if (!existing) return false;
    const trashDir = join(this.root, ".trash", senderFolderName(sender));
    await mkdir(trashDir, { recursive: true });
    const stamp = this.clock().toISOString().replace(/[:.]/g, "-");
    await rename(existing.path, join(trashDir, `${id} (forgotten ${stamp}).md`));
    return true;
  }

  /** Store an attachment under <sender>/attachments; returns vault-relative and absolute paths. */
  async saveAttachment(
    sender: string,
    data: Buffer,
    baseName: string,
    ext: string,
  ): Promise<{ absPath: string; vaultPath: string }> {
    const dir = join(this.senderDir(sender), "attachments");
    await mkdir(dir, { recursive: true });
    const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    const base = sanitizeFileName(baseName, "photo").replace(/\s+/g, "-").toLowerCase();
    let name = `${base}.${safeExt}`;
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${base}-${n}.${safeExt}`;
    const absPath = join(dir, name);
    await writeFile(absPath, data);
    return { absPath, vaultPath: relative(this.root, absPath).split(sep).join("/") };
  }

  /** Resolve an embed target to an existing file inside this sender's folder. */
  resolveEmbed(sender: string, target: string): string | undefined {
    const dir = this.senderDir(sender);
    const candidates = [
      join(this.root, target),
      join(dir, target),
      join(dir, "attachments", basename(target)),
    ];
    for (const c of candidates) {
      const rel = relative(dir, c);
      if (rel.startsWith("..") || rel === "") continue; // never leak another sender's files
      if (existsSync(c)) return c;
    }
    return undefined;
  }

  private cleanEntities(entities: string[] | undefined, selfId: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of entities ?? []) {
      const name = oneLine(e).replace(/[[\]|]/g, "").trim();
      if (!name || name.length > 60) continue;
      const key = name.toLowerCase();
      if (seen.has(key) || sanitizeFileName(name).toLowerCase() === selfId.toLowerCase()) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  /** Create a stub note for each linked person/entity so the graph clusters. */
  private async ensureEntityNotes(sender: string, entities: string[]): Promise<void> {
    for (const e of entities) {
      const path = this.notePath(sender, sanitizeFileName(e));
      if (!existsSync(path)) await this.writeAtomic(path, `# ${e}\n`);
    }
  }
}

function dayYear(d: Date): number {
  return d.getUTCFullYear();
}

export function isImageFile(path: string): boolean {
  return [".jpg", ".jpeg", ".png", ".gif", ".heic", ".webp"].includes(extname(path).toLowerCase());
}
