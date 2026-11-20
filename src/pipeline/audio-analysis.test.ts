import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudget, type GeminiError, type SoundNote } from "../clients/gemini";
import { openCoachDb } from "../db/coach";
import { createLogger } from "../log";
import { err, ok, type Result } from "../result";
import { createFakeGemini } from "../testing/fake-gemini";
import { createWisprFixture, fixtureWav } from "../testing/wispr-fixture";
import { analyzeAudio } from "./audio-analysis";

const TODAY = "2026-11-19";
const MARKER = "AUDIOMARKER-7f3a9c";
const WAV = fixtureWav(MARKER);

let dir: string;
const open: Database[] = [];
const logLines: string[] = [];
const log = createLogger((line) => logLines.push(line));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audio-analysis-"));
  logLines.length = 0;
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

type DictationSeed = {
  id: string;
  day?: string;
  audio?: Uint8Array | null;
  status?: string;
  attempts?: number;
  lastDay?: string | null;
  asr?: string | null;
};

const setup = (seeds: DictationSeed[]) => {
  const wispr = createWisprFixture(
    dir,
    seeds.map((s) => ({
      transcriptEntityId: s.id,
      audio: s.audio === undefined ? WAV : s.audio,
    })),
  ).db;
  const coachResult = openCoachDb(join(dir, "coach.sqlite"));
  if (!coachResult.ok) throw new Error(coachResult.error);
  const coach = coachResult.value;
  open.push(wispr, coach);
  const insert = coach.prepare(
    `INSERT INTO dictations (id, ts, day, asr_text, words, text_status, audio_status, audio_attempts, audio_last_attempt_day)
     VALUES (?, ?, ?, ?, 4, 'done', ?, ?, ?)`,
  );
  seeds.forEach((s, i) => {
    insert.run(
      s.id,
      `2026-11-18 12:00:0${i}.000 +00:00`,
      s.day ?? "2026-11-18",
      s.asr === undefined ? `text for ${s.id}` : s.asr,
      s.status ?? "pending",
      s.attempts ?? 0,
      s.lastDay ?? null,
    );
  });
  return { wispr, coach };
};

type Row = { id: string; audio_status: string; audio_attempts: number; audio_last_attempt_day: string | null };
const rows = (coach: Database) =>
  coach
    .query("SELECT id, audio_status, audio_attempts, audio_last_attempt_day FROM dictations ORDER BY ts")
    .all() as Row[];

const NOTE: SoundNote = { word: "Particularly", sound: "r in the middle", tip: "say par-TIK-yuh-lee" };
const okNotes = (): Result<SoundNote[], GeminiError> => ok([NOTE]);
const apiError = (): Result<SoundNote[], GeminiError> =>
  err({ kind: "api", message: "Gemini HTTP 500" });

const run = (
  ctx: ReturnType<typeof setup>,
  gemini: ReturnType<typeof createFakeGemini>,
  budget = createBudget({}),
) => analyzeAudio({ coach: ctx.coach, wispr: ctx.wispr, gemini, budget, log, today: TODAY });

const containsBytes = (haystack: Uint8Array, needle: string) =>
  Buffer.from(haystack).includes(Buffer.from(needle));

describe("analyzeAudio", () => {
  test("INV-1: coach.sqlite, its WAL and the log hold no audio bytes after successes and errors", async () => {
    const ctx = setup([{ id: "a" }, { id: "b" }, { id: "c" }]);
    let n = 0;
    const gemini = createFakeGemini({
      handler: () => (++n === 2 ? apiError() : okNotes()),
    });

    const captured: string[] = [];
    const orig = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      out: process.stdout.write,
      errw: process.stderr.write,
    };
    const grab = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    console.log = grab;
    console.info = grab;
    console.warn = grab;
    console.error = grab;
    process.stdout.write = ((chunk: unknown) => (grab(chunk), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (grab(chunk), true)) as typeof process.stderr.write;
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(ctx, gemini);
    } finally {
      console.log = orig.log;
      console.info = orig.info;
      console.warn = orig.warn;
      console.error = orig.error;
      process.stdout.write = orig.out;
      process.stderr.write = orig.errw;
    }

    expect(result.ok).toBe(true);
    expect(rows(ctx.coach).map((r) => r.audio_status)).toEqual(["done", "failed", "done"]);
    const files = ["coach.sqlite", "coach.sqlite-wal", "coach.sqlite-shm"]
      .map((name) => join(dir, name))
      .filter(existsSync)
      .map((path) => new Uint8Array(readFileSync(path)));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const markers = [
      MARKER,
      Array.from(new TextEncoder().encode(MARKER)).join(","),
      Buffer.from(MARKER).toString("hex"),
      Buffer.from(WAV).toString("base64"),
      ...[0, 1, 2].map((pad) => Buffer.from("x".repeat(pad) + MARKER).toString("base64").slice(Math.ceil(pad / 3) * 4, -4)),
    ];
    for (const bytes of files) {
      for (const m of markers) expect(containsBytes(bytes, m)).toBe(false);
    }
    expect(logLines.length).toBeGreaterThan(0);
    const logText = logLines.join("\n");
    for (const m of markers) expect(logText.includes(m)).toBe(false);
    const capturedText = captured.join("\n");
    for (const m of markers) expect(capturedText.includes(m)).toBe(false);
  });

  test("passes the wav and the asr text to Gemini", async () => {
    const ctx = setup([{ id: "a", asr: "hello there friend" }]);
    const seen: { wav: Uint8Array; context: string }[] = [];
    const gemini = createFakeGemini({
      handler: ({ wav, context }) => {
        seen.push({ wav, context });
        return okNotes();
      },
    });

    await run(ctx, gemini);

    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0]!.wav).equals(Buffer.from(WAV))).toBe(true);
    expect(seen[0]!.context).toBe("hello there friend");
  });

  test("a null Wispr blob is skipped with no Gemini call", async () => {
    const ctx = setup([{ id: "a", audio: null }]);
    const gemini = createFakeGemini({ handler: okNotes });

    const result = await run(ctx, gemini);

    expect(gemini.calls).toBe(0);
    expect(rows(ctx.coach)[0]!.audio_status).toBe("skipped");
    expect(result.ok && result.value.skipped).toBe(1);
  });

  test("budget hit after 2 rows keeps the rest untouched and sets budgetHit", async () => {
    const ctx = setup([
      { id: "a" },
      { id: "b" },
      { id: "c", status: "failed", attempts: 2, lastDay: "2026-11-17" },
      { id: "d" },
    ]);
    const budget = createBudget({ maxAttempts: 2 });
    const gemini = createFakeGemini({
      handler: ({ budget: b }) =>
        b.take() ? okNotes() : err({ kind: "budget", message: "Gemini attempt budget spent" }),
    });

    const result = await run(ctx, gemini, budget);

    expect(gemini.calls).toBe(3);
    expect(rows(ctx.coach)).toEqual([
      { id: "a", audio_status: "done", audio_attempts: 0, audio_last_attempt_day: null },
      { id: "b", audio_status: "done", audio_attempts: 0, audio_last_attempt_day: null },
      { id: "c", audio_status: "failed", audio_attempts: 2, audio_last_attempt_day: "2026-11-17" },
      { id: "d", audio_status: "pending", audio_attempts: 0, audio_last_attempt_day: null },
    ]);
    expect(result.ok && result.value).toMatchObject({
      done: 2,
      failed: 0,
      leftPending: 2,
      budgetHit: true,
    });
  });

  test("a failure on the 5th failed day becomes skipped", async () => {
    const ctx = setup([{ id: "a", status: "failed", attempts: 4, lastDay: "2026-11-18" }]);
    const gemini = createFakeGemini({ handler: apiError });

    const result = await run(ctx, gemini);

    expect(rows(ctx.coach)[0]).toEqual({
      id: "a",
      audio_status: "skipped",
      audio_attempts: 5,
      audio_last_attempt_day: TODAY,
    });
    expect(result.ok && result.value.skipped).toBe(1);
  });

  test("a first failure sets failed, adds one attempt and records today", async () => {
    const ctx = setup([{ id: "a" }]);
    const gemini = createFakeGemini({ handler: apiError });

    const result = await run(ctx, gemini);

    expect(rows(ctx.coach)[0]).toEqual({
      id: "a",
      audio_status: "failed",
      audio_attempts: 1,
      audio_last_attempt_day: TODAY,
    });
    expect(result.ok && result.value).toMatchObject({ failed: 1, budgetHit: false });
  });

  test("a failed row that succeeds becomes done", async () => {
    const ctx = setup([{ id: "a", status: "failed", attempts: 2, lastDay: "2026-11-17" }]);
    const gemini = createFakeGemini({ handler: okNotes });

    const result = await run(ctx, gemini);

    expect(rows(ctx.coach)[0]!.audio_status).toBe("done");
    expect(result.ok && result.value).toMatchObject({ done: 1, failed: 0, budgetHit: false });
  });

  test("done and skipped rows are not sent to Gemini", async () => {
    const ctx = setup([
      { id: "a", status: "done" },
      { id: "b", status: "skipped" },
    ]);
    const gemini = createFakeGemini({ handler: okNotes });

    await run(ctx, gemini);

    expect(gemini.calls).toBe(0);
  });

  test("sound notes are saved as sound issues with the dictation's day and listed in issueDays", async () => {
    const ctx = setup([
      { id: "a", day: "2026-11-17" },
      { id: "b", day: "2026-11-18" },
      { id: "c", day: "2026-11-18" },
    ]);
    const gemini = createFakeGemini({ handler: okNotes });

    const result = await run(ctx, gemini);

    const issues = ctx.coach
      .query("SELECT dictation_id, day, kind, said, better, reason, pattern FROM issues ORDER BY id")
      .all();
    expect(issues).toEqual(
      ["a", "b", "c"].map((id, i) => ({
        dictation_id: id,
        day: i === 0 ? "2026-11-17" : "2026-11-18",
        kind: "sound",
        said: "Particularly",
        better: "r in the middle",
        reason: "say par-TIK-yuh-lee",
        pattern: "sound:particularly",
      })),
    );
    expect(result.ok && [...result.value.issueDays].sort()).toEqual(["2026-11-17", "2026-11-18"]);
  });

  test("a clip with no notes is done and adds no issue or issue day", async () => {
    const ctx = setup([{ id: "a" }]);
    const gemini = createFakeGemini({ handler: () => ok([]) });

    const result = await run(ctx, gemini);

    expect(rows(ctx.coach)[0]!.audio_status).toBe("done");
    expect(ctx.coach.query("SELECT count(*) AS n FROM issues").get()).toEqual({ n: 0 });
    expect(result.ok && result.value.issueDays).toEqual([]);
  });
});
