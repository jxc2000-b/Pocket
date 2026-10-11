// Small date helpers. Notes store dates as "Oct 10, 2026" (human-readable in
// Obsidian, unambiguous for parsing). Parsing also accepts ISO dates and
// year-less "Oct 10" written by hand.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Calendar day in a time zone, as {y, m (1-12), d}. */
export function dayParts(date: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** "Oct 10, 2026" */
export function formatNoteDate(date: Date, timeZone: string): string {
  const { y, m, d } = dayParts(date, timeZone);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "Oct 10" when in the current year, else "Oct 10, 2025". */
export function formatShortDate(date: Date, timeZone: string, now: Date = new Date()): string {
  const a = dayParts(date, timeZone);
  const b = dayParts(now, timeZone);
  const base = `${MONTHS[a.m - 1]} ${a.d}`;
  return a.y === b.y ? base : `${base}, ${a.y}`;
}

/**
 * Parse a date as written in a note. Returns a Date at UTC noon of that day
 * (so it formats to the same calendar day in any time zone), or undefined.
 */
export function parseNoteDate(text: string, fallbackYear?: number): Date | undefined {
  const s = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return utcNoon(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/.exec(s);
  if (m) {
    const idx = MONTHS.findIndex((mo) => m![1]!.toLowerCase().startsWith(mo.toLowerCase()));
    if (idx < 0) return undefined;
    const year = m[3] ? Number(m[3]) : (fallbackYear ?? new Date().getUTCFullYear());
    return utcNoon(year, idx + 1, Number(m[2]));
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(s);
  if (m) {
    let year = m[3] ? Number(m[3]) : (fallbackYear ?? new Date().getUTCFullYear());
    if (year < 100) year += 2000;
    return utcNoon(year, Number(m[1]), Number(m[2]));
  }
  return undefined;
}

function utcNoon(y: number, m: number, d: number): Date | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** Context line for the model: "Saturday, October 11, 2026, 9:41 AM (America/Los_Angeles)". */
export function describeNow(now: Date, timeZone: string): string {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  return `${s} (${timeZone})`;
}
