import type { Database } from "bun:sqlite";
import type { Status } from "../domain/status";
import { localDayFromUtc, parseWisprTimestamp } from "../domain/time";
import { describeError, type Logger } from "../log";
import { err, ok, type Result } from "../result";
import { listHistoryIds, readHistoryRows, type WisprRow } from "../wispr/source";

const ANALYSED_STATUSES = ["formatted", "raw_transcript"];
const MIN_WORDS = 3;

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const classifyRow = (
  row: WisprRow,
  skipList: string[],
): { text: Status; audio: Status; storeText: boolean } => {
  const inSkipList = row.app !== null && skipList.includes(row.app);
  const storeText = !inSkipList;
  const analysable =
    row.status !== null &&
    ANALYSED_STATUSES.includes(row.status) &&
    row.asrText !== null &&
    countWords(row.asrText) >= MIN_WORDS &&
    !inSkipList;
  if (!analysable) return { text: "skipped", audio: "skipped", storeText };
  return { text: "pending", audio: row.hasAudio ? "pending" : "skipped", storeText };
};

export const importNew = (input: {
  wispr: Database;
  coach: Database;
  skipList: string[];
  log: Logger;
}): Result<{ imported: number; skipped: number }> => {
  const { wispr, coach, skipList, log } = input;
  try {
    const known = new Set(
      (coach.query("SELECT id FROM dictations").all() as { id: string }[]).map((r) => r.id),
    );
    const newIds = listHistoryIds(wispr).filter((id) => !known.has(id));
    const rows = readHistoryRows(wispr, newIds);
    const insert = coach.prepare(
      `INSERT INTO dictations (id, ts, day, app, duration, asr_text, formatted_text, words, text_status, audio_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let imported = 0;
    let skipped = 0;
    coach.transaction(() => {
      for (const row of rows) {
        const ms = parseWisprTimestamp(row.timestamp);
        if (!ms.ok) {
          log.warn("skipping history row with unparseable timestamp", { id: row.id });
          continue;
        }
        const c = classifyRow(row, skipList);
        insert.run(
          row.id,
          row.timestamp,
          localDayFromUtc(ms.value, row.timezoneOffsetMinutes ?? 0),
          row.app,
          row.duration,
          c.storeText ? row.asrText : null,
          c.storeText ? row.formattedText : null,
          c.storeText && row.asrText !== null ? countWords(row.asrText) : 0,
          c.text,
          c.audio,
        );
        imported++;
        if (c.text === "skipped") skipped++;
      }
    })();
    return ok({ imported, skipped });
  } catch (e) {
    return err(`importNew failed: ${describeError(e)}`);
  }
};

export const applySkipList = (input: { coach: Database; skipList: string[] }): number => {
  const { coach, skipList } = input;
  if (skipList.length === 0) return 0;
  const marks = skipList.map(() => "?").join(", ");
  return coach.transaction(() => {
    const changed = coach
      .query(
        `UPDATE dictations
         SET text_status = 'skipped', audio_status = 'skipped', asr_text = NULL, formatted_text = NULL, words = 0
         WHERE text_status IN ('pending', 'failed') AND app IN (${marks})`,
      )
      .run(...skipList).changes;
    coach
      .query(
        `UPDATE dictations SET audio_status = 'skipped'
         WHERE audio_status IN ('pending', 'failed') AND app IN (${marks})`,
      )
      .run(...skipList);
    return changed;
  })();
};
