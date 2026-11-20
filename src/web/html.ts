import type { Database } from "bun:sqlite";
import type { Result } from "../result";

export type WebContext = {
  db: Database;
  now: () => Date;
  offsetOf?: (d: Date) => number;
  port: number;
  /** Reads one dictation's WAV from Wispr; ok(null) when it is gone, err when Wispr cannot be read. */
  readAudio?: (id: string) => Result<Uint8Array | null>;
};

export type Handler = (req: Request, ctx: WebContext) => Response | Promise<Response>;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const NAV: ReadonlyArray<readonly [string, string]> = [
  ["/", "Today"],
  ["/calendar", "Calendar"],
  ["/repeats", "Repeats"],
  ["/search", "Search"],
  ["/settings", "Settings"],
];

export const KIND_LABEL: Record<string, string> = {
  grammar: "Grammar",
  word: "Word choice",
  filler: "Fillers",
  sound: "Sounds",
};

const KIND_LABELS = new Map(Object.entries(KIND_LABEL));

export const kindLabel = (kind: string): string => KIND_LABELS.get(kind) ?? kind;

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-14" becomes "14 Oct". */
export const shortDate = (day: string): string =>
  `${Number(day.slice(8, 10))} ${MONTH_ABBR[Number(day.slice(5, 7)) - 1] ?? ""}`;

/** "2026-11-19" becomes "19 Nov 2026". */
export const fullDate = (day: string): string => `${shortDate(day)} ${day.slice(0, 4)}`;

/** An ISO instant becomes local "20 Nov, 10:21"; an unreadable value stays as it is. */
export const localTime = (iso: string, offsetOf: (d: Date) => number): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const local = new Date(at.getTime() - offsetOf(at) * 60_000).toISOString();
  return `${shortDate(local.slice(0, 10))}, ${local.slice(11, 16)}`;
};

/** The circled code a proofreader writes in the margin for each kind of mistake. */
const KIND_CODE = new Map([
  ["grammar", "gr"],
  ["word", "wc"],
  ["filler", "fl"],
  ["sound", "so"],
]);

/** The circled kind code for the margin note; the group heading or the kind word carries the meaning for assistive tech. */
export const kindRing = (kind: string): string =>
  KIND_CODE.has(kind)
    ? `<span class="ring ring-${KIND_CODE.get(kind)}" aria-hidden="true">${KIND_CODE.get(kind)}</span>`
    : "";

const wordKey = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Index pairs of the longest run of words the two lists share, in order. */
const sharedWords = (from: readonly string[], to: readonly string[]): Array<readonly [number, number]> => {
  const common = Array.from({ length: from.length + 1 }, () => new Array<number>(to.length + 1).fill(0));
  for (let i = from.length - 1; i >= 0; i--) {
    for (let j = to.length - 1; j >= 0; j--) {
      common[i]![j] = from[i] === to[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const pairs: Array<readonly [number, number]> = [];
  for (let i = 0, j = 0; i < from.length && j < to.length; ) {
    if (from[i] === to[j]) pairs.push([i++, j++]);
    else if (common[i + 1]![j]! >= common[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
};

/**
 * The spoken words with a delete loop (a `del`) around each run the better version only drops.
 * Null when the better version also adds or changes words, or keeps all of them: that is a replacement, not a cut.
 */
export const cutPhrase = (said: string, better: string, attrs = ""): string | null => {
  const words = said.trim().split(/\s+/);
  const target = better.trim() === "" ? [] : better.trim().split(/\s+/);
  const loop = (run: string): string => `<del class="said cut"${attrs}>${escapeHtml(run)}</del>`;
  if (target.length === 0) return loop(words.join(" "));
  const pairs = sharedWords(words.map(wordKey), target.map(wordKey));
  const dropped = new Array<boolean>(words.length).fill(false);
  let replaced = false;
  let [prevSaid, prevBetter] = [-1, -1];
  for (const [i, j] of [...pairs, [words.length, target.length] as const]) {
    if (i - prevSaid > 1) {
      replaced ||= j - prevBetter > 1;
      for (let k = prevSaid + 1; k < i; k++) dropped[k] = true;
    }
    [prevSaid, prevBetter] = [i, j];
  }
  if (replaced || !dropped.some(Boolean)) return null;
  const pieces: string[] = [];
  for (let at = 0; at < words.length; ) {
    let end = at;
    while (end < words.length && dropped[end] === dropped[at]) end++;
    const run = words.slice(at, end).join(" ");
    pieces.push(dropped[at] ? loop(run) : escapeHtml(run));
    at = end;
  }
  return pieces.join(" ");
};

const LONG_FIX = 28;
const LONG_MARGIN = 12;

/** A mark split in two: the marked-out words, and the fix when it must be written under the sentence instead of above the words. */
const markParts = (said: string, better: string, index?: number, kind?: string): { mark: string; under: string } => {
  const attrs = index === undefined ? "" : ` style="--i:${index}"`;
  const cut = kind === "filler" ? cutPhrase(said, better, attrs) : null;
  const known = kind !== undefined && KIND_CODE.has(kind) && (kind !== "filler" || cut !== null);
  const long = better.length > LONG_FIX || better.length > said.length + LONG_MARGIN;
  const body = cut ?? `<del class="said"${attrs}>${escapeHtml(said)}</del>`;
  const fix = escapeHtml(better);
  return {
    mark: `<span class="fix${known ? ` k-${kind}` : ""}${long ? " fix-long" : ""}">${body}${
      better === "" || long ? "" : ` <ins class="better">${fix}</ins>`
    }</span>`,
    under: better !== "" && long ? `<ins class="better fix-under"><span class="caret" aria-hidden="true"></span>${fix}</ins>` : "",
  };
};

/**
 * The correction mark: the spoken words marked out, the better words written above them.
 * The kind picks the mark (strike, delete loop, circle, dotted underline); the index orders the pen strike animation.
 * A long fix flows as plain text and its better words go on their own line under it.
 */
export const correction = (said: string, better: string, index?: number, kind?: string): string => {
  const { mark, under } = markParts(said, better, index, kind);
  return mark + under;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The mistake inside its sentence: a few words either side of the spoken words, or the mark alone when they are not in the text. */
export const proofLine = (said: string, better: string, index: number | undefined, kind: string, heard?: string | null): string => {
  const { mark, under } = markParts(said, better, index, kind);
  const phrase = said.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const edge = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  const found =
    heard && phrase !== ""
      ? new RegExp(`${edge(said.trim()[0]) ? "(?<![\\p{L}\\p{N}])" : ""}${phrase}${edge(said.trim().at(-1)) ? "(?![\\p{L}\\p{N}])" : ""}`, "iu").exec(heard)
      : null;
  if (!heard || !found) return `<p class="line">${mark}${under}</p>`;
  const beforeRaw = heard.slice(0, found.index);
  const afterRaw = heard.slice(found.index + found[0].length);
  const before = (/(?:\S+\s+){0,3}\S+\s+$/.exec(beforeRaw)?.[0] ?? "").trimStart();
  const after = /^(?:\s*[^\s]+){0,4}/.exec(afterRaw)?.[0] ?? "";
  const cutBefore = beforeRaw.trim().length > before.trim().length;
  const cutAfter = afterRaw.trim().length > after.trim().length;
  return `<p class="line">${cutBefore ? "&hellip; " : ""}${escapeHtml(before)}${mark}${escapeHtml(after)}${cutAfter ? " &hellip;" : ""}${under}</p>`;
};

const FONTS =
  "https://fonts.googleapis.com/css2?family=Alegreya:ital,wght@0,400;0,500;0,700;1,400&amp;family=Alegreya+Sans:ital,wght@0,400;0,500;0,700;1,400&amp;display=swap";

export type Mood = "good" | "even" | "busy";

export const layout = ({
  title,
  active,
  body,
  mood,
  page,
}: {
  title: string;
  active: string;
  body: string;
  mood?: Mood | null;
  page?: string;
}): string => {
  const attrs = `${mood ? ` data-mood="${mood}"` : ""}${page ? ` data-page="${escapeHtml(page)}"` : ""}`;
  const links = NAV.map(
    ([href, label]) =>
      `<a href="${href}"${href === active ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="en"${attrs}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}"><link rel="stylesheet" href="/style.css"><script src="/player.js" defer></script></head>
<body><div class="sheet"><header class="top"><span class="brand">Speech Coach</span><nav aria-label="Main">${links}</nav></header><main>${body}</main></div></body></html>`;
};

export const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export const redirect = (location: string): Response =>
  new Response(null, { status: 303, headers: { location } });
