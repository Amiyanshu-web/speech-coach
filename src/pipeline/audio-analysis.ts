import type { Database } from "bun:sqlite";
import type { Budget, GeminiApi } from "../clients/gemini";
import { onFailure } from "../domain/status";
import { describeError, type Logger } from "../log";
import { err, ok, type Result } from "../result";
import { readAudio } from "../wispr/source";

type Pending = {
  id: string;
  day: string;
  asr_text: string | null;
  audio_attempts: number;
  audio_last_attempt_day: string | null;
};

type Summary = {
  done: number;
  failed: number;
  skipped: number;
  leftPending: number;
  budgetHit: boolean;
  issueDays: string[];
};

export const analyzeAudio = async (input: {
  coach: Database;
  wispr: Database;
  gemini: GeminiApi;
  budget: Budget;
  log: Logger;
  today: string;
}): Promise<Result<Summary>> => {
  const { coach, wispr, gemini, budget, log, today } = input;
  try {
    const pending = coach
      .query(
        `SELECT id, day, asr_text, audio_attempts, audio_last_attempt_day FROM dictations
         WHERE audio_status IN ('pending', 'failed') ORDER BY ts`,
      )
      .all() as Pending[];
    const setSkipped = coach.prepare("UPDATE dictations SET audio_status = 'skipped' WHERE id = ?");
    const setDone = coach.prepare("UPDATE dictations SET audio_status = 'done' WHERE id = ?");
    const setFailure = coach.prepare(
      `UPDATE dictations SET audio_status = ?, audio_attempts = ?, audio_last_attempt_day = ? WHERE id = ?`,
    );
    const insertIssue = coach.prepare(
      `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern)
       VALUES (?, ?, 'sound', ?, ?, ?, ?)`,
    );
    const issueDays = new Set<string>();
    let done = 0;
    let failed = 0;
    let skipped = 0;
    let processed = 0;
    let budgetHit = false;
    for (const row of pending) {
      const wav = readAudio(wispr, row.id);
      if (wav === null) {
        setSkipped.run(row.id);
        skipped++;
        processed++;
        continue;
      }
      const result = await gemini.analyzeAudio({ wav, context: row.asr_text ?? "", budget });
      if (result.ok) {
        coach.transaction(() => {
          for (const n of result.value) {
            insertIssue.run(row.id, row.day, n.word, n.sound, n.tip, `sound:${n.word.toLowerCase()}`);
          }
          setDone.run(row.id);
        })();
        if (result.value.length > 0) issueDays.add(row.day);
        done++;
        processed++;
      } else if (result.error.kind === "budget") {
        budgetHit = true;
        break;
      } else {
        log.error("audio analysis failed", { id: row.id, kind: result.error.kind });
        const f = onFailure({
          attempts: row.audio_attempts,
          lastAttemptDay: row.audio_last_attempt_day,
          today,
        });
        setFailure.run(f.status, f.attempts, f.lastAttemptDay, row.id);
        if (f.status === "skipped") skipped++;
        else failed++;
        processed++;
      }
    }
    return ok({
      done,
      failed,
      skipped,
      leftPending: pending.length - processed,
      budgetHit,
      issueDays: [...issueDays],
    });
  } catch (e) {
    return err(`analyzeAudio failed: ${describeError(e)}`);
  }
};
