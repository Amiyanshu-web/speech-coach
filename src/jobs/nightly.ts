import type { Database } from "bun:sqlite";
import type { ClaudeApi } from "../clients/claude";
import { type Budget, type GeminiApi, createBudget } from "../clients/gemini";
import { getClaudeModel, getGeminiModels, getSkipList } from "../db/settings";
import { type OffsetOf, todayLocal } from "../domain/time";
import { type Logger, describeError } from "../log";
import { analyzeAudio } from "../pipeline/audio-analysis";
import { applySkipList, importNew } from "../pipeline/import";
import { buildLesson, lessonDaysToBuild } from "../pipeline/lesson";
import { analyzeText } from "../pipeline/text-analysis";
import type { Result } from "../result";
import { openWisprReadOnly } from "../wispr/source";
import { acquireLock } from "./lock";
import { type RunStatus, SCHEDULED_HOURS, finishRun, isFirstFailureOfStreak, runStatusOf, shouldRun, startRun } from "./runs";
import { runStartupChecks } from "./startup-checks";

const MAX_ERROR_LENGTH = 300;

export type NightlyDeps = {
  coach: Database;
  wisprPath: string;
  claude: ClaudeApi;
  gemini: GeminiApi;
  log: Logger;
  now: () => Date;
  offsetOf?: OffsetOf;
  pid: number;
  lockPath: string;
  notify: (title: string, message: string) => void;
  budget?: Budget;
  compileOptions?: () => string[];
  claudeModel?: string;
  geminiModels?: string[];
};

export type NightlyResult = { status: RunStatus | "skipped"; detail: Record<string, unknown> };

type StepResult = { ok: boolean };

export const runNightly = async (deps: NightlyDeps): Promise<NightlyResult> => {
  const { coach, log, offsetOf } = deps;
  const now = deps.now();
  const gate = shouldRun({ db: coach, kind: "nightly", now, scheduledHour: SCHEDULED_HOURS.nightly, offsetOf });
  if (!gate.run) return { status: "skipped", detail: { reason: gate.reason } };

  const lock = acquireLock({
    path: deps.lockPath,
    pid: deps.pid,
    now,
    serialize: (fn) => coach.transaction(fn).immediate(),
  });
  if (!lock.ok) return { status: "skipped", detail: { reason: lock.error } };

  const runId = startRun(coach, "nightly", now);
  const finish = (status: RunStatus, detail: Record<string, unknown>): NightlyResult => {
    finishRun(coach, runId, status, detail, deps.now());
    if (status === "failed" && isFirstFailureOfStreak(coach, "nightly", runId, deps.now())) {
      const errors = Array.isArray(detail.errors) ? (detail.errors as string[]) : [];
      deps.notify("Speech Coach", `Nightly run failed: ${errors[0] ?? "see the log"}`.slice(0, 200));
    }
    return { status, detail };
  };

  try {
    const today = todayLocal(now, offsetOf);
    const claudeModel = deps.claudeModel ?? getClaudeModel(coach);
    const geminiModels = deps.geminiModels ?? getGeminiModels(coach);
    const checks = await runStartupChecks({
      coach,
      wisprPath: deps.wisprPath,
      claude: deps.claude,
      gemini: deps.gemini,
      claudeModel,
      geminiModels,
      today,
      compileOptions: deps.compileOptions,
    });
    if (!checks.ok) {
      log.error("startup checks failed", { error: checks.error.slice(0, MAX_ERROR_LENGTH) });
      return finish("failed", { errors: [checks.error.slice(0, MAX_ERROR_LENGTH)], warnings: [] });
    }
    const warnings = checks.value.warnings;
    for (const warning of warnings) log.warn("startup check warning", { warning });

    const steps: StepResult[] = [];
    const errors: string[] = [];
    const detail: Record<string, unknown> = { warnings, errors };
    const fail = (name: string, message: string): void => {
      steps.push({ ok: false });
      const text = `${name}: ${message}`.slice(0, MAX_ERROR_LENGTH);
      errors.push(text);
      log.error("nightly step failed", { step: name, error: text });
    };
    const step = async <T>(name: string, run: () => Promise<Result<T>> | Result<T>): Promise<T | undefined> => {
      try {
        const res = await run();
        if (res.ok) return res.value;
        fail(name, res.error);
      } catch (e) {
        fail(name, describeError(e));
      }
      return undefined;
    };

    await step("skiplist", () => ({ ok: true as const, value: applySkipList({ coach, skipList: getSkipList(coach) }) }));

    const wispr = openWisprReadOnly(deps.wisprPath);
    if (!wispr.ok) fail("wispr", wispr.error);
    const wisprDb = wispr.ok ? wispr.value : null;
    try {
      if (wisprDb !== null) {
        const imported = await step("import", () =>
          importNew({ wispr: wisprDb, coach, skipList: getSkipList(coach), log }),
        );
        if (imported) Object.assign(detail, { import: imported, imported: imported.imported });
      }

      const issueDays: string[] = [];
      const text = await step("text", () => analyzeText({ coach, claude: deps.claude, log, today }));
      if (text) {
        detail.text = { done: text.done, failed: text.failed, skipped: text.skipped };
        issueDays.push(...text.issueDays);
        if (text.failed > 0) fail("text", `${text.failed} dictations failed`);
      }

      let budgetHit = false;
      if (!checks.value.audioEnabled) {
        fail("audio", "Gemini primary model not listed");
      } else if (wisprDb !== null) {
        const audio = await step("audio", () =>
          analyzeAudio({ coach, wispr: wisprDb, gemini: deps.gemini, budget: deps.budget ?? createBudget({}), log, today }),
        );
        if (audio) {
          detail.audio = { done: audio.done, failed: audio.failed, skipped: audio.skipped, leftPending: audio.leftPending };
          budgetHit = audio.budgetHit;
          issueDays.push(...audio.issueDays);
          if (audio.failed > 0) fail("audio", `${audio.failed} clips failed`);
        }
      }

      const days = lessonDaysToBuild({ coach, issueDays, today });
      const built: string[] = [];
      for (const day of days) {
        const saved = await step("lesson", () => buildLesson({ coach, claude: deps.claude, day, log }));
        if (saved === "saved") built.push(day);
      }
      detail.lessons = built;

      detail.budgetHit = budgetHit;
    } finally {
      wisprDb?.close();
    }

    return finish(runStatusOf(steps, detail.budgetHit === true), detail);
  } catch (e) {
    const message = describeError(e);
    log.error("nightly run failed", { error: message });
    return finish("failed", { errors: [message], warnings: [] });
  } finally {
    lock.value.release();
  }
};
