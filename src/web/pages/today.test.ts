import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openCoachDb } from "../../db/coach";
import type { WebContext } from "../html";
import { ISSUE_GROUPS, dayNumber, median, moodOf, statsSentence, weekdayMonth, todayPage } from "./today";

const NOW = new Date("2026-11-19T10:00:00Z");
const TODAY = "2026-11-19";
const PAST = "2026-11-15";

let db: Database;
const ctx = (): WebContext => ({ db, now: () => NOW, offsetOf: () => -330, port: 4777 });
const get = async (query = ""): Promise<{ status: number; html: string }> => {
  const res = await todayPage(new Request(`http://127.0.0.1:4777/${query}`), ctx());
  return { status: res.status, html: await res.text() };
};

const addDictation = (id: string, day: string, ts = "2026-11-15 10:00:00.000 +00:00", asr: string | null = null): void => {
  db.run(
    `INSERT INTO dictations (id, ts, day, app, words, text_status, audio_status, asr_text)
     VALUES (?, ?, ?, 'Slack', 50, 'done', 'done', ?)`,
    [id, ts, day, asr],
  );
};
const addIssue = (id: string, day: string, over: Partial<Record<string, string>> = {}): void => {
  db.run(
    `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      day,
      over.kind ?? "grammar",
      over.said ?? "more fast",
      over.better ?? "faster",
      over.reason ?? "comparative form",
      "comparative",
    ],
  );
};
const addLesson = (day: string): void => {
  const items = [
    { kind: "grammar", pattern: "comparative", said: "more fast", better: "faster", practice: "Say faster ten times." },
    { kind: "filler", pattern: "like", said: "like um", better: "pause", practice: "Pause instead." },
  ];
  db.run("INSERT INTO lessons (day, json) VALUES (?, ?)", [day, JSON.stringify({ items })]);
};
const addWords = (day: string): void => {
  for (const w of ["alpha", "bravo", "charlie", "delta", "echo"]) {
    db.run("INSERT INTO daily_words (day, word, meaning, example, from_sentence) VALUES (?, ?, ?, ?, ?)", [
      day, w, `meaning of ${w}`, `example of ${w}`, `sentence with ${w}`,
    ]);
  }
};

beforeEach(() => {
  const r = openCoachDb(":memory:");
  if (!r.ok) throw new Error(r.error);
  db = r.value;
});
afterEach(() => db.close());

describe("todayPage", () => {
  test("shows lesson items, the 5 words and each issue's said, better, kind and reason for today", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY, { kind: "filler", said: "basically so", better: "start directly", reason: "filler opener" });
    addLesson(TODAY);
    addWords(TODAY);
    const { status, html } = await get();
    expect(status).toBe(200);
    expect(html).toContain('class="lesson"');
    expect(html).toContain("Say faster ten times.");
    expect(html).toContain("Pause instead.");
    for (const w of ["alpha", "bravo", "charlie", "delta", "echo"]) expect(html).toContain(w);
    expect(html).toContain("meaning of alpha");
    expect(html).toContain("basically so");
    expect(html).toContain("start directly");
    expect(html).toContain("filler");
    expect(html).toContain("filler opener");
  });

  test("shows the raw words Wispr heard in a closed disclosure under each mistake, escaped", async () => {
    addDictation("d1", TODAY, "2026-11-18 10:00:00.000 +00:00", "uh so I I goed <b>there</b>");
    addIssue("d1", TODAY, { said: "goed", better: "went" });
    addIssue("d1", TODAY, { said: "I I", better: "I" });
    const { html } = await get();
    expect(html).toContain("uh so I I goed &lt;b&gt;there&lt;/b&gt;");
    expect(html).not.toContain("<b>there</b>");
    expect(html.split('<details class="heard">').length - 1).toBe(2);
    expect(html).not.toContain("<details class=\"heard\" open");
  });

  test("shows a lazy player with the encoded id for a dictation within 14 days", async () => {
    addDictation("d1", TODAY, "2026-11-06 10:00:00.000 +00:00", "hello");
    addIssue("d1", TODAY);
    const { html } = await get();
    expect(html).toContain('<audio controls preload="none" src="/audio/d1"></audio>');
    expect(html).toContain('<button type="button" class="play" aria-label="Play recording" hidden>');
    expect(html).toContain('role="slider"');
    expect(html).toContain('data-peaks="/audio/d1/peaks"');
  });

  test("the player is there at exactly 14 days and gone 1 ms later", async () => {
    addDictation("edge", TODAY, "2026-11-05 10:00:00.000 +00:00");
    addIssue("edge", TODAY);
    addDictation("late", TODAY, "2026-11-05 09:59:59.999 +00:00");
    addIssue("late", TODAY);
    const res = await todayPage(new Request("http://127.0.0.1:4777/"), { ...ctx(), now: () => new Date("2026-11-19T10:00:00Z") });
    const html = await res.text();
    expect(html).toContain('src="/audio/edge"');
    expect(html).not.toContain('src="/audio/late"');
  });

  test("an old dictation keeps its raw text but has no player", async () => {
    addDictation("old", TODAY, "2026-10-01 10:00:00.000 +00:00", "uh old words");
    addIssue("old", TODAY);
    const { html } = await get();
    expect(html).toContain("uh old words");
    expect(html).not.toContain("<audio");
  });

  test("no player when Wispr audio is known to be missing", async () => {
    addDictation("gone", TODAY, "2026-11-18 10:00:00.000 +00:00", "words");
    db.run("UPDATE dictations SET audio_status = 'skipped' WHERE id = 'gone'");
    addIssue("gone", TODAY);
    const { html } = await get();
    expect(html).toContain("words");
    expect(html).not.toContain("<audio");
  });

  test("shows no player for a dictation older than 14 days, and no raw text when none was saved", async () => {
    addDictation("d1", PAST, "2026-11-01 10:00:00.000 +00:00", null);
    addIssue("d1", PAST);
    const { html } = await get(`?day=${PAST}`);
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("heard");
  });

  test("?day= opens a past day and not today", async () => {
    addDictation("d1", PAST);
    addIssue("d1", PAST, { said: "past mistake" });
    addDictation("d2", TODAY);
    addIssue("d2", TODAY, { said: "today mistake" });
    const { html } = await get(`?day=${PAST}`);
    expect(html).toContain("past mistake");
    expect(html).not.toContain("today mistake");
  });

  test("an invalid day falls back to today", async () => {
    addDictation("d2", TODAY);
    addIssue("d2", TODAY, { said: "today mistake" });
    for (const q of ["?day=not-a-date", "?day=2026-13-45", "?day=2026-02-30", "?day=<script>"]) {
      const { status, html } = await get(q);
      expect(status).toBe(200);
      expect(html).toContain("today mistake");
    }
  });

  test("uses the local day, not the UTC day, for today", async () => {
    const late = { db, now: () => new Date("2026-11-19T20:00:00Z"), offsetOf: () => -330, port: 4777 };
    addDictation("d3", "2026-11-20");
    addIssue("d3", "2026-11-20", { said: "next local day" });
    const res = await todayPage(new Request("http://127.0.0.1:4777/"), late);
    expect(await res.text()).toContain("next local day");
  });

  test("escapes markup in an issue", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY, { said: "<script>alert(1)</script>", better: "<b>x</b>", reason: "a & b" });
    const { html } = await get();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  test("issues without a lesson show the issues and no lesson card", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY, { said: "lonely issue" });
    const { html } = await get();
    expect(html).toContain("lonely issue");
    expect(html).not.toContain("Say faster ten times.");
    expect(html).not.toContain('class="lesson"');
  });

  test("drops null and partial lesson items and keeps the good one", async () => {
    const good = { kind: "word", pattern: "p", said: "s1", better: "b1", practice: "practice me" };
    db.run("INSERT INTO lessons (day, json) VALUES (?, ?)", [TODAY, JSON.stringify({ items: [null, { kind: "x" }, good] })]);
    const { status, html } = await get();
    expect(status).toBe(200);
    expect(html).toContain("practice me");
  });

  test("bad lesson JSON gives an empty lesson card, not an error", async () => {
    db.run("INSERT INTO lessons (day, json) VALUES (?, ?)", [TODAY, "{bad"]);
    const { status, html } = await get();
    expect(status).toBe(200);
    expect(html).toContain('class="lesson"');
  });

  test("a day with no data shows an empty state, not an error", async () => {
    const { status, html } = await get(`?day=${PAST}`);
    expect(status).toBe(200);
    expect(html).toContain('class="empty"');
    expect(html).toContain("Nothing analysed for this day yet. The nightly run starts at 9 pm.");
    expect(html).not.toContain('class="stats"');
    expect(html).not.toContain("data-filters");
  });

  test("has a GET date picker form named day", async () => {
    const { html } = await get();
    expect(html).toMatch(/<form[^>]*method="get"/i);
    expect(html).toMatch(/<input[^>]*type="date"/);
    expect(html).toMatch(/<input[^>]*name="day"/);
  });

  test("only words of done dictations count; a pending one is ignored", async () => {
    addDictation("d1", TODAY);
    db.run(
      `INSERT INTO dictations (id, ts, day, words, text_status, audio_status)
       VALUES ('d9', '2026-11-19 10:00:00.000 +00:00', ?, 999, 'pending', 'pending')`,
      [TODAY],
    );
    addIssue("d1", TODAY);
    const { html } = await get();
    expect(html).not.toContain("999");
  });
});

describe("todayPage layout", () => {
  test("shows the day as a large numeral beside the weekday and month", async () => {
    expect(dayNumber("2026-11-09")).toBe(9);
    expect(weekdayMonth("2026-11-19")).toBe("Thursday, November");
    const { html } = await get();
    expect(html).toContain('<h1><span class="daynum">19</span> <span class="dayname">Thursday, November</span></h1>');
  });

  test("links to the previous day, and to the next day only before today", async () => {
    const onToday = (await get()).html;
    expect(onToday).toContain('<a href="/?day=2026-11-18">Previous day</a>');
    expect(onToday).not.toContain("Next day");
    const past = (await get(`?day=${PAST}`)).html;
    expect(past).toContain('<a href="/?day=2026-11-14">Previous day</a>');
    expect(past).toContain('<a href="/?day=2026-11-16">Next day</a>');
    expect(past).toContain('<button type="submit" class="text">Go</button>');
  });

  test("states the words spoken and the issue count in one sentence", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY);
    addIssue("d1", TODAY);
    const { html } = await get();
    expect(html).toContain('<p class="stats">50 words spoken, <b>2 to improve</b>.</p>');
  });

  test("statsSentence groups thousands and uses singular for one", () => {
    expect(statsSentence(1453, 53)).toBe("1,453 words spoken, <b>53 to improve</b>.");
    expect(statsSentence(1, 1)).toBe("1 word spoken, <b>1 to improve</b>.");
  });

  test("groups issues in the order Grammar, Word choice, Fillers, Sounds ", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY, { kind: "sound", said: "s1" });
    addIssue("d1", TODAY, { kind: "filler", said: "f1" });
    addIssue("d1", TODAY, { kind: "filler", said: "f2" });
    addIssue("d1", TODAY, { kind: "grammar", said: "g1" });
    addIssue("d1", TODAY, { kind: "word", said: "w1" });
    const { html } = await get();
    const heads = [...html.matchAll(/<h3>([A-Za-z ]+)<\/h3>/g)].map((m) => m[1]);
    expect(heads).toEqual(["Grammar", "Word choice", "Fillers", "Sounds"]);
    expect(ISSUE_GROUPS.map(([k]) => k)).toEqual(["grammar", "word", "filler", "sound"]);
    expect(html.indexOf("g1")).toBeLessThan(html.indexOf("w1"));
    expect(html.indexOf("w1")).toBeLessThan(html.indexOf("f1"));
    expect(html.indexOf("f2")).toBeLessThan(html.indexOf("s1"));
  });

  test("skips a group that has no issues", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY, { kind: "grammar" });
    const { html } = await get();
    expect(html).toContain('data-kind="grammar"');
    expect(html).not.toContain('data-kind="filler"');
  });

  test("shows filter buttons for All and each group with plain counts, hidden until the script runs", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY, { kind: "grammar" });
    addIssue("d1", TODAY, { kind: "filler" });
    const { html } = await get();
    expect(html).toMatch(/<p class="filters" data-filters hidden>/);
    const labels = [
      ...html.matchAll(/<button type="button" class="filter" data-filter="([a-z]+)" aria-pressed="(\w+)">([A-Za-z ]+) <span class="n">(\d+)<\/span><\/button>/g),
    ].map((m) => `${m[1]}:${m[3]} ${m[4]}:${m[2]}`);
    expect(labels).toEqual([
      "all:All 2:true",
      "grammar:Grammar 1:false",
      "word:Word choice 0:false",
      "filler:Fillers 1:false",
      "sound:Sounds 0:false",
    ]);
    expect(html).toContain("<script>");
  });

  test("renders each issue as a correction mark followed by its reason", async () => {
    addDictation("d1", TODAY, "2026-10-01 10:00:00.000 +00:00");
    addIssue("d1", TODAY);
    const { html } = await get();
    expect(html).toContain(
      '<li class="mark"><p class="line"><span class="fix k-grammar" data-b="faster"><del class="said" style="--i:0">more fast</del> <ins class="better">faster</ins></span></p><p class="note"><span class="ring ring-gr" aria-hidden="true">gr</span><span class="reason">comparative form</span></p>',
    );
  });

  test("each issue and lesson item takes the mark of its kind and a circled code in the margin note", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY, { kind: "filler", said: "like check", better: "check" });
    addIssue("d1", TODAY, { kind: "word", said: "w1", better: "w2" });
    addLesson(TODAY);
    const { html } = await get();
    expect(html).toContain('<span class="fix k-filler" data-b="check"><del class="said cut" style="--i:3">like</del> check');
    expect(html).toContain('<span class="fix k-word" data-b="w2">');
    expect(html).toContain('<p class="note"><span class="ring ring-fl" aria-hidden="true">fl</span><span class="reason">');
    expect(html).toContain('<p class="note"><span class="ring ring-gr" aria-hidden="true">gr</span><span class="kind vh">Grammar</span></p><p class="practice">Say faster ten times.</p>');
  });

  test("shows each mistake inside the sentence the dictation text gives, escaped, and alone when the text lacks it", async () => {
    addDictation("d1", TODAY, "2026-11-15 10:00:00.000 +00:00", "so <b>I</b> think more fast would help us here today");
    addDictation("d2", TODAY, "2026-11-15 10:00:00.000 +00:00", "nothing relevant");
    addIssue("d1", TODAY);
    addIssue("d2", TODAY, { said: "other", better: "else" });
    const { html } = await get();
    expect(html).toContain('<p class="line">so &lt;b&gt;I&lt;/b&gt; think <span class="fix k-grammar" data-b="faster">');
    expect(html).toContain('</span> would help us here &hellip;</p>');
    expect(html).toContain('<p class="line"><span class="fix k-grammar" data-b="else">');
  });

  test("renders the 5 new words with meaning, example and what the person said", async () => {
    addWords(TODAY);
    const { html } = await get();
    expect(html.match(/class="entry"/g)?.length).toBe(5);
    expect(html).toMatch(/<strong class="word">alpha<\/strong><\/p><p class="meaning">meaning of alpha<\/p><p class="example">example of alpha<\/p>/);
    expect(html).toContain("Words for today");
    expect(html).toContain('<p class="example">example of alpha</p>');
    expect(html).toContain('<p class="hw"><span class="caret" aria-hidden="true"></span><strong class="word">alpha</strong>');
    expect(html).toContain("<em>sentence with alpha</em>");
  });

  test("a day with words but no speech shows the empty sentence and the words, with no stats", async () => {
    addWords(TODAY);
    const { html } = await get();
    expect(html).toContain("Nothing analysed for this day yet.");
    expect(html).not.toContain("You spoke");
    expect(html).toContain('<strong class="word">alpha</strong>');
  });

  test("a day with done dictations and no issues still shows the stats sentence", async () => {
    addDictation("d1", TODAY);
    const { html } = await get();
    expect(html).toContain('<p class="stats">50 words spoken, <b>0 to improve</b>.</p>');
    expect(html).not.toContain("Nothing analysed");
  });

  test("an unknown issue kind never throws and is not shown as a group", async () => {
    addDictation("d1", TODAY);
    addLesson(TODAY);
    db.run("UPDATE lessons SET json = ? WHERE day = ?", [
      JSON.stringify({ items: [{ kind: "constructor", said: "a", better: "b", practice: "p" }] }),
      TODAY,
    ]);
    const { status, html } = await get();
    expect(status).toBe(200);
    expect(html).toContain('<li class="mark"><p class="line"><span class="fix" data-b="b"><del class="said" style="--i:0">a</del> <ins class="better">b</ins></span></p><p class="note"><span class="kind vh">constructor</span></p>');
  });

  test("puts You said and the person's sentence on their own grey line", async () => {
    addWords(TODAY);
    const { html } = await get();
    expect(html).toContain('<p class="you-said">You said: <em>sentence with alpha</em></p>');
  });
});

describe("median", () => {
  test("takes the middle of an odd list and the mean of the middle two of an even list", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });
});

describe("moodOf", () => {
  const hist = (issues: number[], words = 100) => issues.map((n) => ({ words, issues: n }));
  const FIVE = hist([4, 4, 4, 4, 4]);

  test("good at or below 0.75 of the baseline, busy at or above 1.25, even between", () => {
    expect(moodOf({ words: 100, issues: 3 }, FIVE)).toBe("good");
    expect(moodOf({ words: 100, issues: 2 }, FIVE)).toBe("good");
    expect(moodOf({ words: 100, issues: 5 }, FIVE)).toBe("busy");
    expect(moodOf({ words: 100, issues: 9 }, FIVE)).toBe("busy");
    expect(moodOf({ words: 100, issues: 4 }, FIVE)).toBe("even");
    expect(moodOf({ words: 100, issues: 3.5 }, FIVE)).toBe("even");
  });

  test("scores per 100 words, so a longer day is not busier by volume alone", () => {
    expect(moodOf({ words: 1000, issues: 40 }, FIVE)).toBe("even");
    expect(moodOf({ words: 50, issues: 3 }, FIVE)).toBe("busy");
  });

  test("uses the median, so one wild day does not move the baseline", () => {
    expect(moodOf({ words: 100, issues: 4 }, hist([4, 4, 4, 4, 90]))).toBe("even");
  });

  test("no mood for a day under 50 words, and 50 words is enough", () => {
    expect(moodOf({ words: 49, issues: 0 }, FIVE)).toBeNull();
    expect(moodOf({ words: 50, issues: 0 }, FIVE)).toBe("good");
  });

  test("no mood with fewer than 5 baseline days; days under 50 words do not count", () => {
    expect(moodOf({ words: 100, issues: 0 }, hist([4, 4, 4, 4]))).toBeNull();
    expect(moodOf({ words: 100, issues: 0 }, [...hist([4, 4, 4, 4]), { words: 49, issues: 4 }])).toBeNull();
    expect(moodOf({ words: 100, issues: 0 }, [...hist([4, 4, 4, 4]), { words: 50, issues: 2 }])).toBe("good");
    expect(moodOf({ words: 100, issues: 0 }, [])).toBeNull();
  });

  test("a baseline of zero issues makes any issue busy and none even", () => {
    expect(moodOf({ words: 100, issues: 0 }, hist([0, 0, 0, 0, 0]))).toBe("even");
    expect(moodOf({ words: 100, issues: 1 }, hist([0, 0, 0, 0, 0]))).toBe("busy");
  });
});

describe("issue filter script", () => {
  test("pauses audio inside the sections it hides", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY);
    const { html } = await get();
    expect(html).toMatch(/s\.hidden=[^;]*;if\(s\.hidden\)s\.querySelectorAll\("audio"\)\.forEach\(\(a\)=>a\.pause\(\)\)/);
  });
});

describe("todayPage mood and pen strike", () => {
  const seedHistory = (perDayIssues: number) => {
    for (let i = 1; i <= 5; i++) {
      const day = `2026-11-${String(19 - i).padStart(2, "0")}`;
      addDictation(`h${i}`, day);
      db.run("UPDATE dictations SET words = 100 WHERE id = ?", [`h${i}`]);
      for (let k = 0; k < perDayIssues; k++) addIssue(`h${i}`, day);
    }
  };
  const seedToday = (issues: number) => {
    addDictation("t1", TODAY);
    db.run("UPDATE dictations SET words = 100 WHERE id = 't1'");
    for (let k = 0; k < issues; k++) addIssue("t1", TODAY);
  };

  test("a calmer day sets data-mood=good and says so", async () => {
    seedHistory(4);
    seedToday(2);
    const { html } = await get();
    expect(html).toContain('<html lang="en" data-mood="good"');
    expect(html).toContain('<p class="stats">A calmer day than usual.</p>');
  });

  test("a busier day sets busy; a usual day sets even", async () => {
    seedHistory(4);
    seedToday(6);
    expect((await get()).html).toContain('data-mood="busy"');
    expect((await get()).html).toContain("A busier day than usual.");
    db.run("DELETE FROM issues WHERE dictation_id = 't1'");
    for (let k = 0; k < 4; k++) addIssue("t1", TODAY);
    const even = (await get()).html;
    expect(even).toContain('data-mood="even"');
    expect(even).toContain("About your usual day.");
  });

  const seedDay = (id: string, day: string, issues: number, over: { status?: string; words?: number; kind?: string } = {}) => {
    addDictation(id, day);
    db.run("UPDATE dictations SET words = ?, text_status = ? WHERE id = ?", [over.words ?? 100, over.status ?? "done", id]);
    for (let k = 0; k < issues; k++) addIssue(id, day, { kind: over.kind });
  };

  test("no attribute and no line without a baseline", async () => {
    seedToday(2);
    const { html } = await get();
    expect(html).not.toContain("data-mood=");
    expect(html).not.toContain("than usual");
  });

  test("four earlier days plus the shown day are not a baseline of five", async () => {
    for (const d of ["10", "11", "12", "13"]) seedDay(`e${d}`, `2026-11-${d}`, 4);
    seedDay("shown", TODAY, 0);
    expect((await get()).html).not.toContain("data-mood=");
    seedDay("e14", "2026-11-14", 4);
    expect((await get()).html).toContain('data-mood="good"');
  });

  test("a sound issue on a dictation whose text is not done changes neither the mood, the baseline nor the count", async () => {
    seedHistory(4);
    seedToday(4);
    for (let i = 1; i <= 5; i++) {
      for (const status of ["failed", "skipped"]) {
        const id = `x${i}${status}`;
        seedDay(id, `2026-11-${String(19 - i).padStart(2, "0")}`, 20, { status, kind: "sound" });
      }
    }
    seedDay("xt", TODAY, 30, { status: "failed", kind: "sound" });
    const { html } = await get();
    expect(html).toContain('data-mood="even"');
    expect(html).toContain('<p class="stats">100 words spoken, <b>4 to improve</b>.</p>');
  });

  test("only the 30 days before the shown day make the baseline", async () => {
    seedHistory(4);
    db.run("UPDATE dictations SET day = '2026-10-01' WHERE id IN ('h1','h2')");
    db.run("UPDATE issues SET day = '2026-10-01' WHERE dictation_id IN ('h1','h2')");
    seedToday(2);
    expect((await get()).html).not.toContain("data-mood=");
  });

  test("a past day is judged by the 30 days before it, not by later days", async () => {
    for (const d of ["12", "13", "14", "15", "16"]) seedDay(`b${d}`, `2026-11-${d}`, 4);
    seedDay("past", "2026-11-17", 4);
    for (const d of ["18", "19", "20", "21", "22", "23"]) seedDay(`a${d}`, `2026-11-${d}`, 0);
    const { html } = await get("?day=2026-11-17");
    expect(html).toContain('data-mood="even"');
  });

  test("marks the page for the pen strike and numbers each struck phrase for the stagger", async () => {
    addDictation("d1", TODAY);
    addIssue("d1", TODAY, { said: "g1" });
    addIssue("d1", TODAY, { said: "g2" });
    addLesson(TODAY);
    const { html } = await get();
    expect(html).toContain('data-page="today"');
    const marks = [...html.matchAll(/<del class="said" style="--i:(\d+)">/g)].map((m) => Number(m[1]));
    expect(marks).toEqual([0, 1, 2, 3]);
  });
});
