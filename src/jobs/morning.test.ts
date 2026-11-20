import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORDS_MAX_TOKENS } from "../clients/claude";
import { openCoachDb } from "../db/coach";
import { setSkipList } from "../db/settings";
import { createLogger } from "../log";
import { ok } from "../result";
import { createFakeClaude } from "../testing/fake-claude";
import { createFakeGemini } from "../testing/fake-gemini";
import { createWisprFixture } from "../testing/wispr-fixture";
import { WORDS_SCHEMA, runMorning } from "./morning";

const CLAUDE = "claude-opus-5-5";
const GEMINI = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
const TODAY = "2026-11-19";
const YESTERDAY = "2026-11-18";
const MORNING = Date.UTC(2026, 10, 19, 4, 0, 0); // 09:30 local at offset -330
const offsetOf = () => -330;

let dir: string;
let coach: Database;
let wisprDb: Database;
let wisprPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "morning-test-"));
  const opened = openCoachDb(path.join(dir, "coach.sqlite"));
  if (!opened.ok) throw new Error(opened.error);
  coach = opened.value;
  const fixture = createWisprFixture(dir, [{}]);
  wisprDb = fixture.db;
  wisprPath = fixture.path;
});

afterEach(() => {
  coach.close();
  wisprDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let nextId = 0;
const addDictation = (day: string, text: string | null) =>
  coach
    .query(
      "INSERT INTO dictations (id, ts, day, asr_text, words, text_status, audio_status) VALUES (?, ?, ?, ?, 5, 'done', 'done')",
    )
    .run(`d${nextId++}`, `${day} 10:00:00.000 +00:00`, day, text);

const addWord = (day: string, word: string) =>
  coach
    .query("INSERT INTO daily_words (day, word, meaning, example, from_sentence) VALUES (?, ?, 'm', 'e', 's')")
    .run(day, word);

const entry = (word: string) => ({
  word,
  meaning: `meaning of ${word}`,
  example: `example with ${word}`,
  from_sentence: `sentence about ${word}`,
});
const reply = (...words: string[]) => ({ words: words.map(entry) });
const FIVE = ["alpha", "beta", "gamma", "delta", "epsilon"];

const wordsOn = (day: string) =>
  (coach.query("SELECT word FROM daily_words WHERE day = ? ORDER BY word").all(day) as { word: string }[]).map(
    (r) => r.word,
  );

const runRows = () =>
  coach.query("SELECT status FROM runs WHERE kind = 'morning' ORDER BY id").all() as { status: string }[];

const setup = (handler: () => unknown = () => reply(...FIVE)) => {
  const claude = createFakeClaude({ handler, modelIds: [CLAUDE] });
  const gemini = createFakeGemini({ handler: () => ok([]), modelIds: GEMINI });
  const lines: string[] = [];
  const notices: { title: string; message: string }[] = [];
  const lockPath = path.join(dir, "morning.lock");
  const run = (at: number = MORNING) =>
    runMorning({
      coach,
      wisprPath,
      claude,
      gemini,
      log: createLogger((l) => {
        lines.push(l);
      }),
      now: () => new Date(at),
      offsetOf,
      pid: process.pid,
      lockPath,
      notify: (title, message) => {
        notices.push({ title, message });
      },
      claudeModel: CLAUDE,
      geminiModels: GEMINI,
      compileOptions: () => ["ENABLE_FTS5"],
    });
  return { claude, notices, lockPath, lines, run };
};

describe("WORDS_SCHEMA", () => {
  test("forbids extra properties on the root and on each word", () => {
    const schema = WORDS_SCHEMA as {
      additionalProperties: unknown;
      properties: { words: { items: { additionalProperties: unknown; required: string[] } } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.words.items.additionalProperties).toBe(false);
    expect(schema.properties.words.items.required.sort()).toEqual(
      ["example", "from_sentence", "meaning", "word"],
    );
  });
});

describe("runMorning", () => {
  test("with recent dictations: one Claude call, 5 rows for today and one notification", async () => {
    addDictation(TODAY, "I want to make this thing less bad");
    const { claude, notices, run } = setup();
    const result = await run();
    expect(result.status).toBe("ok");
    expect(claude.calls).toHaveLength(1);
    expect(wordsOn(TODAY)).toEqual([...FIVE].sort());
    expect(notices).toEqual([{ title: "Speech Coach", message: "5 new words: alpha, beta, gamma, delta, epsilon" }]);
    expect(runRows()).toEqual([{ status: "ok" }]);
  });

  test("the request carries the schema, the last 7 days of text and every past word", async () => {
    addDictation(TODAY, "recent text today");
    addDictation("2026-11-13", "edge text six days back");
    addDictation("2026-11-12", "too old text");
    addDictation(TODAY, null);
    addWord(YESTERDAY, "mitigate");
    addWord("2026-10-01", "ameliorate");
    const { claude, run } = setup();
    await run();
    expect(claude.calls).toHaveLength(1);
    const req = claude.calls[0]!;
    expect(req.schema).toBe(WORDS_SCHEMA);
    expect(req.maxTokens).toBe(WORDS_MAX_TOKENS);
    expect(req.user).toContain("recent text today");
    expect(req.user).toContain("edge text six days back");
    expect(req.user).not.toContain("too old text");
    expect(req.user).toContain("mitigate");
    expect(req.user).toContain("ameliorate");
  });

  test("a pending row from an app added to the skip list is not sent and loses its text", async () => {
    addDictation(TODAY, "ordinary work text");
    const insert = coach.query(
      "INSERT INTO dictations (id, ts, day, app, asr_text, words, text_status, audio_status) VALUES (?, ?, ?, 'com.example.Bank', ?, 5, ?, ?)",
    );
    insert.run("bank-pending", `${TODAY} 11:00:00.000 +00:00`, TODAY, "pendingsecret from the bank", "pending", "pending");
    insert.run("bank-done", `${TODAY} 11:00:01.000 +00:00`, TODAY, "donesecret from the bank", "done", "done");
    setSkipList(coach, ["com.example.Bank"]);
    const { claude, run } = setup();
    await run();
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]!.user).toContain("ordinary work text");
    expect(claude.calls[0]!.user).not.toContain("pendingsecret");
    expect(claude.calls[0]!.user).not.toContain("donesecret");
    expect(
      coach.query("SELECT id, text_status, asr_text FROM dictations WHERE app = 'com.example.Bank' ORDER BY id").all(),
    ).toEqual([
      { id: "bank-done", text_status: "done", asr_text: "donesecret from the bank" },
      { id: "bank-pending", text_status: "skipped", asr_text: null },
    ]);
  });

  test("no dictations in the last 7 days: 0 calls, no notification, run ok", async () => {
    addDictation("2026-11-12", "too old text");
    const { claude, notices, run } = setup();
    const result = await run();
    expect(result.status).toBe("ok");
    expect(claude.calls).toHaveLength(0);
    expect(notices).toHaveLength(0);
    expect(wordsOn(TODAY)).toEqual([]);
    expect(runRows()).toEqual([{ status: "ok" }]);
  });

  test("drops past words case-insensitively and duplicates, keeps the first 5", async () => {
    addDictation(TODAY, "some text");
    addWord(YESTERDAY, "mitigate");
    const { notices, run } = setup(() =>
      reply("Mitigate", "alpha", "ALPHA", "beta", "gamma", "delta", "epsilon", "zeta"),
    );
    await run();
    expect(wordsOn(TODAY)).toEqual([...FIVE].sort());
    expect(notices.map((n) => n.message)).toEqual(["5 new words: alpha, beta, gamma, delta, epsilon"]);
  });

  test("a reply with no valid word fails the run and keeps yesterday's rows", async () => {
    addDictation(TODAY, "some text");
    addWord(YESTERDAY, "mitigate");
    const { claude, notices, run } = setup(() => reply("mitigate", "MITIGATE"));
    const result = await run();
    expect(result.status).toBe("failed");
    expect(claude.calls).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).not.toContain("5 new words");
    expect(wordsOn(YESTERDAY)).toEqual(["mitigate"]);
    expect(wordsOn(TODAY)).toEqual([]);
  });

  test("a Claude error keeps yesterday's rows, saves nothing for today and ends failed", async () => {
    addDictation(TODAY, "some text");
    for (const w of FIVE) addWord(YESTERDAY, w);
    const { claude, run } = setup(() => {
      throw new Error("boom");
    });
    const result = await run();
    expect(result.status).toBe("failed");
    expect(claude.calls).toHaveLength(1);
    expect(wordsOn(YESTERDAY)).toEqual([...FIVE].sort());
    expect(wordsOn(TODAY)).toEqual([]);
    expect(runRows()).toEqual([{ status: "failed" }]);
  });

  test("notifies once for the first failure of a streak and not for the second", async () => {
    addDictation(TODAY, "some text");
    const { notices, run } = setup(() => {
      throw new Error("boom");
    });
    await run(MORNING);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe("Speech Coach");
    await run(MORNING + 60_000);
    expect(runRows()).toEqual([{ status: "failed" }, { status: "failed" }]);
    expect(notices).toHaveLength(1);
  });

  test("a second run the same morning is skipped with 0 more calls", async () => {
    addDictation(TODAY, "some text");
    const { claude, notices, run } = setup();
    await run(MORNING);
    const second = await run(MORNING + 60_000);
    expect(second.status).toBe("skipped");
    expect(runRows()).toEqual([{ status: "ok" }]);
    expect(claude.calls).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(wordsOn(TODAY)).toHaveLength(5);
  });

  test("a held lock skips the run with 0 calls", async () => {
    addDictation(TODAY, "some text");
    const { claude, lockPath, notices, run } = setup();
    fs.writeFileSync(lockPath, String(process.ppid));
    const result = await run();
    expect(result.status).toBe("skipped");
    expect(claude.calls).toHaveLength(0);
    expect(notices).toHaveLength(0);
    expect(runRows()).toEqual([]);
  });

  test("a stale lock is not taken over while another connection holds the coach write lock", async () => {
    addDictation(TODAY, "some text");
    const { claude, lockPath, run } = setup();
    fs.writeFileSync(lockPath, "999999");
    const other = new Database(path.join(dir, "coach.sqlite"));
    try {
      coach.exec("PRAGMA busy_timeout = 0");
      other.exec("BEGIN IMMEDIATE");
      expect(await run()).toEqual({ status: "skipped", detail: { reason: "locked" } });
      expect(fs.readFileSync(lockPath, "utf8")).toBe("999999");
      other.exec("COMMIT");
      expect((await run()).status).toBe("ok");
      expect(claude.calls).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  test("a Claude error is logged with its kind and without dictation text", async () => {
    addDictation(TODAY, "secret dictation words");
    const { lines, run } = setup(() => {
      throw new Error("boom");
    });
    await run();
    const output = lines.join("\n");
    expect(output).toContain("api");
    expect(output).not.toContain("secret dictation words");
  });

  test("releases the lock after a successful run", async () => {
    addDictation(TODAY, "some text");
    const { lockPath, run } = setup();
    await run();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("releases the lock after a failed run", async () => {
    addDictation(TODAY, "some text");
    const { lockPath, run } = setup(() => {
      throw new Error("boom");
    });
    await run();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
