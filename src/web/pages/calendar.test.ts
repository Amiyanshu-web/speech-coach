import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openCoachDb } from "../../db/coach";
import type { WebContext } from "../html";
import { bucketOf, calendarPage, cellTitle, issuesPer100 } from "./calendar";

const NOW = new Date("2026-11-19T10:00:00Z");
const TODAY = "2026-11-19";

let db: Database;
const ctx = (): WebContext => ({ db, now: () => NOW, offsetOf: () => -330, port: 4777 });
const getHtml = async (): Promise<string> =>
  (await calendarPage(new Request("http://127.0.0.1:4777/calendar"), ctx())).text();
const dayLinks = (html: string): string[] =>
  [...html.matchAll(/href="\/\?day=(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1] as string);
const cellFor = (html: string, day: string): string =>
  html.match(new RegExp(`<a[^>]*href="/\\?day=${day}"[^>]*>`))?.[0] ?? "";

const seedDay = (day: string, words: number, issues: number, textStatus = "done"): void => {
  db.run(
    `INSERT INTO dictations (id, ts, day, words, text_status, audio_status)
     VALUES (?, '2026-11-15 10:00:00.000 +00:00', ?, ?, ?, 'done')`,
    [`d-${day}`, day, words, textStatus],
  );
  for (let i = 0; i < issues; i++) {
    db.run(
      `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern) VALUES (?, ?, 'word', 'a', 'b', 'c', 'p')`,
      [`d-${day}`, day],
    );
  }
};

beforeEach(() => {
  const r = openCoachDb(":memory:");
  if (!r.ok) throw new Error(r.error);
  db = r.value;
});
afterEach(() => db.close());

describe("issuesPer100", () => {
  test("is issues per 100 words, and null without words", () => {
    expect(issuesPer100(2, 100)).toBe(2);
    expect(issuesPer100(1, 200)).toBe(0.5);
    expect(issuesPer100(0, 50)).toBe(0);
    expect(issuesPer100(3, 0)).toBeNull();
  });
});

describe("bucketOf", () => {
  test("maps rates to buckets 0 to 4 on the thresholds 2, 3.5, 5, 7", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(1.99)).toBe(0);
    expect(bucketOf(2)).toBe(1);
    expect(bucketOf(3.49)).toBe(1);
    expect(bucketOf(3.5)).toBe(2);
    expect(bucketOf(4.99)).toBe(2);
    expect(bucketOf(5)).toBe(3);
    expect(bucketOf(6.99)).toBe(3);
    expect(bucketOf(7)).toBe(4);
    expect(bucketOf(40)).toBe(4);
  });
});

describe("calendar title", () => {
  test("cellTitle shows the rate with one decimal, or says there is no data", () => {
    expect(cellTitle("2026-11-19", 6.25)).toBe("2026-11-19: 6.3 issues per 100 words");
    expect(cellTitle("2026-11-19", null)).toBe("2026-11-19: no analysed speech");
  });
});

describe("calendarPage", () => {
  test("renders exactly 90 day links, the last being today and the first 89 days earlier", async () => {
    const days = dayLinks(await getHtml());
    expect(days).toHaveLength(90);
    expect(days[89]).toBe(TODAY);
    expect(days[0]).toBe("2026-08-22");
    expect(new Set(days).size).toBe(90);
  });

  test("2 issues over 100 words gets the bucket for rate 2", async () => {
    seedDay("2026-11-10", 100, 2);
    const cell = cellFor(await getHtml(), "2026-11-10");
    expect(cell).toContain(`cal-${bucketOf(2)}`);
    expect(cell).not.toContain("cal-grey");
  });

  test("a day with words and no issues is cal-0", async () => {
    seedDay("2026-11-11", 80, 0);
    expect(cellFor(await getHtml(), "2026-11-11")).toContain("cal-0");
  });

  test("a day without words is cal-grey", async () => {
    const html = await getHtml();
    expect(cellFor(html, "2026-11-12")).toContain("cal-grey");
  });

  test("words of dictations not analysed do not count", async () => {
    seedDay("2026-11-13", 100, 0, "pending");
    expect(cellFor(await getHtml(), "2026-11-13")).toContain("cal-grey");
  });

  test("the local day of now decides today", async () => {
    const late = { db, now: () => new Date("2026-11-19T20:00:00Z"), offsetOf: () => -330, port: 4777 };
    const days = dayLinks(await (await calendarPage(new Request("http://127.0.0.1:4777/calendar"), late)).text());
    expect(days[89]).toBe("2026-11-20");
  });

  test("shows the legend with five bucket dots, a no-speech ring and the labels", async () => {
    const html = await getHtml();
    expect(html).toContain('class="cal-legend"');
    expect(html).toContain("Fewer mistakes");
    expect(html).toContain("More mistakes");
    expect(html).toContain("No speech");
    for (const cls of ["cal-0", "cal-1", "cal-2", "cal-3", "cal-4", "cal-grey"]) {
      expect(html).toContain(`<span class="dot ${cls}">`);
    }
  });

  test("draws one row per month in range, oldest first, with the day dots inside", async () => {
    const html = await getHtml();
    const months = [...html.matchAll(/<span class="cal-month">(\w+)<\/span>/g)].map((m) => m[1]);
    expect(months).toEqual(["Aug", "Sep", "Oct", "Nov"]);
    const aug = html.split('<div class="cal-row">')[1] ?? "";
    expect(aug.match(/class="dot /g)).toHaveLength(10);
    expect(html).not.toContain("cal-grid");
    expect(html).not.toContain("cal-head");
  });

  test("marks only today's dot, and gives every dot a title and a name", async () => {
    const html = await getHtml();
    expect(html.match(/class="dot [^"]*today"/g)).toHaveLength(1);
    expect(cellFor(html, TODAY)).toContain("today");
    expect(cellFor(html, TODAY)).toMatch(/title="2026-11-19: no analysed speech" aria-label=/);
  });
});
