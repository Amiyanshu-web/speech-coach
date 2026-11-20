import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoachDb } from "../db/coach";
import { DEFAULT_SKIP_LIST } from "../db/settings";
import { createLogger } from "../log";
import { createWisprFixture, wisprTimestamp } from "../testing/wispr-fixture";
import { applySkipList, classifyRow, importNew } from "./import";
import type { WisprRow } from "../wispr/source";

let dir: string;
const open: Database[] = [];
const logLines: string[] = [];
const log = createLogger((line) => logLines.push(line));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "import-"));
  logLines.length = 0;
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const GOOD = "this is a good sentence";
const AUDIO = new Uint8Array([1, 2, 3]);

const setup = (rows: Parameters<typeof createWisprFixture>[1]) => {
  const wispr = createWisprFixture(dir, rows).db;
  const coachResult = openCoachDb(join(dir, "coach.sqlite"));
  if (!coachResult.ok) throw new Error(coachResult.error);
  open.push(wispr, coachResult.value);
  return { wispr, coach: coachResult.value };
};

const row = (over: Partial<WisprRow> = {}): WisprRow => ({
  id: "r1",
  timestamp: wisprTimestamp(Date.UTC(2026, 10, 19, 12, 0, 0)),
  app: "com.apple.Terminal",
  duration: 3,
  asrText: GOOD,
  formattedText: "This is a good sentence.",
  status: "formatted",
  timezoneOffsetMinutes: -330,
  needsUploading: 0,
  hasAudio: true,
  ...over,
});

type Stored = {
  id: string;
  day: string;
  text_status: string;
  audio_status: string;
  asr_text: string | null;
  formatted_text: string | null;
};

const stored = (coach: Database, id: string): Stored =>
  coach
    .query("SELECT id, day, text_status, audio_status, asr_text, formatted_text FROM dictations WHERE id = ?")
    .get(id) as Stored;

const ftsHits = (coach: Database, word: string): number =>
  (coach.query("SELECT count(*) AS n FROM dictations_fts WHERE dictations_fts MATCH ?").get(word) as { n: number }).n;

const insertDictation = (coach: Database, id: string, app: string, text: string, textStatus: string, audioStatus = textStatus) =>
  coach
    .query(
      `INSERT INTO dictations (id, ts, day, app, asr_text, formatted_text, words, text_status, audio_status)
       VALUES (?, '2026-11-19 12:00:00.000 +00:00', '2026-11-19', ?, ?, ?, 4, ?, ?)`,
    )
    .run(id, app, text, text, textStatus, audioStatus);

describe("classifyRow", () => {
  test.each(["dismissed", "error", "empty", null, "", "something-new"])(
    "Wispr status %p is skipped for both",
    (status) => {
      expect(classifyRow(row({ status }), [])).toMatchObject({ text: "skipped", audio: "skipped" });
    },
  );

  test.each(["formatted", "raw_transcript"])("Wispr status %p is analysed", (status) => {
    expect(classifyRow(row({ status }), [])).toEqual({ text: "pending", audio: "pending", storeText: true });
  });

  test("null asrText is skipped for both", () => {
    expect(classifyRow(row({ asrText: null }), [])).toMatchObject({ text: "skipped", audio: "skipped" });
  });

  test("a 2-word text is skipped for both", () => {
    expect(classifyRow(row({ asrText: "just two" }), [])).toMatchObject({ text: "skipped", audio: "skipped" });
  });

  test("a whitespace-padded 2-word text is skipped for both", () => {
    expect(classifyRow(row({ asrText: "  two   words " }), [])).toMatchObject({ text: "skipped", audio: "skipped" });
  });

  test("a 3-word text is analysed", () => {
    expect(classifyRow(row({ asrText: "just three words" }), [])).toMatchObject({ text: "pending" });
  });

  test("null audio with good text is pending text and skipped audio", () => {
    expect(classifyRow(row({ hasAudio: false }), [])).toEqual({ text: "pending", audio: "skipped", storeText: true });
  });

  test("a skip-list app is skipped for both and its text is not stored", () => {
    expect(classifyRow(row({ app: "com.1password.1password" }), [...DEFAULT_SKIP_LIST])).toEqual({
      text: "skipped",
      audio: "skipped",
      storeText: false,
    });
  });

  test("a null app is not in the skip list", () => {
    expect(classifyRow(row({ app: null }), [...DEFAULT_SKIP_LIST])).toEqual({
      text: "pending",
      audio: "pending",
      storeText: true,
    });
  });

  test("a row skipped for another reason keeps storeText true", () => {
    expect(classifyRow(row({ status: "error" }), []).storeText).toBe(true);
  });
});

describe("importNew", () => {
  test("each default skip-list app is imported skipped with no text and not searchable", () => {
    const rows = DEFAULT_SKIP_LIST.map((app, i) => ({
      transcriptEntityId: `skip-${i}`,
      app,
      asrText: `secretword${i} spoken here today`,
      formattedText: `Secretword${i} spoken here today.`,
      audio: AUDIO,
    }));
    const { wispr, coach } = setup(rows);
    const result = importNew({ wispr, coach, skipList: [...DEFAULT_SKIP_LIST], log });
    expect(result).toEqual({ ok: true, value: { imported: 6, skipped: 6 } });
    DEFAULT_SKIP_LIST.forEach((_, i) => {
      expect(stored(coach, `skip-${i}`)).toMatchObject({
        text_status: "skipped",
        audio_status: "skipped",
        asr_text: null,
        formatted_text: null,
      });
      expect(ftsHits(coach, `secretword${i}`)).toBe(0);
    });
    expect(coach.query("SELECT DISTINCT words FROM dictations").all()).toEqual([{ words: 0 }]);
  });

  test("a normal row is stored pending with its text searchable", () => {
    const { wispr, coach } = setup([
      { transcriptEntityId: "ok-1", asrText: "pineapple on the pizza", formattedText: "Pineapple on the pizza.", audio: AUDIO },
    ]);
    expect(importNew({ wispr, coach, skipList: [], log })).toEqual({ ok: true, value: { imported: 1, skipped: 0 } });
    expect(stored(coach, "ok-1")).toMatchObject({
      text_status: "pending",
      audio_status: "pending",
      asr_text: "pineapple on the pizza",
      formatted_text: "Pineapple on the pizza.",
    });
    expect(ftsHits(coach, "pineapple")).toBe(1);
  });

  test("a row skipped for a non-skip-list reason keeps its text", () => {
    const { wispr, coach } = setup([
      { transcriptEntityId: "short-1", asrText: "two words", formattedText: "Two words.", audio: AUDIO },
    ]);
    importNew({ wispr, coach, skipList: [], log });
    expect(stored(coach, "short-1")).toMatchObject({
      text_status: "skipped",
      audio_status: "skipped",
      asr_text: "two words",
      formatted_text: "Two words.",
    });
  });

  test("day comes from the row offset", () => {
    const { wispr, coach } = setup([
      {
        transcriptEntityId: "tz-1",
        timestamp: "2026-11-19 20:00:00.000 +00:00",
        timezoneOffsetMinutes: -330,
        asrText: GOOD,
        audio: AUDIO,
      },
    ]);
    importNew({ wispr, coach, skipList: [], log });
    expect(stored(coach, "tz-1").day).toBe("2026-11-20");
  });

  test("null audio with good text is pending text and skipped audio", () => {
    const { wispr, coach } = setup([{ transcriptEntityId: "na-1", asrText: GOOD, audio: null }]);
    importNew({ wispr, coach, skipList: [], log });
    expect(stored(coach, "na-1")).toMatchObject({ text_status: "pending", audio_status: "skipped" });
  });

  test("a late-synced older row is imported by id, and a third call imports 0", () => {
    const { wispr, coach } = setup([
      { transcriptEntityId: "a", asrText: GOOD, audio: AUDIO },
      { transcriptEntityId: "b", asrText: GOOD, audio: AUDIO },
    ]);
    expect(importNew({ wispr, coach, skipList: [], log })).toEqual({ ok: true, value: { imported: 2, skipped: 0 } });
    wispr
      .query(
        `INSERT INTO History (transcriptEntityId, timestamp, app, asrText, formattedText, needsUploading, status, timezoneOffsetMinutes)
         VALUES ('late', '2020-01-01 00:00:00.000 +00:00', 'com.apple.Terminal', ?, ?, 0, 'formatted', 0)`,
      )
      .run(GOOD, GOOD);
    expect(importNew({ wispr, coach, skipList: [], log })).toEqual({ ok: true, value: { imported: 1, skipped: 0 } });
    expect(stored(coach, "late").day).toBe("2020-01-01");
    expect(importNew({ wispr, coach, skipList: [], log })).toEqual({ ok: true, value: { imported: 0, skipped: 0 } });
  });

  test("a row with an unparseable timestamp is logged by id, not imported, and retried", () => {
    const { wispr, coach } = setup([
      { transcriptEntityId: "bad-ts", timestamp: "not a time", asrText: GOOD, audio: AUDIO },
      { transcriptEntityId: "good-ts", asrText: GOOD, audio: AUDIO },
    ]);
    expect(importNew({ wispr, coach, skipList: [], log })).toEqual({ ok: true, value: { imported: 1, skipped: 0 } });
    expect(stored(coach, "bad-ts")).toBeNull();
    expect(logLines.some((l) => l.includes("bad-ts"))).toBe(true);
    expect(logLines.some((l) => l.includes(GOOD))).toBe(false);
    wispr.query("UPDATE History SET timestamp = ? WHERE transcriptEntityId = 'bad-ts'").run(wisprTimestamp(Date.UTC(2026, 10, 19, 9, 0, 0)));
    expect(importNew({ wispr, coach, skipList: [], log })).toEqual({ ok: true, value: { imported: 1, skipped: 0 } });
    expect(stored(coach, "bad-ts")).not.toBeNull();
  });
});

describe("applySkipList", () => {
  test("turns pending and failed rows skipped and deletes their text, leaves done unchanged", () => {
    const { coach } = setup([]);
    insertDictation(coach, "p", "com.example.Bank", "alphaword spoken here today", "pending");
    insertDictation(coach, "f", "com.example.Bank", "bravoword spoken here today", "failed", "failed");
    insertDictation(coach, "d", "com.example.Bank", "charlieword spoken here today", "done");
    insertDictation(coach, "o", "com.example.Other", "deltaword spoken here today", "pending");

    expect(applySkipList({ coach, skipList: ["com.example.Bank"] })).toBe(2);

    for (const id of ["p", "f"]) {
      expect(stored(coach, id)).toMatchObject({
        text_status: "skipped",
        audio_status: "skipped",
        asr_text: null,
        formatted_text: null,
      });
    }
    expect(ftsHits(coach, "alphaword")).toBe(0);
    expect(ftsHits(coach, "bravoword")).toBe(0);
    expect(stored(coach, "d")).toMatchObject({
      text_status: "done",
      audio_status: "done",
      asr_text: "charlieword spoken here today",
      formatted_text: "charlieword spoken here today",
    });
    expect(ftsHits(coach, "charlieword")).toBe(1);
    expect(stored(coach, "o")).toMatchObject({ text_status: "pending", asr_text: "deltaword spoken here today" });
    expect(ftsHits(coach, "deltaword")).toBe(1);
  });

  test.each(["pending", "failed"])(
    "a text-done row with %s audio in a listed app has its audio skipped and keeps its text",
    (audioStatus) => {
      const { coach } = setup([]);
      insertDictation(coach, "d", "com.example.Bank", "charlieword spoken here today", "done", audioStatus);
      insertDictation(coach, "o", "com.example.Other", "deltaword spoken here today", "done", audioStatus);

      applySkipList({ coach, skipList: ["com.example.Bank"] });

      expect(stored(coach, "d")).toMatchObject({
        text_status: "done",
        audio_status: "skipped",
        asr_text: "charlieword spoken here today",
      });
      expect(stored(coach, "o").audio_status).toBe(audioStatus);
    },
  );

  test("returns 0 for an empty skip list", () => {
    const { coach } = setup([]);
    insertDictation(coach, "p", "com.example.Bank", "alphaword spoken here today", "pending");
    expect(applySkipList({ coach, skipList: [] })).toBe(0);
    expect(stored(coach, "p").text_status).toBe("pending");
  });
});
