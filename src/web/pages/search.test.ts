import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoachDb } from "../../db/coach";
import { applySkipList } from "../../pipeline/import";
import type { WebContext } from "../html";
import { searchPage, toFtsQuery } from "./search";

describe("toFtsQuery", () => {
  test("double-quotes each term", () => {
    expect(toFtsQuery("more fast")).toBe('"more" "fast"');
  });

  test("doubles inner quotes", () => {
    expect(toFtsQuery('say "hi')).toBe('"say" """hi"');
  });

  test("neutralises syntax characters and operators", () => {
    expect(toFtsQuery("a* (b) NEAR c-d")).toBe('"a*" "(b)" "NEAR" "c-d"');
  });

  test("collapses extra whitespace", () => {
    expect(toFtsQuery("  more \t fast  ")).toBe('"more" "fast"');
  });

  test("treats the private-use snippet markers as spaces", () => {
    expect(toFtsQuery("more\uE000fast\uE001")).toBe('"more" "fast"');
    expect(toFtsQuery("\uE000\uE001")).toBeNull();
  });

  test("returns null for empty or blank input", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
  });
});

describe("searchPage", () => {
  let dir: string;
  let db: Database;
  let ctx: WebContext;

  const addDictation = (id: string, app: string | null, text: string | null, day = "2026-11-18") =>
    db
      .query(
        `INSERT INTO dictations (id, ts, day, app, asr_text, words, text_status, audio_status)
         VALUES (?, ?, ?, ?, ?, 10, 'done', 'pending')`,
      )
      .run(id, `${day}T10:00:00Z`, day, app, text);

  const addIssue = (dictationId: string, said: string, day = "2026-11-18") =>
    db
      .query(
        `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern)
         VALUES (?, ?, 'grammar', ?, 'faster', 'comparative', 'comparative')`,
      )
      .run(dictationId, day, said);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "search-"));
    const opened = openCoachDb(join(dir, "coach.sqlite"));
    if (!opened.ok) throw new Error(opened.error);
    db = opened.value;
    ctx = { db, now: () => new Date("2026-11-19T12:00:00Z"), offsetOf: () => -330, port: 4777 };
    addDictation("d1", "Slack", "please go more fast on this");
    addDictation("d2", "Notes", "he runs more fast than me");
    addDictation("d3", "Slack", "completely unrelated words");
    addIssue("d3", "you drive more fast");
    addDictation("d4", "Messages", null);
    db.query("UPDATE dictations SET formatted_text = 'hiddenword' WHERE id = 'd4'").run();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (qs: string) => {
    const res = await searchPage(new Request(`http://127.0.0.1:4777/search${qs}`), ctx);
    return { res, html: await res.text() };
  };

  test("returns a page with the Search nav item active", async () => {
    const { res, html } = await get("");
    expect(res.status).toBe(200);
    expect(html).toContain('<a href="/search" aria-current="page">');
  });

  test("lists every dictation and issue containing the phrase terms", async () => {
    const { html } = await get("?q=more+fast");
    expect(html).toContain("go <mark>more</mark> <mark>fast</mark> on this");
    expect(html).toContain("runs <mark>more</mark> <mark>fast</mark> than me");
    expect(html).toContain("drive <mark>more</mark> <mark>fast</mark>");
    expect(html).not.toContain("completely unrelated");
  });

  test("shows day and app for each result", async () => {
    const { html } = await get("?q=more+fast");
    expect(html).toContain("18 Nov 2026");
    expect(html).toContain("Slack");
    expect(html).toContain("Notes");
  });

  test("an issue result shows the app of its dictation", async () => {
    const { html } = await get("?q=drive");
    expect(html).toContain("Slack");
  });

  test("the app filter narrows dictation and issue results", async () => {
    const { html } = await get("?q=more+fast&app=Notes");
    expect(html).toContain("runs");
    expect(html).not.toContain("go <mark>");
    expect(html).not.toContain("you drive");
  });

  test("the app dropdown lists distinct apps", async () => {
    const { html } = await get("");
    expect(html).toContain("<select");
    expect(html.match(/<option[^>]*>Slack<\/option>/g)).toHaveLength(1);
    expect(html).toContain(">Notes</option>");
    expect(html).toContain(">Messages</option>");
  });

  test("a skip-list row with null text never appears", async () => {
    const { html } = await get("?q=hiddenword");
    expect(html).not.toContain("<mark>");
    expect(html).not.toContain("<li>");
  });

  test.each(['"', "*", "(", "NEAR", "-", 'a "b', "NEAR(a b)", "a OR b", "col:x", '"" ""'])(
    "query %p returns a page, not an error",
    async (q) => {
      const { res } = await get(`?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
    },
  );

  test("an empty query returns a page with no results", async () => {
    const { res, html } = await get("?q=");
    expect(res.status).toBe(200);
    expect(html).not.toContain("<mark>");
  });

  test("escapes snippet text containing <b> while wrapping matches in <mark>", async () => {
    addDictation("d5", "Slack", "use <b>bold</b> sparingly");
    const { html } = await get("?q=bold");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;<mark>bold</mark>&lt;/b&gt;");
  });

  test("escapes the query echoed back in the form", async () => {
    const { html } = await get(`?q=${encodeURIComponent('"><script>x</script>')}`);
    expect(html).not.toContain("<script>x</script>");
  });

  test("a query with no hit says No matches", async () => {
    const { res, html } = await get("?q=zebrafish");
    expect(res.status).toBe(200);
    expect(html).toContain('<p class="empty">No matches.</p>');
    expect(html).not.toContain("<li>");
  });

  test("an app filter that matches no row says No matches", async () => {
    const { html } = await get("?q=more+fast&app=Nowhere");
    expect(html).toContain('<p class="empty">No matches.</p>');
  });

  test("a database error shows Search failed and still returns the form", async () => {
    db.exec("DROP TABLE issues_fts");
    const { res, html } = await get("?q=more+fast");
    expect(res.status).toBe(200);
    expect(html).toContain('<p class="error">Search failed. Try different words.</p>');
    expect(html).toContain('<input type="search" name="q" value="more fast">');
    expect(html).not.toContain("<mark>");
  });

  test("a row with no app shows as unknown", async () => {
    addDictation("d6", null, "quokka sighting today");
    const { html } = await get("?q=quokka");
    expect(html).toContain(
      '<li><span class="meta">18 Nov 2026, unknown</span><span class="hit"><mark>quokka</mark> sighting today</span></li>',
    );
  });

  test("results from both sources come newest day first", async () => {
    addDictation("d7", "Notes", "walrus in the old note", "2026-11-10");
    addDictation("d8", "Notes", "plain words", "2026-11-15");
    addIssue("d8", "walrus issue", "2026-11-15");
    addDictation("d9", "Notes", "walrus in the new note", "2026-11-17");
    const { html } = await get("?q=walrus");
    expect([...html.matchAll(/<span class="meta">(\d+ \w+ \d{4}), Notes<\/span>/g)].map((m) => m[1])).toEqual([
      "17 Nov 2026",
      "15 Nov 2026",
      "10 Nov 2026",
    ]);
  });

  test("each source returns at most 100 results", async () => {
    for (let i = 0; i < 101; i++) addDictation(`many-${i}`, "Notes", "narwhal again");
    const { html } = await get("?q=narwhal");
    expect(html.match(/<li>/g)).toHaveLength(100);
  });

  test("a row whose text the skip list removed is no longer found", async () => {
    db.query("UPDATE dictations SET text_status = 'pending' WHERE id = 'd1'").run();
    expect((await get("?q=please")).html).toContain("<mark>please</mark>");
    applySkipList({ coach: db, skipList: ["Slack"] });
    const { html } = await get("?q=please");
    expect(html).toContain('<p class="empty">No matches.</p>');
  });

  test("puts the app filter beside the search field and labels both", async () => {
    const { html } = await get("");
    expect(html).toContain('<form class="search-form"');
    expect(html).toMatch(/<label class="grow"><span class="vh">Search<\/span><input type="search"/);
    expect(html).toMatch(/<label><span class="vh">App<\/span><select name="app">/);
    expect(html).toContain('<button type="submit" class="text">Search</button>');
  });
});
