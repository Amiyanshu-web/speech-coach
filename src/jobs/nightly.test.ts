import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudget, type GeminiError, type SoundNote } from "../clients/gemini";
import { openCoachDb } from "../db/coach";
import { setSkipList } from "../db/settings";
import { createLogger } from "../log";
import { LESSON_SCHEMA } from "../pipeline/lesson";
import { TEXT_ISSUES_SCHEMA } from "../pipeline/text-analysis";
import { err, ok, type Result } from "../result";
import { createFakeClaude } from "../testing/fake-claude";
import { createFakeGemini } from "../testing/fake-gemini";
import { createWisprFixture, fixtureWav, wisprTimestamp } from "../testing/wispr-fixture";
import { listRecentRuns } from "./runs";
import { runNightly, type NightlyDeps } from "./nightly";

const CLAUDE = "claude-opus-5-5";
const PRIMARY = "gemini-3.5-flash-lite";
const FALLBACK = "gemini-3.8-flash";
const SKIP_APP = "com.1password.1password";
const NOTE: SoundNote = { word: "Particularly", sound: "r in the middle", tip: "say par-TIK-yuh-lee" };
const HOUR_MS = 3_600_000;
const NIGHT_1 = new Date("2026-11-19T15:30:00Z");
const NEXT_MORNING = new Date("2026-11-20T02:30:00Z");
const NIGHT_2 = new Date("2026-11-20T15:30:00Z");
const offsetOf = () => -330;

let dir: string;
let coach: Database;
let wispr: Database;
let wisprPath: string;
let lockPath: string;
let current: Date;
const open: Database[] = [];

const at = (iso: string): string => wisprTimestamp(Date.parse(iso));

const FIXTURE_ROWS = [
  { transcriptEntityId: "old-1", timestamp: at("2026-11-10T12:00:00Z"), asrText: "this is an old dictation", status: "formatted" },
  { transcriptEntityId: "old-skip", timestamp: at("2026-11-10T12:00:01Z"), app: SKIP_APP, asrText: "secret words from a vault", status: "formatted" },
  { transcriptEntityId: "new-1", timestamp: at("2026-11-19T12:00:00Z"), asrText: "this is a fresh dictation", status: "formatted" },
  { transcriptEntityId: "new-2", timestamp: at("2026-11-19T12:00:01Z"), asrText: "another fresh dictation here", status: "formatted" },
].map((r) => ({ needsUploading: 0, audio: fixtureWav(`AUDIO-${r.transcriptEntityId}`), ...r }));

const setup = (rows: Parameters<typeof createWisprFixture>[1] = FIXTURE_ROWS) => {
  const fixture = createWisprFixture(dir, rows);
  wispr = fixture.db;
  wisprPath = fixture.path;
  const opened = openCoachDb(join(dir, "coach.sqlite"));
  if (!opened.ok) throw new Error(opened.error);
  coach = opened.value;
  open.push(wispr, coach);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nightly-"));
  lockPath = join(dir, "nightly.lock");
  current = NIGHT_1;
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const textIds = (user: string): string[] => (JSON.parse(user) as { id: string }[]).map((d) => d.id);

const LESSON = {
  items: [
    { kind: "grammar", pattern: "p", said: "s", better: "b", practice: "Practice this." },
  ],
};

const okClaude = (over: { modelIds?: string[]; listError?: string; fail?: boolean } = {}) =>
  createFakeClaude({
    modelIds: over.modelIds ?? [CLAUDE],
    listError: over.listError,
    handler: (req) => {
      if (over.fail) throw new Error("claude down");
      if (req.schema === LESSON_SCHEMA) return LESSON;
      if (req.schema === TEXT_ISSUES_SCHEMA) {
        return {
          dictations: textIds(req.user).map((id) => ({
            id,
            issues: [{ kind: "grammar", said: `said ${id}`, better: "better", reason: "why", pattern: `p:${id}` }],
          })),
        };
      }
      throw new Error("unexpected request");
    },
  });

const okGemini = (
  over: { modelIds?: string[]; listError?: string; handler?: () => Result<SoundNote[], GeminiError> } = {},
) =>
  createFakeGemini({
    modelIds: over.modelIds ?? [PRIMARY, FALLBACK],
    listError: over.listError,
    handler: over.handler ?? (() => ok([NOTE])),
  });

const harness = (
  over: {
    claude?: ReturnType<typeof okClaude>;
    gemini?: ReturnType<typeof okGemini>;
    budget?: NightlyDeps["budget"];
  } = {},
) => {
  const claude = over.claude ?? okClaude();
  const gemini = over.gemini ?? okGemini();
  const notices: { title: string; message: string }[] = [];
  const deps = (): NightlyDeps => ({
    coach,
    wisprPath,
    claude,
    gemini,
    log: createLogger(() => {}),
    now: () => current,
    offsetOf,
    pid: process.pid,
    lockPath,
    notify: (title, message) => notices.push({ title, message }),
    compileOptions: () => ["ENABLE_FTS5"],
    ...(over.budget === undefined ? {} : { budget: over.budget }),
  });
  return { claude, gemini, notices, deps, run: () => runNightly(deps()) };
};

const audioOf = (id: string): Uint8Array | null =>
  (wispr.query("SELECT audio FROM History WHERE transcriptEntityId = ?").get(id) as { audio: Uint8Array | null }).audio;
const count = (sql: string): number => (coach.query(sql).get() as { n: number }).n;
const row = (id: string) =>
  coach
    .query("SELECT text_status, audio_status, asr_text, formatted_text FROM dictations WHERE id = ?")
    .get(id) as {
    text_status: string;
    audio_status: string;
    asr_text: string | null;
    formatted_text: string | null;
  };

describe("runNightly", () => {
  test("full run imports, analyses text and sound, saves the lesson, leaves Wispr audio alone and records ok", async () => {
    setup();
    const h = harness();
    const result = await h.run();

    expect(result.status).toBe("ok");
    expect(count("SELECT COUNT(*) AS n FROM dictations")).toBe(4);
    expect(count("SELECT COUNT(*) AS n FROM issues WHERE kind = 'grammar'")).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM issues WHERE kind = 'sound'")).toBe(3);
    expect(coach.query("SELECT day FROM lessons").all()).toEqual([{ day: "2026-11-19" }]);
    for (const id of ["old-1", "old-skip", "new-1", "new-2"]) expect(audioOf(id)).not.toBeNull();
    expect(result.detail.imported).toBe(4);
    expect(result.detail).not.toHaveProperty("cleared");
    expect(result.detail).not.toHaveProperty("bytesFreed");

    const runs = listRecentRuns(coach, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe("nightly");
    expect(runs[0]!.status).toBe("ok");
    expect(JSON.parse(runs[0]!.detail!)).toEqual(JSON.parse(JSON.stringify(result.detail)));
    expect(h.notices).toHaveLength(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a run at 08:00 local the next day builds the previous day's lesson", async () => {
    setup();
    current = NEXT_MORNING;
    const h = harness();
    const result = await h.run();

    expect(result.status).toBe("ok");
    expect(coach.query("SELECT day FROM lessons").all()).toEqual([{ day: "2026-11-19" }]);
  });

  test("a second run at the same now is skipped with no calls of any kind", async () => {
    setup();
    const h = harness();
    await h.run();
    const before = {
      structured: h.claude.calls.length,
      claudeList: h.claude.listCalls,
      audio: h.gemini.calls,
      geminiList: h.gemini.listCalls,
    };

    const second = await h.run();

    expect(second.status).toBe("skipped");
    expect(h.claude.calls).toHaveLength(before.structured);
    expect(h.claude.listCalls).toBe(before.claudeList);
    expect(h.gemini.calls).toBe(before.audio);
    expect(h.gemini.listCalls).toBe(before.geminiList);
    expect(listRecentRuns(coach, 10)).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a run after the next 21:00 with no new Wispr rows makes no generation calls", async () => {
    setup();
    const h = harness();
    await h.run();
    const structured = h.claude.calls.length;
    const audio = h.gemini.calls;
    expect(structured).toBeGreaterThan(0);
    expect(audio).toBeGreaterThan(0);

    current = NIGHT_2;
    const second = await h.run();

    expect(second.status).toBe("ok");
    expect(h.claude.calls).toHaveLength(structured);
    expect(h.gemini.calls).toBe(audio);
    expect(listRecentRuns(coach, 10)).toHaveLength(2);
  });

  test("skips and leaves the lock alone when another live process holds it", async () => {
    setup();
    writeFileSync(lockPath, String(process.pid));
    const h = harness();
    const result = await runNightly({ ...h.deps(), pid: process.pid + 1 });

    expect(result.status).toBe("skipped");
    expect(listRecentRuns(coach, 10)).toHaveLength(0);
    expect(h.claude.calls).toHaveLength(0);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("a stale lock is not taken over while another connection holds the coach write lock", async () => {
    setup();
    writeFileSync(lockPath, "999999");
    const other = new Database(join(dir, "coach.sqlite"));
    open.push(other);
    coach.exec("PRAGMA busy_timeout = 0");
    other.exec("BEGIN IMMEDIATE");
    const h = harness();
    const blocked = await h.run();
    expect(blocked).toEqual({ status: "skipped", detail: { reason: "locked" } });
    expect(readFileSync(lockPath, "utf8")).toBe("999999");

    other.exec("COMMIT");
    expect((await h.run()).status).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("Claude failing fails the run but audio analysis still runs, and notifies once per streak", async () => {
    setup();
    const h = harness({ claude: okClaude({ fail: true }), gemini: okGemini({ handler: () => ok([]) }) });

    const first = await h.run();

    expect(first.status).toBe("failed");
    expect(h.gemini.calls).toBeGreaterThan(0);
    expect(row("new-1").text_status).toBe("failed");
    expect(row("new-1").audio_status).toBe("done");
    expect(audioOf("old-skip")).not.toBeNull();
    expect(h.notices).toHaveLength(1);
    expect(count("SELECT COUNT(*) AS n FROM lessons")).toBe(0);
    expect(h.claude.calls.every((c) => c.schema === TEXT_ISSUES_SCHEMA)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);

    current = new Date(NIGHT_1.getTime() + HOUR_MS);
    const second = await h.run();

    expect(second.status).toBe("failed");
    expect(listRecentRuns(coach, 10)).toHaveLength(2);
    expect(h.notices).toHaveLength(1);
  });

  test("an audio failure fails the run after text and lesson succeed, with one notification", async () => {
    setup();
    const h = harness({
      gemini: okGemini({ handler: () => err({ kind: "api", message: "gemini broke" }) }),
    });

    const result = await h.run();

    expect(result.status).toBe("failed");
    expect(row("new-1").text_status).toBe("done");
    expect(row("new-1").audio_status).toBe("failed");
    expect(coach.query("SELECT day FROM lessons").all()).toEqual([{ day: "2026-11-19" }]);
    expect(h.notices).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a thrown error is recorded as a failed run and releases the lock", async () => {
    setup();
    const claude = okClaude();
    claude.listModelIds = async () => {
      throw new Error("list exploded");
    };
    const h = harness({ claude });

    const result = await h.run();

    expect(result.status).toBe("failed");
    const runs = listRecentRuns(coach, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.finished).not.toBeNull();
    expect(h.notices).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a Gemini list lacking the primary model runs text, skips audio and fails the run", async () => {
    setup();
    const h = harness({ gemini: okGemini({ modelIds: [FALLBACK] }) });

    const result = await h.run();

    expect(result.status).toBe("failed");
    expect(h.gemini.calls).toBe(0);
    expect(row("new-1").text_status).toBe("done");
    expect(row("new-1").audio_status).toBe("pending");
    expect(JSON.stringify(result.detail)).toContain("Gemini primary model not listed");
    expect(h.notices).toHaveLength(1);
  });

  test("a Gemini list error does not stop the audio step", async () => {
    setup();
    const h = harness({ gemini: okGemini({ listError: "list down" }) });

    const result = await h.run();

    expect(result.status).toBe("ok");
    expect(h.gemini.calls).toBeGreaterThan(0);
    expect(row("new-1").audio_status).toBe("done");
  });

  test("a spent Gemini budget ends partial with no notification", async () => {
    setup();
    const budget = createBudget({ maxAttempts: 1 });
    const seen: unknown[] = [];
    const gemini = okGemini({
      handler: () => err({ kind: "budget", message: "budget spent" }),
    });
    const original = gemini.analyzeAudio;
    gemini.analyzeAudio = (input) => {
      seen.push(input.budget);
      return original(input);
    };
    const h = harness({ gemini, budget });

    const result = await h.run();

    expect(result.status).toBe("partial");
    expect(seen[0]).toBe(budget);
    expect(row("new-1").audio_status).toBe("pending");
    expect(h.notices).toHaveLength(0);
    expect(listRecentRuns(coach, 10)[0]!.status).toBe("partial");
  });

  test("a startup-check error fails the run before any generation call and notifies", async () => {
    setup();
    const h = harness({ claude: okClaude({ modelIds: ["some-other-model"] }) });

    const result = await h.run();

    expect(result.status).toBe("failed");
    expect(h.claude.calls).toHaveLength(0);
    expect(h.gemini.calls).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM dictations")).toBe(0);
    expect(audioOf("old-1")).not.toBeNull();
    expect(h.notices).toHaveLength(1);
    expect(listRecentRuns(coach, 10)[0]!.status).toBe("failed");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a skip-list change stored before the run is applied at run start", async () => {
    setup([]);
    coach
      .query(
        `INSERT INTO dictations (id, ts, day, app, asr_text, formatted_text, words, text_status, audio_status)
         VALUES ('p1', '2026-11-18 10:00:00.000 +00:00', '2026-11-18', 'com.example.secret', 'private words here', 'Private words here', 3, 'pending', 'pending')`,
      )
      .run();
    setSkipList(coach, ["com.example.secret"]);
    const h = harness();

    const result = await h.run();

    expect(result.status).toBe("ok");
    expect(row("p1")).toEqual({
      text_status: "skipped",
      audio_status: "skipped",
      asr_text: null,
      formatted_text: null,
    });
    expect(h.claude.calls).toHaveLength(0);
    expect(h.gemini.calls).toBe(0);
  });
});
