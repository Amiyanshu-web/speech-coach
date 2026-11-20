import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeminiClient } from "./clients/gemini";
import { openCoachDb } from "./db/coach";
import { getSkipList } from "./db/settings";
import { runMorning, WORDS_SCHEMA } from "./jobs/morning";
import { runNightly } from "./jobs/nightly";
import { createLogger } from "./log";
import { LESSON_SCHEMA } from "./pipeline/lesson";
import { TEXT_ISSUES_SCHEMA } from "./pipeline/text-analysis";
import { createFakeClaude } from "./testing/fake-claude";
import { createFakeFetch } from "./testing/fake-gemini";
import { createWisprFixture, fixtureWav, snapshotNonAudio, wisprTimestamp } from "./testing/wispr-fixture";
import { handleRequest } from "./web/server";

const CLAUDE = "claude-opus-5-5";
const PRIMARY = "gemini-3.5-flash-lite";
const FALLBACK = "gemini-3.8-flash";
const GEMINI_KEY = "SENTINEL-GEMINI-KEY-7f3a9c";
const ERROR_BODY_MARKER = "ERRBODY-LEAK-MARKER-55";
const PORT = 4777;
const HOST = `127.0.0.1:${PORT}`;
const NIGHT_1 = new Date("2026-11-19T15:30:00Z");
const MORNING = new Date("2026-11-20T04:00:00Z");
const NIGHT_2 = new Date("2026-11-20T15:30:00Z");
const offsetOf = () => -330;
const at = (iso: string): string => wisprTimestamp(Date.parse(iso));
const ID = {
  more: "row-more-fast",
  raw: "row-raw",
  dismissed: "row-dismissed",
  sms: "row-sms",
  nullAsr: "row-null-asr",
  upload: "row-needs-uploading",
  young: "row-young",
  noAudio: "row-no-audio",
} as const;
const markerOf = (id: string): string => `AUDIOMARK-${id}-0123456789abcdef`;

const base64Variants = (marker: string): string[] =>
  [0, 1, 2].map((shift) =>
    Buffer.from(Buffer.concat([Buffer.alloc(shift, 0x41), Buffer.from(marker)])).toString("base64").slice(4, -4),
  );

const row = (id: string, ts: string, over: Record<string, unknown> = {}) => ({
  transcriptEntityId: id,
  timestamp: at(ts),
  asrText: `this is the text of ${id}`,
  status: "formatted",
  needsUploading: 0,
  audio: fixtureWav(markerOf(id)),
  ...over,
});

const fixtureRows = () => [
  row(ID.more, "2026-11-16T12:00:00Z", { asrText: "the bug is more fast than before", formattedText: "The bug is more fast than before." }),
  row(ID.raw, "2026-11-16T12:00:01Z", { status: "raw_transcript" }),
  row(ID.dismissed, "2026-11-16T12:00:02Z", { status: "dismissed" }),
  row(ID.sms, "2026-11-16T12:00:03Z", { app: "com.apple.MobileSMS" }),
  row(ID.nullAsr, "2026-11-16T12:00:04Z", { asrText: null }),
  row(ID.upload, "2026-11-16T12:00:05Z", { needsUploading: 1 }),
  row(ID.young, "2026-11-19T12:00:00Z"),
  row(ID.noAudio, "2026-11-16T12:00:06Z", { audio: null }),
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const modelList = () => json(200, { models: [PRIMARY, FALLBACK].map((m) => ({ name: `models/${m}` })) });
const interaction = () =>
  json(200, {
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify({ notes: [{ word: "Particularly", sound: "r", tip: "say par-TIK-yuh-lee" }] }) }],
      },
    ],
  });
const words = () => ({
  words: ["lucid", "terse", "salient", "cogent", "nuance"].map((w) => ({
    word: w,
    meaning: `meaning of ${w}`,
    example: `an example with ${w}`,
    from_sentence: `a sentence for ${w}`,
  })),
});
const LESSON = { items: [{ kind: "grammar", pattern: "comparative", said: "more fast", better: "faster", practice: "Say faster." }] };

let dir: string;
let coach: Database;
let wispr: Database;
let wisprPath: string;
let lockPath: string;
let nowValue: Date;
const open: Database[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-"));
  lockPath = join(dir, "job.lock");
  nowValue = NIGHT_1;
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const textIds = (user: string): { id: string; text: string }[] => JSON.parse(user) as { id: string; text: string }[];

const build = (opts: { rows?: ReturnType<typeof fixtureRows>; fetchQueue: Parameters<typeof createFakeFetch>[0]; claudeFails?: boolean }) => {
  const fixture = createWisprFixture(dir, opts.rows ?? fixtureRows());
  wispr = fixture.db;
  wisprPath = fixture.path;
  const opened = openCoachDb(join(dir, "coach.sqlite"));
  if (!opened.ok) throw new Error(opened.error);
  coach = opened.value;
  open.push(wispr, coach);

  const lines: string[] = [];
  const notices: string[] = [];
  const log = createLogger((l) => lines.push(l));
  const fake = createFakeFetch(opts.fetchQueue);
  const gemini = createGeminiClient({ apiKey: GEMINI_KEY, models: [PRIMARY, FALLBACK], log, fetch: fake.fetch, sleep: async () => {} });
  const claude = createFakeClaude({
    modelIds: [CLAUDE],
    handler: (req) => {
      if (opts.claudeFails) throw new Error("claude down");
      if (req.schema === LESSON_SCHEMA) return LESSON;
      if (req.schema === WORDS_SCHEMA) return words();
      if (req.schema === TEXT_ISSUES_SCHEMA) {
        return {
          dictations: textIds(req.user).map((d) => ({
            id: d.id,
            issues: d.text.includes("more fast")
              ? [{ kind: "grammar", said: "more fast", better: "faster", reason: "comparative", pattern: "comparative:more fast->faster" }]
              : [],
          })),
        };
      }
      throw new Error("unexpected request");
    },
  });
  const notify = (title: string, message: string) => notices.push(`${title}\n${message}`);
  const common = {
    coach,
    wisprPath,
    claude,
    gemini,
    log,
    now: () => nowValue,
    offsetOf,
    pid: process.pid,
    lockPath,
    notify,
    compileOptions: () => ["ENABLE_FTS5"],
  };
  return {
    lines,
    notices,
    claude,
    requests: fake.requests,
    nightly: (extra: Partial<Parameters<typeof runNightly>[0]> = {}) =>
      runNightly({ ...common, ...extra }),
    morning: () => runMorning({ ...common, claudeModel: CLAUDE, geminiModels: [PRIMARY, FALLBACK] }),
    web: (path: string, init: RequestInit = {}) =>
      handleRequest(
        new Request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...(init.headers as Record<string, string>) } }),
        { db: coach, now: () => nowValue, offsetOf, port: PORT },
        log,
      ),
  };
};

const audioOf = (id: string): Uint8Array | null =>
  (wispr.query("SELECT audio FROM History WHERE transcriptEntityId = ?").get(id) as { audio: Uint8Array | null }).audio;
const count = (sql: string): number => (coach.query(sql).get() as { n: number }).n;
const analysisPosts = (requests: { method: string }[]): number => requests.filter((r) => r.method === "POST").length;

const captureOutput = () => {
  const chunks: string[] = [];
  const grab = (...a: unknown[]) => {
    chunks.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    return true;
  };
  const spies = [
    spyOn(process.stdout, "write").mockImplementation(grab as never),
    spyOn(process.stderr, "write").mockImplementation(grab as never),
    spyOn(console, "log").mockImplementation(grab as never),
    spyOn(console, "error").mockImplementation(grab as never),
    spyOn(console, "warn").mockImplementation(grab as never),
  ];
  return { chunks, restore: () => spies.forEach((s) => s.mockRestore()) };
};

const fullFlowQueue = (opts: { with400: boolean }) => [
  modelList, // nightly startup check
  json(503, { error: { code: 503, message: ERROR_BODY_MARKER } }),
  interaction(), // more-fast row after the 503
  opts.with400 ? json(400, { error: { code: 400, message: ERROR_BODY_MARKER } }) : interaction(), // raw row
  interaction(), // needsUploading row
  interaction(), // young row
  modelList, // morning startup check (new day)
  modelList, // third nightly startup check (new day)
];

describe("end to end: the whole user flow", () => {
  test("nightly, morning and the website work on a fixture Wispr database", async () => {
    const h = build({ fetchQueue: fullFlowQueue({ with400: true }) });
    const night = await h.nightly();
    expect(night.status).toBe("failed");
    expect(night.detail.errors).toEqual(["audio: 1 clips failed"]);

    expect(count("SELECT COUNT(*) AS n FROM issues WHERE kind = 'grammar'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM issues WHERE kind = 'sound'")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM lessons WHERE day = '2026-11-16'")).toBe(1);

    nowValue = MORNING;
    const morning = await h.morning();
    expect(morning.status).toBe("ok");
    expect(count("SELECT COUNT(*) AS n FROM daily_words")).toBe(5);
    const wordNotices = h.notices.filter((n) => n.includes("new words"));
    expect(wordNotices).toHaveLength(1);

    const issueDay = await (await h.web("/?day=2026-11-16")).text();
    expect(issueDay).toContain("more fast");
    expect(issueDay).toContain("faster");
    expect(issueDay).toContain("Lesson");
    const todayHtml = await (await h.web("/")).text();
    for (const w of ["lucid", "terse", "salient", "cogent", "nuance"]) expect(todayHtml).toContain(w);

    const search = await h.web("/search?q=more%20fast");
    expect(search.status).toBe(200);
    expect(await search.text()).toContain("more");
    expect((await h.web("/calendar")).status).toBe(200);
    expect((await h.web("/repeats")).status).toBe(200);
  });
});

describe("end to end: INV-1 no audio bytes in anything written or printed", () => {
  test("after a flow with one 503 and one 400, no marker or base64 is in the database, logs, output or notices", async () => {
    const out = captureOutput();
    let h!: ReturnType<typeof build>;
    try {
      h = build({ fetchQueue: fullFlowQueue({ with400: true }) });
      await h.nightly();
      nowValue = MORNING;
      await h.morning();
      await h.web("/");
      await h.web("/search?q=more");
    } finally {
      out.restore();
    }
    expect(h.requests.filter((r) => r.method === "POST").length).toBeGreaterThanOrEqual(5);
    expect(h.lines.some((l) => l.includes("gemini http error"))).toBe(true);

    const files = [join(dir, "coach.sqlite"), join(dir, "coach.sqlite-wal"), join(dir, "coach.sqlite-shm")].filter(existsSync);
    expect(files.length).toBeGreaterThan(0);
    const bytes = files.map((f) => readFileSync(f));
    const texts = [h.lines.join("\n"), out.chunks.join("\n"), h.notices.join("\n")];
    const needles = Object.values(ID).flatMap((id) => [markerOf(id), ...base64Variants(markerOf(id))]);
    for (const needle of needles) {
      for (const b of bytes) expect(b.includes(needle)).toBe(false);
      for (const t of texts) expect(t.includes(needle)).toBe(false);
    }
    for (const t of texts) {
      expect(t.includes(ERROR_BODY_MARKER)).toBe(false);
      expect(t.includes(GEMINI_KEY)).toBe(false);
    }
    for (const b of bytes) expect(b.includes(GEMINI_KEY)).toBe(false);
  });
});

describe("end to end: INV-2 Wispr is never written", () => {
  test("a full nightly run leaves every Wispr row and audio byte unchanged", async () => {
    const h = build({ fetchQueue: fullFlowQueue({ with400: true }) });
    const before = snapshotNonAudio(wispr);
    const audioBefore = Object.values(ID).map((id) => audioOf(id)?.join(",") ?? null);
    const rowCount = (wispr.query("SELECT COUNT(*) AS n FROM History").get() as { n: number }).n;
    const night = await h.nightly();
    expect(night.detail).not.toHaveProperty("cleared");
    expect(night.detail).not.toHaveProperty("bytesFreed");

    expect(Object.values(ID).map((id) => audioOf(id)?.join(",") ?? null)).toEqual(audioBefore);
    expect(snapshotNonAudio(wispr)).toBe(before);
    expect((wispr.query("SELECT COUNT(*) AS n FROM History").get() as { n: number }).n).toBe(rowCount);
  });
});

describe("end to end: idempotence, settings and the skip list", () => {
  test("a second nightly run makes no analysis calls, at the same time and after the next 21:00", async () => {
    const h = build({ fetchQueue: fullFlowQueue({ with400: false }) });
    expect((await h.nightly()).status).toBe("ok");
    nowValue = MORNING;
    await h.morning();
    const claudeCalls = h.claude.calls.length;
    const posts = analysisPosts(h.requests);

    nowValue = NIGHT_1;
    const same = await h.nightly();
    expect(same.status).toBe("skipped");
    expect(h.claude.calls.length).toBe(claudeCalls);
    expect(analysisPosts(h.requests)).toBe(posts);

    nowValue = NIGHT_2;
    const next = await h.nightly();
    expect(next.status).toBe("ok");
    expect(h.claude.calls.length).toBe(claudeCalls);
    expect(analysisPosts(h.requests)).toBe(posts);
  });

  test("POST /settings saves the skip list with a good Origin and returns 403 with a bad Origin", async () => {
    const h = build({ fetchQueue: [] });
    const post = (origin: string, skipList: string) =>
      h.web("/settings", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin },
        body: new URLSearchParams({ skipList }).toString(),
      });
    const before = getSkipList(coach);
    const bad = await post("http://evil.example", "com.example.evil");
    expect(bad.status).toBe(403);
    expect(getSkipList(coach)).toEqual(before);
    const good = await post(`http://${HOST}`, "com.example.good");
    expect(good.status).toBe(303);
    expect(getSkipList(coach)).toEqual(["com.example.good"]);
  });

  test("a skip-list change by POST turns a pending row skipped on the next nightly run", async () => {
    const rows = [row("row-app", "2026-11-18T12:00:00Z", { app: "com.example.chat", asrText: "a few words to say here" })];
    const h = build({ rows, claudeFails: true, fetchQueue: [modelList, modelList] });
    await h.nightly({ budget: { take: () => false, exhausted: () => true } });
    const state = () =>
      coach.query("SELECT text_status, audio_status, asr_text FROM dictations WHERE id = 'row-app'").get() as {
        text_status: string;
        audio_status: string;
        asr_text: string | null;
      };
    expect(state().audio_status).toBe("pending");
    expect(state().text_status).not.toBe("skipped");

    const res = await h.web("/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://${HOST}` },
      body: new URLSearchParams({ skipList: "com.example.chat" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(getSkipList(coach)).toEqual(["com.example.chat"]);

    nowValue = NIGHT_2;
    const callsBefore = h.claude.calls.length;
    await h.nightly({ budget: { take: () => false, exhausted: () => true } });
    expect(state()).toEqual({ text_status: "skipped", audio_status: "skipped", asr_text: null });
    expect(h.claude.calls.slice(callsBefore).some((c) => c.user.includes("row-app"))).toBe(false);
    expect(analysisPosts(h.requests)).toBe(0);
  });
});
