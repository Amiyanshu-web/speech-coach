import type { Database } from "bun:sqlite";
import { type ClaudeApi, type JsonSchema, TEXT_MAX_TOKENS } from "../clients/claude";
import { onFailure } from "../domain/status";
import type { Logger } from "../log";
import { type Result, err, ok } from "../result";

export const TEXT_CHUNK_SIZE = 150;

const KINDS = ["grammar", "word", "filler"] as const;
type Kind = (typeof KINDS)[number];

type TextIssue = { kind: Kind; said: string; better: string; reason: string; pattern: string };
type TextReply = { dictations: { id: string; issues: TextIssue[] }[] };

const STRING = { type: "string" };

export const TEXT_ISSUES_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    dictations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: STRING,
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...KINDS] },
                said: STRING,
                better: STRING,
                reason: STRING,
                pattern: STRING,
              },
              required: ["kind", "said", "better", "reason", "pattern"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "issues"],
        additionalProperties: false,
      },
    },
  },
  required: ["dictations"],
  additionalProperties: false,
};

export const TEXT_SYSTEM_PROMPT = `You review short dictated sentences from one speaker who is learning to speak clear English.
For each dictation, list only real mistakes in three kinds: "grammar", "word" (a wrong or weak word choice) and "filler" (filler words such as um, like, you know).
Do not flag terse imperative or prompt-style phrasing, such as short instructions to a coding agent. That style is intentional and is not an error.
For each issue give "said" (the exact words), "better" (the fix), "reason" (one short sentence) and "pattern".
The "pattern" is a short normalised key for the kind of mistake, for example comparative:more fast->faster.
Return every dictation id from the input, with an empty issues list when it has no mistakes.`;

const isStr = (x: unknown): x is string => typeof x === "string";

const isIssue = (x: unknown): x is TextIssue => {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    KINDS.some((k) => k === o.kind) &&
    isStr(o.said) &&
    isStr(o.better) &&
    isStr(o.reason) &&
    isStr(o.pattern)
  );
};

export const validateTextReply = (x: unknown): x is TextReply => {
  if (typeof x !== "object" || x === null) return false;
  const list = (x as Record<string, unknown>).dictations;
  return (
    Array.isArray(list) &&
    list.every((d) => {
      if (typeof d !== "object" || d === null) return false;
      const o = d as Record<string, unknown>;
      return isStr(o.id) && Array.isArray(o.issues) && o.issues.every(isIssue);
    })
  );
};

type Pending = {
  id: string;
  day: string;
  text: string;
  attempts: number;
  lastDay: string | null;
};

type Counts = { done: number; failed: number; skipped: number };

const selectPending = (coach: Database): Pending[] =>
  (
    coach
      .query(
        `SELECT id, day, asr_text AS text, text_attempts AS attempts, text_last_attempt_day AS lastDay
         FROM dictations
         WHERE text_status IN ('pending','failed') AND asr_text IS NOT NULL
         ORDER BY ts, id`,
      )
      .all() as Pending[]
  );

const saveSuccess = (coach: Database, answered: Map<Pending, TextIssue[]>, issueDays: Set<string>): void => {
  const insert = coach.query(
    `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const mark = coach.query("UPDATE dictations SET text_status = 'done' WHERE id = ?");
  coach.transaction(() => {
    for (const [row, issues] of answered) {
      for (const i of issues) {
        insert.run(row.id, row.day, i.kind, i.said, i.better, i.reason, i.pattern);
        issueDays.add(row.day);
      }
      mark.run(row.id);
    }
  })();
};

const answeredRows = (chunk: Pending[], reply: TextReply): Map<Pending, TextIssue[]> => {
  const byId = new Map(chunk.map((r) => [r.id, r]));
  const answered = new Map<Pending, TextIssue[]>();
  for (const d of reply.dictations) {
    const row = byId.get(d.id);
    if (row && !answered.has(row)) answered.set(row, d.issues);
  }
  return answered;
};

const saveFailure = (coach: Database, chunk: Pending[], today: string, counts: Counts): void => {
  const update = coach.query(
    "UPDATE dictations SET text_status = ?, text_attempts = ?, text_last_attempt_day = ? WHERE id = ?",
  );
  coach.transaction(() => {
    for (const r of chunk) {
      const next = onFailure({ attempts: r.attempts, lastAttemptDay: r.lastDay, today });
      update.run(next.status, next.attempts, next.lastAttemptDay, r.id);
      if (next.status === "skipped") counts.skipped += 1;
      else counts.failed += 1;
    }
  })();
};

export const analyzeText = async ({
  coach,
  claude,
  log,
  today,
}: {
  coach: Database;
  claude: ClaudeApi;
  log: Logger;
  today: string;
}): Promise<Result<{ done: number; failed: number; skipped: number; issueDays: string[] }>> => {
  const counts: Counts = { done: 0, failed: 0, skipped: 0 };
  const issueDays = new Set<string>();

  const sendChunk = async (chunk: Pending[], canSplit: boolean): Promise<void> => {
    const res = await claude.structured<TextReply>({
      system: TEXT_SYSTEM_PROMPT,
      user: JSON.stringify(chunk.map((r) => ({ id: r.id, text: r.text }))),
      schema: TEXT_ISSUES_SCHEMA,
      maxTokens: TEXT_MAX_TOKENS,
      validate: validateTextReply,
    });
    if (res.ok) {
      const answered = answeredRows(chunk, res.value);
      saveSuccess(coach, answered, issueDays);
      counts.done += answered.size;
      const missing = chunk.filter((r) => !answered.has(r));
      if (missing.length > 0) {
        log.error("text analysis reply left out dictations", { rows: missing.length });
        saveFailure(coach, missing, today, counts);
      }
      return;
    }
    log.error("text analysis chunk failed", {
      kind: res.error.kind,
      message: res.error.message,
      rows: chunk.length,
    });
    if (res.error.kind === "max_tokens" && canSplit && chunk.length > 1) {
      const mid = Math.ceil(chunk.length / 2);
      await sendChunk(chunk.slice(0, mid), false);
      await sendChunk(chunk.slice(mid), false);
      return;
    }
    saveFailure(coach, chunk, today, counts);
  };

  try {
    const pending = selectPending(coach);
    for (let i = 0; i < pending.length; i += TEXT_CHUNK_SIZE) {
      await sendChunk(pending.slice(i, i + TEXT_CHUNK_SIZE), true);
    }
  } catch (e) {
    return err(`text analysis database error: ${e instanceof Error ? e.name : "unknown"}`);
  }
  return ok({ ...counts, issueDays: [...issueDays].sort() });
};
