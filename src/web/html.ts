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
  KIND_CODE.has(kind) ? `<span class="ring" aria-hidden="true">${KIND_CODE.get(kind)}</span>` : "";

const wordKey = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Which words of a list are not part of the longest run of words the two lists share, in order. */
const droppedWords = (from: readonly string[], to: readonly string[]): boolean[] => {
  const rows = from.length + 1;
  const cols = to.length + 1;
  const common = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = from.length - 1; i >= 0; i--) {
    for (let j = to.length - 1; j >= 0; j--) {
      common[i]![j] = from[i] === to[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const dropped = new Array<boolean>(from.length).fill(true);
  for (let i = 0, j = 0; i < from.length && j < to.length; ) {
    if (from[i] === to[j]) {
      dropped[i] = false;
      i++;
      j++;
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) i++;
    else j++;
  }
  return dropped;
};

/** The spoken words with only the words the better version drops inside a delete loop; the whole phrase when none can be told apart. */
export const cutPhrase = (said: string, better: string): string => {
  const words = said.trim().split(/\s+/);
  const dropped = droppedWords(words.map(wordKey), better.split(/\s+/).map(wordKey));
  if (better === "" || !dropped.some(Boolean) || dropped.every(Boolean)) return `<span class="cut">${escapeHtml(said)}</span>`;
  const pieces: string[] = [];
  for (let at = 0; at < words.length; ) {
    let end = at;
    while (end < words.length && dropped[end] === dropped[at]) end++;
    const run = escapeHtml(words.slice(at, end).join(" "));
    pieces.push(dropped[at] ? `<span class="cut">${run}</span>` : run);
    at = end;
  }
  return pieces.join(" ");
};

/**
 * The correction mark: the spoken words marked out, the better words written above them.
 * The kind picks the mark (strike, delete loop, circle, dotted underline); the index orders the pen strike animation.
 * data-b repeats the better words so the CSS can reserve their width above a short phrase.
 */
export const correction = (said: string, better: string, index?: number, kind?: string): string =>
  `<span class="fix${kind !== undefined && KIND_CODE.has(kind) ? ` k-${kind}` : ""}"${
    better === "" ? "" : ` data-b="${escapeHtml(better)}"`
  }><del class="said"${index === undefined ? "" : ` style="--i:${index}"`}>${kind === "filler" ? cutPhrase(said, better) : escapeHtml(said)}</del>${
    better === "" ? "" : ` <ins class="better">${escapeHtml(better)}</ins>`
  }</span>`;

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
