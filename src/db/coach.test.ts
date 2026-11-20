import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCoachDb } from "./coach";

let dir: string;
let dbPath: string;
const open: Database[] = [];

const openOk = (p: string): Database => {
  const r = openCoachDb(p);
  if (!r.ok) throw new Error(`openCoachDb failed: ${r.error}`);
  open.push(r.value);
  return r.value;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "coach-"));
  dbPath = path.join(dir, "nested", "coach.db");
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const insertDictation = (db: Database, id: string, asr: string | null) =>
  db
    .query(
      `INSERT INTO dictations (id, ts, day, asr_text, text_status, audio_status)
       VALUES (?, '2026-11-19T10:00:00Z', '2026-11-19', ?, 'pending', 'pending')`,
    )
    .run(id, asr);

const insertIssue = (db: Database, dictationId: string, said: string, better: string, reason: string) =>
  db
    .query(
      `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern)
       VALUES (?, '2026-11-19', 'grammar', ?, ?, ?, 'p')`,
    )
    .run(dictationId, said, better, reason);

const dictationHits = (db: Database, term: string): string[] =>
  db
    .query<{ id: string }, [string]>(
      `SELECT d.id FROM dictations_fts f JOIN dictations d ON d.rowid = f.rowid
       WHERE dictations_fts MATCH ? ORDER BY d.id`,
    )
    .all(term)
    .map((r) => r.id);

const issueHits = (db: Database, term: string): number[] =>
  db
    .query<{ rowid: number }, [string]>(`SELECT rowid FROM issues_fts WHERE issues_fts MATCH ? ORDER BY rowid`)
    .all(term)
    .map((r) => r.rowid);

describe("openCoachDb refuses Wispr paths (INV-2)", () => {
  test.each([["Wispr Flow/flow.sqlite"], ["Wispr Flow/other/coach.db"], ["wispr flow/flow.sqlite"]])(
    "%s returns an error and creates nothing",
    (rel) => {
      const target = path.join(dir, rel);
      const r = openCoachDb(target);
      expect(r.ok).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
    },
  );

  test("a path with Wispr only in the file name is allowed", () => {
    openOk(path.join(dir, "wispr-notes.db"));
  });
});

describe("openCoachDb", () => {
  test("creates the parent folder and opens a file DB", () => {
    const db = openOk(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(db.query("SELECT 1 AS x").get()).toEqual({ x: 1 });
  });

  test("is idempotent when opened twice in a row on the same file", () => {
    const first = openCoachDb(dbPath);
    expect(first.ok).toBe(true);
    if (first.ok) first.value.close();
    const second = openCoachDb(dbPath);
    expect(second.ok).toBe(true);
    if (second.ok) open.push(second.value);
  });

  test("sets WAL, busy_timeout 5000 and foreign_keys ON", () => {
    const db = openOk(dbPath);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  });

  test("creates every table", () => {
    const db = openOk(dbPath);
    const names = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    for (const t of ["dictations", "issues", "lessons", "daily_words", "settings", "runs", "dictations_fts", "issues_fts"]) {
      expect(names).toContain(t);
    }
  });

  test("returns err instead of throwing when the path cannot be opened", () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    const r = openCoachDb(path.join(blocker, "sub", "coach.db"));
    expect(r.ok).toBe(false);
  });
});

describe("enum CHECK constraints", () => {
  test("rejects a text_status outside the enum", () => {
    const db = openOk(dbPath);
    expect(() =>
      db
        .query(
          `INSERT INTO dictations (id, ts, day, text_status, audio_status)
           VALUES ('a', 't', '2026-11-19', 'bogus', 'pending')`,
        )
        .run(),
    ).toThrow();
  });

  test("rejects an audio_status outside the enum", () => {
    const db = openOk(dbPath);
    expect(() =>
      db
        .query(
          `INSERT INTO dictations (id, ts, day, text_status, audio_status)
           VALUES ('a', 't', '2026-11-19', 'pending', 'bogus')`,
        )
        .run(),
    ).toThrow();
  });

  test("accepts every valid status", () => {
    const db = openOk(dbPath);
    for (const s of ["pending", "done", "failed", "skipped"]) {
      db.query(
        `INSERT INTO dictations (id, ts, day, text_status, audio_status) VALUES (?, 't', 'd', ?, ?)`,
      ).run(`id-${s}`, s, s);
    }
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM dictations").get()?.n).toBe(4);
  });

  test("rejects a bad issue kind and a bad run kind or status", () => {
    const db = openOk(dbPath);
    insertDictation(db, "d1", "hello");
    expect(() =>
      db
        .query(
          `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern)
           VALUES ('d1', 'd', 'bogus', 's', 'b', 'r', 'p')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db.query(`INSERT INTO runs (kind, started, status) VALUES ('weekly', 't', 'ok')`).run(),
    ).toThrow();
    expect(() =>
      db.query(`INSERT INTO runs (kind, started, status) VALUES ('nightly', 't', 'bogus')`).run(),
    ).toThrow();
  });

  test("enforces the issues foreign key to dictations", () => {
    const db = openOk(dbPath);
    expect(() => insertIssue(db, "missing", "s", "b", "r")).toThrow();
  });
});

describe("dictations_fts sync", () => {
  test("insert makes the text searchable", () => {
    const db = openOk(dbPath);
    insertDictation(db, "d1", "the quick brown fox");
    insertDictation(db, "d2", "lazy dog");
    expect(dictationHits(db, "fox")).toEqual(["d1"]);
    expect(dictationHits(db, "dog")).toEqual(["d2"]);
  });

  test("updating asr_text to NULL removes the old terms", () => {
    const db = openOk(dbPath);
    insertDictation(db, "d1", "the quick brown fox");
    db.query("UPDATE dictations SET asr_text = NULL WHERE id = 'd1'").run();
    expect(dictationHits(db, "fox")).toEqual([]);
  });

  test("updating asr_text replaces the terms", () => {
    const db = openOk(dbPath);
    insertDictation(db, "d1", "the quick brown fox");
    db.query("UPDATE dictations SET asr_text = 'a sleepy cat' WHERE id = 'd1'").run();
    expect(dictationHits(db, "fox")).toEqual([]);
    expect(dictationHits(db, "cat")).toEqual(["d1"]);
  });

  test("delete removes the terms", () => {
    const db = openOk(dbPath);
    insertDictation(db, "d1", "the quick brown fox");
    db.query("DELETE FROM dictations WHERE id = 'd1'").run();
    expect(dictationHits(db, "fox")).toEqual([]);
  });

  test("updating only text_status leaves FTS results unchanged", () => {
    const db = openOk(dbPath);
    insertDictation(db, "d1", "the quick brown fox");
    db.query("UPDATE dictations SET text_status = 'done' WHERE id = 'd1'").run();
    expect(dictationHits(db, "fox")).toEqual(["d1"]);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM dictations_fts_docsize").get()?.n,
    ).toBe(1);
  });
});

describe("issues_fts sync", () => {
  const setup = () => {
    const db = openOk(dbPath);
    insertDictation(db, "d1", "hello");
    insertIssue(db, "d1", "me and him went", "he and I went", "subject pronoun");
    return db;
  };

  test("insert makes said, better and reason searchable", () => {
    const db = setup();
    expect(issueHits(db, "went")).toEqual([1]);
    expect(issueHits(db, "pronoun")).toEqual([1]);
    expect(issueHits(db, "said:me")).toEqual([1]);
  });

  test("updating a text column replaces the old terms", () => {
    const db = setup();
    db.query("UPDATE issues SET reason = 'wrong tense' WHERE id = 1").run();
    expect(issueHits(db, "pronoun")).toEqual([]);
    expect(issueHits(db, "tense")).toEqual([1]);
  });

  test("updating a text column to a new value drops the old one", () => {
    const db = setup();
    db.query("UPDATE issues SET said = 'zebra' WHERE id = 1").run();
    expect(issueHits(db, "said:me")).toEqual([]);
    expect(issueHits(db, "zebra")).toEqual([1]);
  });

  test("delete removes the terms", () => {
    const db = setup();
    db.query("DELETE FROM issues WHERE id = 1").run();
    expect(issueHits(db, "went")).toEqual([]);
  });

  test("updating a non-text column leaves FTS results unchanged", () => {
    const db = setup();
    db.query("UPDATE issues SET pattern = 'other', kind = 'word' WHERE id = 1").run();
    expect(issueHits(db, "went")).toEqual([1]);
    expect(issueHits(db, "pronoun")).toEqual([1]);
  });
});

describe("no audio data column", () => {
  test("only audio_status, audio_attempts and audio_last_attempt_day mention audio, in every table", () => {
    const db = openOk(dbPath);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
      .filter((n) => !/_fts_(data|idx|docsize|config|content)$/.test(n));
    expect(tables.length).toBeGreaterThanOrEqual(8);
    const audioColumns: string[] = [];
    for (const t of tables) {
      const cols = db.query<{ name: string; type: string }, []>(`PRAGMA table_info(${t})`).all();
      for (const c of cols) {
        if (/audio|blob|wav|opus|mp3|bytes/i.test(c.name)) audioColumns.push(`${t}.${c.name}`);
        expect(c.type.toUpperCase()).not.toBe("BLOB");
      }
    }
    expect(audioColumns.sort()).toEqual([
      "dictations.audio_attempts",
      "dictations.audio_last_attempt_day",
      "dictations.audio_status",
    ]);
  });
});
