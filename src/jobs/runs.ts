import type { Database } from "bun:sqlite";
import { mostRecentScheduled, type OffsetOf } from "../domain/time";
import { LOCK_STALE_MS } from "./lock";

export type JobKind = "nightly" | "morning";
export type RunStatus = "ok" | "partial" | "failed";
type StoredStatus = RunStatus | "running" | "skipped";

export type RunRow = {
  id: number;
  kind: JobKind;
  started: string;
  finished: string | null;
  status: StoredStatus;
  detail: string | null;
};

const STREAK_LENGTH = 3;
const MAX_ERROR_LENGTH = 300;

export const SCHEDULED_HOURS = { nightly: 21, morning: 9 } as const satisfies Record<JobKind, number>;

export const startRun = (db: Database, kind: JobKind, now: Date): number =>
  Number(
    db
      .query("INSERT INTO runs (kind, started, status) VALUES (?, ?, 'running')")
      .run(kind, now.toISOString()).lastInsertRowid,
  );

export const finishRun = (
  db: Database,
  id: number,
  status: RunStatus | "skipped",
  detail: Record<string, unknown>,
  now: Date,
): void => {
  db.query("UPDATE runs SET status = ?, finished = ?, detail = ? WHERE id = ?").run(
    status,
    now.toISOString(),
    JSON.stringify(detail),
    id,
  );
};

export const effectiveStatus = (
  row: Pick<RunRow, "status" | "started">,
  now: Date,
): StoredStatus =>
  row.status === "running" && now.getTime() - Date.parse(row.started) > LOCK_STALE_MS
    ? "failed"
    : row.status;

const countedRuns = (db: Database, kind: JobKind, now: Date): RunRow[] =>
  (
    db
      .query("SELECT * FROM runs WHERE kind = ? ORDER BY started DESC, id DESC")
      .all(kind) as RunRow[]
  )
    .map((r) => ({ ...r, status: effectiveStatus(r, now) }))
    .filter((r) => r.status !== "running" && r.status !== "skipped");

export const shouldRun = (input: {
  db: Database;
  kind: JobKind;
  now: Date;
  scheduledHour: number;
  offsetOf?: OffsetOf;
}): { run: true } | { run: false; reason: "already-ran" | "failure-streak" } => {
  const since = mostRecentScheduled(input.now, input.scheduledHour, input.offsetOf).getTime();
  const runs = countedRuns(input.db, input.kind, input.now);
  if (runs.some((r) => (r.status === "ok" || r.status === "partial") && Date.parse(r.started) >= since)) {
    return { run: false, reason: "already-ran" };
  }
  const last = runs.slice(0, STREAK_LENGTH);
  if (
    last.length === STREAK_LENGTH &&
    last.every((r) => r.status === "failed") &&
    Date.parse(last[0]!.started) >= since
  ) {
    return { run: false, reason: "failure-streak" };
  }
  return { run: true };
};

export const isFirstFailureOfStreak = (
  db: Database,
  kind: JobKind,
  runId: number,
  now: Date,
): boolean => {
  const runs = (
    db
      .query("SELECT * FROM runs WHERE kind = ? AND id < ? ORDER BY started DESC, id DESC")
      .all(kind, runId) as RunRow[]
  )
    .map((r) => ({ ...r, status: effectiveStatus(r, now) }))
    .filter((r) => r.status !== "skipped");
  return runs[0]?.status !== "failed";
};

export const recordFailedStart = (input: {
  db: Database;
  kind: JobKind;
  now: Date;
  error: string;
  offsetOf?: OffsetOf;
}): { recorded: boolean; notify: boolean } => {
  const { db, kind, now } = input;
  const gate = shouldRun({ db, kind, now, scheduledHour: SCHEDULED_HOURS[kind], offsetOf: input.offsetOf });
  if (!gate.run) return { recorded: false, notify: false };
  const id = startRun(db, kind, now);
  finishRun(db, id, "failed", { errors: [input.error.slice(0, MAX_ERROR_LENGTH)] }, now);
  return { recorded: true, notify: isFirstFailureOfStreak(db, kind, id, now) };
};

export const runStatusOf = (steps: { ok: boolean }[], budgetHit: boolean): RunStatus =>
  steps.some((s) => !s.ok) ? "failed" : budgetHit ? "partial" : "ok";

export const listRecentRuns = (db: Database, limit: number): RunRow[] =>
  db.query("SELECT * FROM runs ORDER BY started DESC, id DESC LIMIT ?").all(limit) as RunRow[];
