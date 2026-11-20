import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCoachDb } from "../db/coach";
import { getSetting } from "../db/settings";
import { ok } from "../result";
import { createFakeClaude } from "../testing/fake-claude";
import { createFakeGemini } from "../testing/fake-gemini";
import { createWisprFixture } from "../testing/wispr-fixture";
import { runStartupChecks } from "./startup-checks";

const CLAUDE = "claude-opus-5-5";
const PRIMARY = "gemini-3.5-flash-lite";
const FALLBACK = "gemini-3.8-flash";
const TODAY = "2026-11-19";
const TOMORROW = "2026-11-20";
const withFts5 = () => ["ENABLE_FTS5", "THREADSAFE=1"];

let dir: string;
let coach: Database;
let wisprDb: Database;
let wisprPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-checks-test-"));
  const opened = openCoachDb(path.join(dir, "coach.sqlite"));
  if (!opened.ok) throw new Error(opened.error);
  coach = opened.value;
  const fixture = createWisprFixture(dir, [{}]);
  wisprDb = fixture.db;
  wisprPath = fixture.path;
});

afterEach(() => {
  coach.close();
  wisprDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const setup = (
  opts: {
    claudeIds?: string[];
    claudeListError?: string;
    geminiIds?: string[];
    geminiListError?: string;
  } = {},
) => {
  const claude = createFakeClaude({
    handler: () => ({}),
    modelIds: opts.claudeIds ?? [CLAUDE],
    listError: opts.claudeListError,
  });
  const gemini = createFakeGemini({
    handler: () => ok([]),
    modelIds: opts.geminiIds ?? [PRIMARY, FALLBACK],
    listError: opts.geminiListError,
  });
  const run = (over: { today?: string; compileOptions?: () => string[] } = {}) =>
    runStartupChecks({
      coach,
      wisprPath,
      claude,
      gemini,
      claudeModel: CLAUDE,
      geminiModels: [PRIMARY, FALLBACK],
      today: over.today ?? TODAY,
      compileOptions: over.compileOptions ?? withFts5,
    });
  return { claude, gemini, run };
};

const expectNothingCached = () => {
  expect(getSetting(coach, "startup_check_ok")).toBeNull();
  expect(getSetting(coach, "startup_check_gemini_primary_missing")).toBeNull();
};

describe("runStartupChecks", () => {
  test("all checks pass: ok with no warnings, audio enabled, cached for today", async () => {
    const { run } = setup();
    const result = await run();
    expect(result).toEqual({ ok: true, value: { warnings: [], cached: false, audioEnabled: true } });
    expect(getSetting(coach, "startup_check_ok")).toBe(TODAY);
  });

  test("a second call on the same day makes 0 list and 0 generation calls", async () => {
    const { claude, gemini, run } = setup();
    await run();
    const listsAfterFirst = { claude: claude.listCalls, gemini: gemini.listCalls };
    expect(listsAfterFirst).toEqual({ claude: 1, gemini: 1 });
    const second = await run();
    expect(second).toEqual({ ok: true, value: { warnings: [], cached: true, audioEnabled: true } });
    expect(claude.listCalls).toBe(1);
    expect(gemini.listCalls).toBe(1);
    expect(claude.calls).toHaveLength(0);
    expect(gemini.calls).toBe(0);
  });

  test("a new today checks again", async () => {
    const { claude, gemini, run } = setup();
    await run();
    const next = await run({ today: TOMORROW });
    expect(next).toEqual({ ok: true, value: { warnings: [], cached: false, audioEnabled: true } });
    expect(claude.listCalls).toBe(2);
    expect(gemini.listCalls).toBe(2);
    expect(getSetting(coach, "startup_check_ok")).toBe(TOMORROW);
  });

  test("a missing primary Claude model returns err naming the model and caches nothing", async () => {
    const { run } = setup({ claudeIds: ["claude-haiku-5"] });
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(CLAUDE);
    expectNothingCached();
  });

  test("a Claude list error returns err with the cause and caches nothing", async () => {
    const { run } = setup({ claudeListError: "models endpoint down" });
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("models endpoint down");
    expectNothingCached();
  });

  test("a missing Wispr column returns err naming the column and caches nothing", async () => {
    wisprDb.exec("ALTER TABLE History DROP COLUMN duration");
    const { run } = setup();
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("duration");
    expectNothingCached();
  });

  test("compileOptions without ENABLE_FTS5 returns err naming FTS5 and caches nothing", async () => {
    const { run } = setup();
    const result = await run({ compileOptions: () => ["THREADSAFE=1"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("FTS5");
    expectNothingCached();
  });

  test("the default compileOptions reads pragma compile_options on coach", async () => {
    const { claude, gemini } = setup();
    const result = await runStartupChecks({
      coach,
      wisprPath,
      claude,
      gemini,
      claudeModel: CLAUDE,
      geminiModels: [PRIMARY, FALLBACK],
      today: TODAY,
    });
    expect(result.ok).toBe(true);
  });

  test("a Gemini list error is a warning, audio stays enabled, nothing is cached", async () => {
    const { gemini, run } = setup({ geminiListError: "gemini 503" });
    const result = await run();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audioEnabled).toBe(true);
      expect(result.value.cached).toBe(false);
      expect(result.value.warnings).toHaveLength(1);
    }
    expectNothingCached();
    await run();
    expect(gemini.listCalls).toBe(2);
  });

  test("a Gemini list without the primary disables audio and caches under its own key", async () => {
    const { run } = setup({ geminiIds: [FALLBACK] });
    const result = await run();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audioEnabled).toBe(false);
      expect(result.value.cached).toBe(false);
      expect(result.value.warnings.join(" ")).toContain(PRIMARY);
    }
    expect(getSetting(coach, "startup_check_gemini_primary_missing")).toBe(TODAY);
    expect(getSetting(coach, "startup_check_ok")).toBeNull();
  });

  test("after a missing primary, a second call the same day makes 0 list calls and audio stays disabled", async () => {
    const { claude, gemini, run } = setup({ geminiIds: [FALLBACK] });
    await run();
    const second = await run();
    expect(second).toEqual({
      ok: true,
      value: { warnings: ["Gemini primary model not listed (cached)"], cached: true, audioEnabled: false },
    });
    expect(claude.listCalls).toBe(1);
    expect(gemini.listCalls).toBe(1);
    expect(claude.calls).toHaveLength(0);
    expect(gemini.calls).toBe(0);
  });

  test("the missing-primary cache does not carry over to a new today", async () => {
    const { gemini, run } = setup({ geminiIds: [FALLBACK] });
    await run();
    await run({ today: TOMORROW });
    expect(gemini.listCalls).toBe(2);
  });

  test("a missing fallback model only warns, keeps audio enabled and caches", async () => {
    const { claude, gemini, run } = setup({ geminiIds: [PRIMARY] });
    const result = await run();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audioEnabled).toBe(true);
      expect(result.value.warnings.join(" ")).toContain(FALLBACK);
    }
    expect(getSetting(coach, "startup_check_ok")).toBe(TODAY);
    const second = await run();
    expect(second.ok && second.value.cached).toBe(true);
    expect(claude.listCalls).toBe(1);
    expect(gemini.listCalls).toBe(1);
  });

  test("hard failures cache nothing even when the Gemini list also lacks the primary", async () => {
    const geminiIds = [FALLBACK];
    const missingClaude = await setup({ claudeIds: ["x"], geminiIds }).run();
    expect(missingClaude.ok).toBe(false);
    expectNothingCached();

    const noFts5 = await setup({ geminiIds }).run({ compileOptions: () => ["THREADSAFE=1"] });
    expect(noFts5.ok).toBe(false);
    expectNothingCached();

    wisprDb.exec("ALTER TABLE History DROP COLUMN duration");
    const missingColumn = await setup({ geminiIds }).run();
    expect(missingColumn.ok).toBe(false);
    expectNothingCached();
  });
});
