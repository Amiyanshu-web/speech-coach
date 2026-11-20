import { addDays, parseWisprTimestamp, todayLocal } from "../../domain/time";
import { escapeHtml, htmlResponse, kindLabel, kindRing, layout, proofLine, type Handler, type Mood } from "../html";

type LessonItem = { kind: string; pattern: string; said: string; better: string; practice: string };
type IssueRow = {
  kind: string;
  said: string;
  better: string;
  reason: string;
  dictation_id: string;
  ts: string | null;
  asr_text: string | null;
  audio_status: string | null;
  text_status: string | null;
};

const AUDIO_KEPT_MS = 14 * 24 * 60 * 60 * 1000;

const PLAY_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1 L11 6 L2 11 Z"/></svg>';

/** A real audio element for playback plus a waveform that /player.js reveals; without JS the browser controls stay. */
const clipPlayer = (id: string): string =>
  `<div class="clip" data-peaks="/audio/${id}/peaks"><audio controls preload="none" src="/audio/${id}"></audio>` +
  `<button type="button" class="play" aria-label="Play recording" hidden>${PLAY_ICON}</button>` +
  `<svg class="wave" viewBox="0 0 240 32" preserveAspectRatio="none" role="slider" tabindex="0" aria-label="Recording position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" hidden></svg>` +
  `<span class="time" hidden>0:00 / 0:00</span></div>`;

const heardBlock = (i: IssueRow, now: Date): string => {
  const at = i.ts ? parseWisprTimestamp(i.ts) : null;
  const playable =
    i.audio_status !== "skipped" && at?.ok === true && now.getTime() - at.value <= AUDIO_KEPT_MS;
  const player = playable ? clipPlayer(encodeURIComponent(i.dictation_id)) : "";
  const raw = i.asr_text ? `<p class="raw">${escapeHtml(i.asr_text)}</p>` : "";
  if (!raw && !player) return "";
  return `<details class="heard"><summary>What Wispr heard</summary>${raw}${player}</details>`;
};
type WordRow = { word: string; meaning: string; example: string; from_sentence: string };

const isRealDay = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;

const isLessonItem = (x: unknown): x is LessonItem => {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    ["kind", "said", "better", "practice"].every((k) => typeof o[k] === "string") &&
    (o.pattern === undefined || typeof o.pattern === "string")
  );
};

const parseLesson = (json: string): LessonItem[] => {
  try {
    const items = (JSON.parse(json) as { items?: unknown }).items;
    return Array.isArray(items) ? items.filter(isLessonItem) : [];
  } catch {
    return [];
  }
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const dayNumber = (day: string): number => Number(day.slice(8, 10));

export const weekdayMonth = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]}`;
};

const num = (n: number): string => n.toLocaleString("en-US");

export const statsSentence = (words: number, issues: number): string =>
  `${num(words)} ${words === 1 ? "word" : "words"} spoken, <b>${num(issues)} to improve</b>.`;

const MIN_WORDS = 50;
const MIN_BASELINE_DAYS = 5;
const BASELINE_DAYS = 30;
const GOOD_BELOW = 0.75;
const BUSY_ABOVE = 1.25;

export type DayTotals = { words: number; issues: number };

export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const per100 = (d: DayTotals): number => (d.issues * 100) / d.words;

/**
 * How the day went against the usual day: issues per 100 words versus the median of earlier days.
 * Null (plain paper) for a day under 50 words or with fewer than 5 earlier days of 50 words or more.
 * With a baseline of zero, no issues is even and any issue is busy.
 */
export const moodOf = (day: DayTotals, earlier: readonly DayTotals[]): Mood | null => {
  if (day.words < MIN_WORDS) return null;
  const scores = earlier.filter((d) => d.words >= MIN_WORDS).map(per100);
  if (scores.length < MIN_BASELINE_DAYS) return null;
  const baseline = median(scores);
  const score = per100(day);
  if (baseline === 0) return score === 0 ? "even" : "busy";
  if (score <= GOOD_BELOW * baseline) return "good";
  if (score >= BUSY_ABOVE * baseline) return "busy";
  return "even";
};

const MOOD_SENTENCE: Record<Mood, string> = {
  good: "A calmer day than usual.",
  even: "About your usual day.",
  busy: "A busier day than usual.",
};

export const ISSUE_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["grammar", "Grammar"],
  ["word", "Word choice"],
  ["filler", "Fillers"],
  ["sound", "Sounds"],
];

const FILTER_SCRIPT = `(()=>{const bar=document.querySelector("[data-filters]");if(!bar)return;bar.hidden=false;bar.addEventListener("click",(e)=>{const b=e.target.closest("button[data-filter]");if(!b)return;const f=b.dataset.filter;bar.querySelectorAll("button").forEach((x)=>x.setAttribute("aria-pressed",String(x===b)));document.querySelectorAll("[data-kind]").forEach((s)=>{s.hidden=f!=="all"&&s.dataset.kind!==f;if(s.hidden)s.querySelectorAll("audio").forEach((a)=>a.pause());});});})();`;

const issuesSection = (issues: readonly IssueRow[], now: Date, nextMark: () => number): string => {
  if (issues.length === 0) return "";
  const groups = ISSUE_GROUPS.map(([kind, label]) => ({
    kind,
    label,
    rows: issues.filter((i) => i.kind === kind),
  }));
  const filters = [{ kind: "all", label: "All", rows: issues }, ...groups]
    .map(
      (g) =>
        `<button type="button" class="filter" data-filter="${escapeHtml(g.kind)}" aria-pressed="${g.kind === "all"}">${g.label} <span class="n">${g.rows.length}</span></button>`,
    )
    .join(" ");
  const sections = groups
    .filter((g) => g.rows.length > 0)
    .map(
      (g) =>
        `<section class="issue-group" data-kind="${escapeHtml(g.kind)}"><h3>${g.label}</h3><ul class="plain issue">${g.rows
          .map(
            (i) =>
              `<li class="mark">${proofLine(i.said, i.better, nextMark(), i.kind, i.asr_text)}<p class="note">${kindRing(i.kind)}<span class="reason">${escapeHtml(i.reason)}</span></p>${heardBlock(i, now)}</li>`,
          )
          .join("")}</ul></section>`,
    )
    .join("");
  return `<section class="issues"><h2>Mistakes</h2><p class="filters" data-filters hidden>${filters}</p>${sections}<script>${FILTER_SCRIPT}</script></section>`;
};

export const todayPage: Handler = (req, ctx) => {
  const today = todayLocal(ctx.now(), ctx.offsetOf);
  const asked = new URL(req.url).searchParams.get("day") ?? "";
  const day = isRealDay(asked) ? asked : today;

  const lessonRow = ctx.db.query("SELECT json FROM lessons WHERE day = ?").get(day) as { json: string } | null;
  const words = ctx.db
    .query("SELECT word, meaning, example, from_sentence FROM daily_words WHERE day = ? ORDER BY word")
    .all(day) as WordRow[];
  const issues = ctx.db
    .query(`SELECT i.kind, i.said, i.better, i.reason, i.dictation_id, d.ts, d.asr_text, d.audio_status, d.text_status
       FROM issues i LEFT JOIN dictations d ON d.id = i.dictation_id WHERE i.day = ? ORDER BY i.id`,
    )
    .all(day) as IssueRow[];
  const spoken = ctx.db
    .query("SELECT COALESCE(SUM(words), 0) AS n FROM dictations WHERE text_status = 'done' AND day = ?")
    .get(day) as { n: number };

  let marks = 0;
  const nextMark = () => marks++;
  const earlier = ctx.db
    .query(
      `SELECT d.day, SUM(d.words) AS words, (SELECT COUNT(*) FROM issues i JOIN dictations x ON x.id = i.dictation_id
         WHERE i.day = d.day AND x.text_status = 'done') AS issues
       FROM dictations d WHERE d.text_status = 'done' AND d.day >= ? AND d.day < ? GROUP BY d.day`,
    )
    .all(addDays(day, -BASELINE_DAYS), day) as DayTotals[];
  const counted = issues.filter((i) => i.text_status === "done").length;
  const mood = moodOf({ words: spoken.n, issues: counted }, earlier);
  const lesson = lessonRow
    ? `<section class="lesson"><h2>Lesson</h2><ul class="plain lesson-list">${parseLesson(lessonRow.json)
        .map(
          (i) =>
            `<li class="mark">${proofLine(i.said, i.better, nextMark(), i.kind)}<p class="note">${kindRing(i.kind)}<span class="kind vh">${escapeHtml(kindLabel(i.kind))}</span></p><p class="practice">${escapeHtml(i.practice)}</p></li>`,
        )
        .join("")}</ul></section>`
    : "";
  const wordsSection = words.length
    ? `<section class="words"><h2>Words for today</h2><ul class="plain entries">${words
        .map(
          (w) =>
            `<li class="entry"><p class="hw"><span class="caret" aria-hidden="true"></span><strong class="word">${escapeHtml(w.word)}</strong></p><p class="meaning">${escapeHtml(w.meaning)}</p><p class="example">${escapeHtml(w.example)}</p><p class="you-said">You said: <em>${escapeHtml(w.from_sentence)}</em></p></li>`,
        )
        .join("")}</ul></section>`
    : "";
  const issueList = issuesSection(issues, ctx.now(), nextMark);
  const hasSpeech = spoken.n > 0 || issues.length > 0;
  const empty = hasSpeech
    ? ""
    : '<p class="empty">Nothing analysed for this day yet. The nightly run starts at 9 pm.</p>';
  const stats = spoken.n > 0 ? `<p class="stats">${statsSentence(spoken.n, counted)}</p>` : "";
  const moodNote = mood ? `<p class="stats">${MOOD_SENTENCE[mood]}</p>` : "";
  const prev = `<a href="/?day=${addDays(day, -1)}">Previous day</a>`;
  const next = day < today ? `<a href="/?day=${addDays(day, 1)}">Next day</a>` : "";
  const picker = `<form class="picker" method="get" action="/"><label><span class="vh">Go to day</span><input type="date" name="day" value="${day}"></label><button type="submit" class="text">Go</button></form>`;
  const hero = `<div class="hero"><h1><span class="daynum">${dayNumber(day)}</span> <span class="dayname">${weekdayMonth(day)}</span></h1><div class="daynav">${prev}${next}${picker}</div></div>`;
  return htmlResponse(
    layout({ title: "Today", active: "/", mood, page: "today", body: `${hero}${stats}${moodNote}${empty}${wordsSection}${lesson}${issueList}` }),
  );
};
