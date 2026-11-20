import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { err, ok, type Result } from "../result";

const STATUS = "('pending','done','failed','skipped')";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dictations (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  app TEXT,
  duration REAL,
  asr_text TEXT,
  formatted_text TEXT,
  words INTEGER NOT NULL DEFAULT 0,
  text_status TEXT NOT NULL CHECK (text_status IN ${STATUS}),
  audio_status TEXT NOT NULL CHECK (audio_status IN ${STATUS}),
  text_attempts INTEGER NOT NULL DEFAULT 0,
  audio_attempts INTEGER NOT NULL DEFAULT 0,
  text_last_attempt_day TEXT,
  audio_last_attempt_day TEXT
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dictation_id TEXT NOT NULL REFERENCES dictations(id),
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('grammar','word','filler','sound')),
  said TEXT NOT NULL,
  better TEXT NOT NULL,
  reason TEXT NOT NULL,
  pattern TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issues_day ON issues(day);
CREATE INDEX IF NOT EXISTS issues_pattern ON issues(pattern);
CREATE TABLE IF NOT EXISTS lessons (day TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS daily_words (
  day TEXT NOT NULL,
  word TEXT NOT NULL,
  meaning TEXT NOT NULL,
  example TEXT NOT NULL,
  from_sentence TEXT NOT NULL,
  PRIMARY KEY (day, word)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('nightly','morning')),
  started TEXT NOT NULL,
  finished TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ok','partial','failed','skipped')),
  detail TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS dictations_fts USING fts5(asr_text, content='dictations', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS dictations_ai AFTER INSERT ON dictations BEGIN
  INSERT INTO dictations_fts(rowid, asr_text) VALUES (new.rowid, new.asr_text);
END;
CREATE TRIGGER IF NOT EXISTS dictations_ad AFTER DELETE ON dictations BEGIN
  INSERT INTO dictations_fts(dictations_fts, rowid, asr_text) VALUES ('delete', old.rowid, old.asr_text);
END;
CREATE TRIGGER IF NOT EXISTS dictations_au AFTER UPDATE OF asr_text ON dictations BEGIN
  INSERT INTO dictations_fts(dictations_fts, rowid, asr_text) VALUES ('delete', old.rowid, old.asr_text);
  INSERT INTO dictations_fts(rowid, asr_text) VALUES (new.rowid, new.asr_text);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(said, better, reason, content='issues', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS issues_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, said, better, reason) VALUES (new.id, new.said, new.better, new.reason);
END;
CREATE TRIGGER IF NOT EXISTS issues_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, said, better, reason) VALUES ('delete', old.id, old.said, old.better, old.reason);
END;
CREATE TRIGGER IF NOT EXISTS issues_au AFTER UPDATE OF said, better, reason ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, said, better, reason) VALUES ('delete', old.id, old.said, old.better, old.reason);
  INSERT INTO issues_fts(rowid, said, better, reason) VALUES (new.id, new.said, new.better, new.reason);
END;
`;

const insideWisprFolder = (file: string): boolean =>
  path
    .resolve(file)
    .split(path.sep)
    .some((part) => part.toLowerCase() === "wispr flow");

export const openCoachDb = (file: string): Result<Database> => {
  if (file !== ":memory:" && insideWisprFolder(file)) return err("openCoachDb refused: the path is inside a Wispr Flow folder");
  let db: Database | undefined;
  try {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    return ok(db);
  } catch (e) {
    db?.close();
    return err(`openCoachDb failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
