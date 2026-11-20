import { addDays, todayLocal } from "../../domain/time";
import { correction, escapeHtml, htmlResponse, layout, shortDate, type Handler } from "../html";

export type RepeatRow = { pattern: string; kind: string; said: string; better: string; day: string };
export type RepeatItem = {
  pattern: string;
  kind: string;
  said: string;
  better: string;
  count: number;
  days: readonly string[];
  first: string;
  last: string;
};

export const MIN_REPEAT_DAYS = 3;
export const FIXED_AFTER_DAYS = 14;

export const groupRepeats = (
  rows: readonly RepeatRow[],
  today: string,
): { active: RepeatItem[]; fixed: RepeatItem[] } => {
  const byPattern = new Map<string, RepeatRow[]>();
  for (const r of rows) byPattern.set(r.pattern, [...(byPattern.get(r.pattern) ?? []), r]);
  const cutoff = addDays(today, -FIXED_AFTER_DAYS);
  const active: RepeatItem[] = [];
  const fixed: RepeatItem[] = [];
  for (const [pattern, group] of byPattern) {
    const sorted = [...group].sort((a, b) => a.day.localeCompare(b.day));
    const days = new Set(sorted.map((r) => r.day));
    if (days.size < MIN_REPEAT_DAYS) continue;
    const example = sorted[sorted.length - 1]!;
    const item: RepeatItem = {
      pattern,
      kind: example.kind,
      said: example.said,
      better: example.better,
      count: days.size,
      days: [...days].sort(),
      first: sorted[0]!.day,
      last: example.day,
    };
    (item.last < cutoff ? fixed : active).push(item);
  }
  const byLast = (a: RepeatItem, b: RepeatItem) => b.last.localeCompare(a.last);
  return { active: active.sort(byLast), fixed: fixed.sort(byLast) };
};

export const patternLabel = (pattern: string): string =>
  pattern.slice(pattern.indexOf(":") + 1).split("->")[0]!.trim().replaceAll("-", " ");

/** Joins patterns that show the same headword and kind. The newest entry gives the example. */
export const mergeRepeats = (
  items: readonly RepeatItem[],
  today: string,
): { active: RepeatItem[]; fixed: RepeatItem[] } => {
  const merged = new Map<string, RepeatItem>();
  for (const i of items) {
    const key = `${i.kind}\u0000${patternLabel(i.pattern)}`;
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, { ...i, pattern: patternLabel(i.pattern) });
      continue;
    }
    const newer = i.last > seen.last ? i : seen;
    const days = [...new Set([...seen.days, ...i.days])].sort();
    merged.set(key, {
      pattern: seen.pattern,
      kind: seen.kind,
      said: newer.said,
      better: newer.better,
      count: days.length,
      days,
      first: i.first < seen.first ? i.first : seen.first,
      last: newer.last,
    });
  }
  const cutoff = addDays(today, -FIXED_AFTER_DAYS);
  const all = [...merged.values()];
  const byLast = (a: RepeatItem, b: RepeatItem) => b.last.localeCompare(a.last);
  return {
    active: all.filter((i) => i.last >= cutoff).sort(byLast),
    fixed: all.filter((i) => i.last < cutoff).sort(byLast),
  };
};

const entries = (items: readonly RepeatItem[], fixed: boolean): string =>
  `<ul class="plain entries${fixed ? " fixed" : ""}">${items
    .map(
      (i) =>
        `<li class="entry"><p><strong class="word">${escapeHtml(patternLabel(i.pattern))}</strong> <em class="kind">${escapeHtml(i.kind.toLowerCase())}</em> <span class="grey"><span class="num">${i.count}</span> days, ${shortDate(i.first)} to ${shortDate(i.last)}${fixed ? ", <em>fixed</em>" : ""}</span></p><p>${correction(i.said, i.better)}</p></li>`,
    )
    .join("")}</ul>`;

export const repeatsPage: Handler = (_req, ctx) => {
  const rows = ctx.db
    .query<RepeatRow, []>("SELECT pattern, kind, said, better, day FROM issues")
    .all();
  const today = todayLocal(ctx.now(), ctx.offsetOf);
  const grouped = groupRepeats(rows, today);
  const { active, fixed } = mergeRepeats([...grouped.active, ...grouped.fixed], today);
  const body = `<h1>Repeat mistakes</h1>${
    active.length ? entries(active, false) : '<p class="empty">No repeat mistakes yet.</p>'
  }<h2>Fixed</h2>${fixed.length ? `<div class="fixed">${entries(fixed, true)}</div>` : '<p class="empty">Nothing fixed yet.</p>'}`;
  return htmlResponse(layout({ title: "Repeat mistakes", active: "/repeats", body }));
};
