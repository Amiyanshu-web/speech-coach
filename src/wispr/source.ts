import { Database } from "bun:sqlite";
import { err, ok, type Result } from "../result";

export const REQUIRED_COLUMNS: readonly string[] = [
  "transcriptEntityId",
  "timestamp",
  "app",
  "duration",
  "asrText",
  "formattedText",
  "audio",
  "needsUploading",
  "status",
  "timezoneOffsetMinutes",
];

export type WisprRow = {
  id: string;
  timestamp: string;
  app: string | null;
  duration: number | null;
  asrText: string | null;
  formattedText: string | null;
  status: string | null;
  timezoneOffsetMinutes: number | null;
  needsUploading: number;
  hasAudio: boolean;
};

const CHUNK_SIZE = 500;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const openWisprReadOnly = (path: string): Result<Database> => {
  try {
    return ok(new Database(path, { readonly: true }));
  } catch (e) {
    return err(`Cannot open Wispr database read-only: ${message(e)}`);
  }
};

export const checkWisprColumns = (db: Database): Result<void> => {
  try {
    const present = new Set(
      (db.query("PRAGMA table_info(History)").all() as { name: string }[]).map((c) => c.name),
    );
    const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
    return missing.length > 0
      ? err(`Wispr History table is missing columns: ${missing.join(", ")}`)
      : ok(undefined);
  } catch (e) {
    return err(`Cannot read Wispr schema: ${message(e)}`);
  }
};

export const listHistoryIds = (db: Database): string[] =>
  (db.query("SELECT transcriptEntityId AS id FROM History").all() as { id: string }[]).map(
    (r) => r.id,
  );

type RawRow = Omit<WisprRow, "hasAudio"> & { hasAudio: number };

export const readHistoryRows = (db: Database, ids: string[]): WisprRow[] => {
  const rows: WisprRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const marks = chunk.map(() => "?").join(", ");
    const found = db
      .query(
        `SELECT transcriptEntityId AS id, timestamp, app, duration, asrText, formattedText, status,
                timezoneOffsetMinutes, needsUploading, audio IS NOT NULL AS hasAudio
         FROM History WHERE transcriptEntityId IN (${marks})`,
      )
      .all(...chunk) as RawRow[];
    for (const r of found) rows.push({ ...r, hasAudio: r.hasAudio === 1 });
  }
  return rows;
};

export const readAudio = (db: Database, id: string): Uint8Array | null => {
  const row = db.query("SELECT audio FROM History WHERE transcriptEntityId = ?").get(id) as {
    audio: Uint8Array | null;
  } | null;
  return row?.audio ? new Uint8Array(row.audio) : null;
};

/** Opens Wispr read-only for one read and closes it again. ok(null) means no such clip. */
export const readAudioFromPath = (path: string, id: string): Result<Uint8Array | null> => {
  const opened = openWisprReadOnly(path);
  if (!opened.ok) return opened;
  try {
    return ok(readAudio(opened.value, id));
  } catch (e) {
    return err(`Cannot read Wispr audio: ${message(e)}`);
  } finally {
    opened.value.close();
  }
};
