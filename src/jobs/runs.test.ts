import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCoachDb } from "../db/coach";
import {
  finishRun,
  isFirstFailureOfStreak,
  listRecentRuns,
  recordFailedStart,
  runStatusOf,
  shouldRun,
  startRun,
} from "./runs";

const offsetOf = () => -330;
const HOUR = 3_600_000;
// 2026-11-19 23:30 local (+05:30). The last 21:00 local is 2026-11-19T15:30Z.
const now = new Date("2026-11-19T18:00:00Z");
const afterSchedule = "2026-11-19T16:00:00.000Z";
const beforeSchedule = "2026-11-19T10:00:00.000Z";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-test-"));
  const opened = openCoachDb(path.join(dir, "coach.sqlite"));
  if (!opened.ok) throw new Error(opened.error);
  db = opened.value;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const insert = (kind: string, status: string, started: string): number =>
  Number(
    db
      .query("INSERT INTO runs (kind, started, status) VALUES (?, ?, ?)")
      .run(kind, started, status).lastInsertRowid,
  );

const guard = (at = now, kind: "nightly" | "morning" = "nightly") =>
  shouldRun({ db, kind, now: at, scheduledHour: 21, offsetOf });

describe("startRun and finishRun", () => {
  test("startRun writes a running row with an ISO UTC started", () => {
    const id = startRun(db, "nightly", now);
    const row = db.query("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      kind: "nightly",
      status: "running",
      started: "2026-11-19T18:00:00.000Z",
      finished: null,
    });
  });

  test("finishRun sets status, finished and JSON detail", () => {
    const id = startRun(db, "morning", now);
    const end = new Date("2026-11-19T18:05:00Z");
    finishRun(db, id, "partial", { analysed: 3, note: "budget" }, end);
    const row = db.query("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, string>;
    expect(row.status).toBe("partial");
    expect(row.finished).toBe("2026-11-19T18:05:00.000Z");
    expect(JSON.parse(row.detail as string)).toEqual({ analysed: 3, note: "budget" });
  });

  test("finishRun accepts skipped", () => {
    const id = startRun(db, "nightly", now);
    finishRun(db, id, "skipped", {}, now);
    const row = db.query("SELECT status FROM runs WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("skipped");
  });
});

describe("shouldRun", () => {
  test("runs with no history", () => {
    expect(guard()).toEqual({ run: true });
  });

  test("an ok run after the last 21:00 is already-ran", () => {
    insert("nightly", "ok", afterSchedule);
    expect(guard()).toEqual({ run: false, reason: "already-ran" });
  });

  test("a partial run after the last 21:00 is already-ran", () => {
    insert("nightly", "partial", afterSchedule);
    expect(guard()).toEqual({ run: false, reason: "already-ran" });
  });

  test("an ok run only before the last 21:00 runs", () => {
    insert("nightly", "ok", beforeSchedule);
    expect(guard()).toEqual({ run: true });
  });

  test("an ok run of the other kind does not block", () => {
    insert("morning", "ok", afterSchedule);
    expect(guard()).toEqual({ run: true });
  });

  test("3 failed runs, latest after the last 21:00, is failure-streak", () => {
    insert("nightly", "failed", "2026-11-17T16:00:00.000Z");
    insert("nightly", "failed", "2026-11-18T16:00:00.000Z");
    insert("nightly", "failed", afterSchedule);
    expect(guard()).toEqual({ run: false, reason: "failure-streak" });
  });

  test("the same 3 failures run again once now is past the next 21:00", () => {
    insert("nightly", "failed", "2026-11-17T16:00:00.000Z");
    insert("nightly", "failed", "2026-11-18T16:00:00.000Z");
    insert("nightly", "failed", afterSchedule);
    expect(guard(new Date("2026-11-20T16:00:00Z"))).toEqual({ run: true });
  });

  test("2 failed runs are not a streak", () => {
    insert("nightly", "failed", "2026-11-18T16:00:00.000Z");
    insert("nightly", "failed", afterSchedule);
    expect(guard()).toEqual({ run: true });
  });

  test("an ok run inside the last 3 breaks the streak", () => {
    insert("nightly", "failed", "2026-11-17T16:00:00.000Z");
    insert("nightly", "ok", "2026-11-18T16:00:00.000Z");
    insert("nightly", "failed", afterSchedule);
    expect(guard()).toEqual({ run: true });
  });

  test("skipped runs are ignored when counting the streak", () => {
    insert("nightly", "failed", "2026-11-17T16:00:00.000Z");
    insert("nightly", "failed", "2026-11-18T16:00:00.000Z");
    insert("nightly", "skipped", "2026-11-18T17:00:00.000Z");
    insert("nightly", "failed", afterSchedule);
    expect(guard()).toEqual({ run: false, reason: "failure-streak" });
  });

  test("a running row older than 2 hours counts as failed in the streak", () => {
    insert("nightly", "failed", "2026-11-17T16:00:00.000Z");
    insert("nightly", "failed", "2026-11-18T16:00:00.000Z");
    insert("nightly", "running", new Date(now.getTime() - 2 * HOUR - 60_000).toISOString());
    expect(guard()).toEqual({ run: false, reason: "failure-streak" });
  });

  test("a fresh running row is left out of the last 3", () => {
    insert("nightly", "failed", "2026-11-17T16:00:00.000Z");
    insert("nightly", "failed", "2026-11-18T16:00:00.000Z");
    insert("nightly", "failed", afterSchedule);
    insert("nightly", "running", new Date(now.getTime() - 10 * 60_000).toISOString());
    expect(guard()).toEqual({ run: false, reason: "failure-streak" });
  });

  test("an ok run started exactly at the last 21:00 is already-ran", () => {
    insert("nightly", "ok", "2026-11-19T15:30:00.000Z");
    expect(guard()).toEqual({ run: false, reason: "already-ran" });
  });

  test("a 10-minute-old running row is ignored", () => {
    insert("nightly", "failed", "2026-11-17T16:00:00.000Z");
    insert("nightly", "failed", "2026-11-18T16:00:00.000Z");
    insert("nightly", "running", new Date(now.getTime() - 10 * 60_000).toISOString());
    expect(guard()).toEqual({ run: true });
  });
});

describe("isFirstFailureOfStreak", () => {
  test("true for the first failed run after an ok run, false for the second", () => {
    insert("nightly", "ok", "2026-11-17T16:00:00.000Z");
    const first = insert("nightly", "failed", "2026-11-18T16:00:00.000Z");
    const second = insert("nightly", "failed", afterSchedule);
    expect(isFirstFailureOfStreak(db, "nightly", first, now)).toBe(true);
    expect(isFirstFailureOfStreak(db, "nightly", second, now)).toBe(false);
  });

  test("true when there is no earlier run", () => {
    const only = insert("nightly", "failed", afterSchedule);
    expect(isFirstFailureOfStreak(db, "nightly", only, now)).toBe(true);
  });

  test("ignores failed runs of the other kind", () => {
    insert("morning", "failed", "2026-11-18T16:00:00.000Z");
    const id = insert("nightly", "failed", afterSchedule);
    expect(isFirstFailureOfStreak(db, "nightly", id, now)).toBe(true);
  });

  test("a stale running row before the run counts as failed", () => {
    insert("nightly", "running", "2026-11-18T01:00:00.000Z");
    const id = insert("nightly", "failed", afterSchedule);
    expect(isFirstFailureOfStreak(db, "nightly", id, now)).toBe(false);
  });
});

describe("recordFailedStart", () => {
  const record = (at = now) => recordFailedStart({ db, kind: "nightly", now: at, error: "x".repeat(400), offsetOf });
  const stored = () => db.query("SELECT kind, status, finished, detail FROM runs ORDER BY id").all();

  test("the first failure writes a failed run with the error cut to 300 chars and asks for a notice", () => {
    expect(record()).toEqual({ recorded: true, notify: true });
    expect(stored()).toEqual([
      {
        kind: "nightly",
        status: "failed",
        finished: now.toISOString(),
        detail: JSON.stringify({ errors: ["x".repeat(300)] }),
      },
    ]);
  });

  test("the second and third failures are recorded with no notice", () => {
    record();
    expect(record()).toEqual({ recorded: true, notify: false });
    expect(record()).toEqual({ recorded: true, notify: false });
    expect(stored()).toHaveLength(3);
  });

  test("after 3 failures nothing is recorded until the next scheduled time", () => {
    for (let i = 0; i < 3; i++) record();
    expect(record()).toEqual({ recorded: false, notify: false });
    expect(stored()).toHaveLength(3);
    expect(record(new Date(now.getTime() + 24 * HOUR))).toEqual({ recorded: true, notify: false });
  });

  test("nothing is recorded when the job already ran since the last scheduled time", () => {
    insert("nightly", "ok", afterSchedule);
    expect(record()).toEqual({ recorded: false, notify: false });
    expect(stored()).toHaveLength(1);
  });

  test("a failure after an ok run from before the schedule asks for a notice again", () => {
    insert("nightly", "ok", beforeSchedule);
    expect(record()).toEqual({ recorded: true, notify: true });
  });

  test("the morning kind uses its 09:00 schedule", () => {
    // 2026-11-19T04:00Z is 09:30 local. An ok run at 03:00Z is 08:30 local, before 09:00.
    const at = new Date("2026-11-19T04:00:00Z");
    insert("morning", "ok", "2026-11-19T03:00:00.000Z");
    expect(recordFailedStart({ db, kind: "morning", now: at, error: "e", offsetOf })).toEqual({
      recorded: true,
      notify: true,
    });
    insert("morning", "ok", "2026-11-19T03:45:00.000Z");
    expect(recordFailedStart({ db, kind: "morning", now: at, error: "e", offsetOf }).recorded).toBe(false);
  });
});

describe("runStatusOf", () => {
  test("failed when any step failed, even if the budget was hit", () => {
    expect(runStatusOf([{ ok: true }, { ok: false }], true)).toBe("failed");
  });
  test("partial when all steps ok and the budget was hit", () => {
    expect(runStatusOf([{ ok: true }], true)).toBe("partial");
  });
  test("ok when all steps ok and no budget hit", () => {
    expect(runStatusOf([{ ok: true }, { ok: true }], false)).toBe("ok");
  });
  test("ok for no steps", () => {
    expect(runStatusOf([], false)).toBe("ok");
  });
});

describe("listRecentRuns", () => {
  test("returns newest first and respects the limit", () => {
    const a = insert("nightly", "ok", "2026-11-17T16:00:00.000Z");
    const b = insert("morning", "failed", "2026-11-18T03:30:00.000Z");
    const c = insert("nightly", "partial", "2026-11-18T16:00:00.000Z");
    expect(listRecentRuns(db, 10).map((r) => r.id)).toEqual([c, b, a]);
    expect(listRecentRuns(db, 2).map((r) => r.id)).toEqual([c, b]);
  });

  test("rows carry kind, status and started", () => {
    insert("morning", "failed", "2026-11-18T03:30:00.000Z");
    expect(listRecentRuns(db, 1)[0]).toMatchObject({
      kind: "morning",
      status: "failed",
      started: "2026-11-18T03:30:00.000Z",
    });
  });
});
