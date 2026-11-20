import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoachDb } from "../../db/coach";
import type { WebContext } from "../html";
import { groupRepeats, mergeRepeats, patternLabel, repeatsPage, tally, type RepeatItem } from "./repeats";

type Row = { pattern: string; kind: string; said: string; better: string; day: string };
const row = (pattern: string, day: string, said = `said ${pattern}`): Row => ({
  pattern,
  kind: "grammar",
  said,
  better: `better ${pattern}`,
  day,
});

describe("groupRepeats", () => {
  const today = "2026-11-19";

  test("lists a pattern on 3 distinct days with count, first and last", () => {
    const { active, fixed } = groupRepeats(
      [row("p", "2026-11-17"), row("p", "2026-11-10"), row("p", "2026-11-15")],
      today,
    );
    expect(fixed).toEqual([]);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ pattern: "p", count: 3, first: "2026-11-10", last: "2026-11-17" });
  });

  test("counts distinct days, so 3 rows on 2 days is not listed", () => {
    const { active, fixed } = groupRepeats(
      [row("p", "2026-11-17"), row("p", "2026-11-17"), row("p", "2026-11-16")],
      today,
    );
    expect(active).toEqual([]);
    expect(fixed).toEqual([]);
  });

  test("moves a pattern last seen more than 14 days ago to fixed", () => {
    const rows = ["2026-10-20", "2026-10-25", "2026-11-04"].map((d) => row("old", d));
    const { active, fixed } = groupRepeats(rows, today);
    expect(active).toEqual([]);
    expect(fixed.map((f) => f.pattern)).toEqual(["old"]);
  });

  test("does not list a stale pattern seen on only 2 days as fixed", () => {
    const { active, fixed } = groupRepeats([row("p", "2026-10-01"), row("p", "2026-10-02")], today);
    expect(active).toEqual([]);
    expect(fixed).toEqual([]);
  });

  test("keeps a pattern last seen exactly 14 days ago active", () => {
    const rows = ["2026-10-20", "2026-10-25", "2026-11-05"].map((d) => row("edge", d));
    expect(groupRepeats(rows, today).active.map((a) => a.pattern)).toEqual(["edge"]);
  });

  test("carries kind and an example said/better", () => {
    const rows = ["2026-11-11", "2026-11-12", "2026-11-13"].map((d) => row("p", d));
    const [item] = groupRepeats(rows, today).active;
    expect(item?.kind).toBe("grammar");
    expect(item?.said).toBe("said p");
    expect(item?.better).toBe("better p");
  });
});

describe("patternLabel with arrows", () => {
  test("keeps the part before -> and drops the kind prefix", () => {
    expect(patternLabel("article:few->a few")).toBe("few");
    expect(patternLabel("verb-pattern:explain me->explain to me")).toBe("explain me");
    expect(patternLabel("article:missing-the")).toBe("missing the");
  });
});

describe("mergeRepeats", () => {
  const today = "2026-11-19";
  const item = (pattern: string, over: Partial<RepeatItem> = {}): RepeatItem => ({
    pattern, kind: "grammar", said: "s", better: "b", count: 3, days: ["2026-11-10", "2026-11-12", "2026-11-17"],
    first: "2026-11-10", last: "2026-11-17", ...over,
  });

  test("joins patterns with the same headword and kind, adding days and widening the dates", () => {
    const { active, fixed } = mergeRepeats(
      [
        item("article:few->a few", { count: 3, days: ["2026-11-12", "2026-11-13", "2026-11-14"], first: "2026-11-12", last: "2026-11-14", said: "old" }),
        item("article:few->few of", { count: 4, days: ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-18"], first: "2026-11-05", last: "2026-11-18", said: "new" }),
      ],
      today,
    );
    expect(fixed).toEqual([]);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ pattern: "few", count: 7, first: "2026-11-05", last: "2026-11-18", said: "new" });
  });

  test("counts a day shared by two merged patterns once", () => {
    const { active } = mergeRepeats(
      [
        item("a:go->x", { count: 3, days: ["2026-11-10", "2026-11-12", "2026-11-17"] }),
        item("a:go->y", { count: 3, days: ["2026-11-10", "2026-11-12", "2026-11-18"], last: "2026-11-18" }),
      ],
      today,
    );
    expect(active[0]).toMatchObject({ count: 4, first: "2026-11-10", last: "2026-11-18" });
  });

  test("keeps a different kind with the same headword apart", () => {
    const { active } = mergeRepeats([item("a:like"), item("b:like", { kind: "filler" })], today);
    expect(active).toHaveLength(2);
  });

  test("is fixed only when every merged pattern is fixed", () => {
    const stale = { first: "2026-09-01", last: "2026-09-10" };
    expect(mergeRepeats([item("x:go->a", stale), item("x:go->b", stale)], today).fixed).toHaveLength(1);
    const mixed = mergeRepeats([item("x:go->a", stale), item("x:go->b")], today);
    expect(mixed.fixed).toEqual([]);
    expect(mixed.active).toHaveLength(1);
  });
});

describe("repeatsPage", () => {
  let dir: string;
  let db: Database;
  let ctx: WebContext;

  const addIssue = (n: number, day: string, pattern: string) => {
    const id = `d-${pattern}-${day}-${n}`;
    db.query(
      `INSERT OR IGNORE INTO dictations (id, ts, day, app, asr_text, words, text_status, audio_status)
       VALUES (?, ?, ?, 'Slack', 'text', 10, 'done', 'pending')`,
    ).run(id, `${day}T10:00:00Z`, day);
    db.query(
      `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern)
       VALUES (?, ?, 'grammar', ?, ?, 'because', ?)`,
    ).run(id, day, `said-${pattern}`, `better-${pattern}`, pattern);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repeats-"));
    const opened = openCoachDb(join(dir, "coach.sqlite"));
    if (!opened.ok) throw new Error(opened.error);
    db = opened.value;
    ctx = { db, now: () => new Date("2026-11-19T12:00:00Z"), offsetOf: () => -330, port: 4777 };
    ["2026-11-10", "2026-11-12", "2026-11-17"].forEach((d, i) => addIssue(i, d, "active-pat"));
    ["2026-11-12", "2026-11-17"].forEach((d, i) => addIssue(i, d, "two-day-pat"));
    ["2026-10-20", "2026-10-28", "2026-11-04"].forEach((d, i) => addIssue(i, d, "stale-pat"));
    ["2026-10-01", "2026-10-02"].forEach((d, i) => addIssue(i, d, "stale-two-pat"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async () => {
    const res = await repeatsPage(new Request("http://127.0.0.1:4777/repeats"), ctx);
    return { res, html: await res.text() };
  };

  test("returns an html page with the Repeat mistakes nav item active", async () => {
    const { res, html } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('<a href="/repeats" aria-current="page">');
  });

  test("lists a 3-day pattern with count, first and last date and an example", async () => {
    const { html } = await get();
    expect(html).toContain("active-pat");
    expect(html).toContain('<span class="num">3</span> days, 10 Nov to 17 Nov');
    expect(html).toContain("said-active-pat");
    expect(html).toContain("better-active-pat");
  });

  test("does not list a pattern seen on only 2 days", async () => {
    const { html } = await get();
    expect(html).not.toContain("two-day-pat");
  });

  test("lists a pattern last seen 15 days ago under Fixed, after the active ones", async () => {
    const { html } = await get();
    const fixedAt = html.indexOf("Fixed");
    expect(fixedAt).toBeGreaterThan(-1);
    expect(html.indexOf("stale-pat")).toBeGreaterThan(fixedAt);
    expect(html.indexOf("active-pat")).toBeLessThan(fixedAt);
    expect(html).not.toContain("stale-two-pat");
  });

  test("escapes pattern text", async () => {
    ["2026-11-14", "2026-11-15", "2026-11-16"].forEach((d, i) => addIssue(i, d, "<i>x</i>"));
    const { html } = await get();
    expect(html).not.toContain("<i>x</i>");
    expect(html).toContain("&lt;i&gt;x&lt;/i&gt;");
  });

  test("shows the example as a correction mark on its own line, with the kind in italic", async () => {
    ["2026-11-14", "2026-11-15", "2026-11-16"].forEach((d, i) => addIssue(i, d, "mark-pat"));
    const { html } = await get();
    expect(html).toMatch(/<p class="line"><span class="fix k-grammar" data-b="better-mark-pat"><del class="said">said-mark-pat<\/del> <ins class="better">better-mark-pat<\/ins><\/span><\/p>/);
    expect(html).toContain('<em class="kind">grammar</em>');
    expect(html).not.toContain("<table");
    expect(html).not.toContain('class="bar');
  });

  test("draws the count as tally marks: groups of five with a diagonal gate, a short last group", () => {
    const strokes = (html: string) => html.match(/<line /g)?.length ?? 0;
    expect(tally(22).match(/<svg /g)).toHaveLength(5);
    expect(strokes(tally(22))).toBe(22);
    expect(strokes(tally(5))).toBe(5);
    expect(strokes(tally(3))).toBe(3);
    expect(tally(3)).toContain('viewBox="0 0 17 20"');
    expect(tally(5)).toContain('viewBox="0 0 26 20"');
  });

  test("shows the tally and the kind ring beside the headword, with the day count as text", async () => {
    ["2026-11-14", "2026-11-15", "2026-11-16"].forEach((d, i) => addIssue(i, d, "ring-pat"));
    const { html } = await get();
    expect(html).toContain('<span class="tally" aria-hidden="true">');
    expect(html).toContain('<span class="ring ring-gr" aria-hidden="true">gr</span><em class="kind">grammar</em>');
  });

  test("shows the pattern without its kind prefix and with spaces for hyphens", async () => {
    expect(patternLabel("filler:like")).toBe("like");
    expect(patternLabel("article:missing-the")).toBe("missing the");
    expect(patternLabel("plain")).toBe("plain");
    ["2026-11-14", "2026-11-15", "2026-11-16"].forEach((d, i) => addIssue(i, d, "article:missing-the"));
    const { html } = await get();
    expect(html).toContain('<strong class="word">missing the</strong>');
  });

  test("a fixed entry is greyed and marked fixed in italic", async () => {
    const { html } = await get();
    expect(html).toMatch(/<div class="fixed"><ul class="plain entries fixed">[\s\S]*<em>fixed<\/em>/);
  });
});
