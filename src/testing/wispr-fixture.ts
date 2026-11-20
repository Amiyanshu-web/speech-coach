import { Database } from "bun:sqlite";
import { join } from "node:path";

export type FixtureRow = {
  transcriptEntityId: string;
  timestamp: string;
  app: string | null;
  duration: number | null;
  asrText: string | null;
  formattedText: string | null;
  audio: Uint8Array | null;
  needsUploading: number;
  status: string | null;
  timezoneOffsetMinutes: number;
  extraColumn: string | null;
};

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export const wisprTimestamp = (ms: number): string => {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
  return `${date} ${time} +00:00`;
};

export const fixtureWav = (marker: string): Uint8Array => {
  const data = new TextEncoder().encode(marker);
  const out = new Uint8Array(44 + data.length);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string) => out.set(new TextEncoder().encode(text), offset);
  tag(0, "RIFF");
  view.setUint32(4, 36 + data.length, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
};

const SCHEMA = `CREATE TABLE History (
  transcriptEntityId VARCHAR(36) PRIMARY KEY,
  timestamp TEXT,
  app TEXT,
  duration REAL,
  asrText TEXT,
  formattedText TEXT,
  audio BLOB,
  needsUploading INTEGER,
  status TEXT,
  timezoneOffsetMinutes INTEGER,
  extraColumn TEXT
)`;

export const createWisprFixture = (
  dir: string,
  rows: Partial<FixtureRow>[],
): { path: string; db: Database } => {
  const path = join(dir, "flow.sqlite");
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const insert = db.prepare(
    `INSERT INTO History (transcriptEntityId, timestamp, app, duration, asrText, formattedText, audio, needsUploading, status, timezoneOffsetMinutes, extraColumn)
     VALUES ($id, $timestamp, $app, $duration, $asrText, $formattedText, $audio, $needsUploading, $status, $tz, $extra)`,
  );
  rows.forEach((row, i) => {
    const has = <K extends keyof FixtureRow>(key: K) => key in row;
    insert.run({
      $id: row.transcriptEntityId ?? `fixture-${pad(i + 1, 4)}`,
      $timestamp: row.timestamp ?? wisprTimestamp(Date.UTC(2026, 10, 19, 12, 0, 0) + i * 1000),
      $app: has("app") ? (row.app ?? null) : "com.apple.Terminal",
      $duration: row.duration ?? null,
      $asrText: row.asrText ?? null,
      $formattedText: row.formattedText ?? null,
      $audio: row.audio ?? null,
      $needsUploading: row.needsUploading ?? 0,
      $status: has("status") ? (row.status ?? null) : "formatted",
      $tz: row.timezoneOffsetMinutes ?? -330,
      $extra: row.extraColumn ?? null,
    });
  });
  return { path, db };
};

export const snapshotNonAudio = (db: Database): string => {
  const columns = (db.query("PRAGMA table_info(History)").all() as { name: string }[])
    .map((c) => c.name)
    .filter((name) => name !== "audio");
  const list = columns.map((c) => `"${c}"`).join(", ");
  const rows = db
    .query(`SELECT ${list} FROM History ORDER BY transcriptEntityId`)
    .all();
  return JSON.stringify(rows);
};
