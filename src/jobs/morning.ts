import type { Database } from "bun:sqlite";
import { type ClaudeApi, type JsonSchema, WORDS_MAX_TOKENS } from "../clients/claude";
import type { GeminiApi } from "../clients/gemini";
import { getSkipList } from "../db/settings";
import { type OffsetOf, addDays, todayLocal } from "../domain/time";
import type { Logger } from "../log";
import { applySkipList } from "../pipeline/import";
import { acquireLock } from "./lock";
import { type RunStatus, SCHEDULED_HOURS, finishRun, isFirstFailureOfStreak, shouldRun, startRun } from "./runs";
import { runStartupChecks } from "./startup-checks";

const WORD_COUNT = 5;
const FIELDS = ["word", "meaning", "example", "from_sentence"] as const;

type Word = { word: string; meaning: string; example: string; from_sentence: string };
type WordsReply = { words: Word[] };

export const WORDS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    words: {
      type: "array",
      items: {
        type: "object",
        properties: Object.fromEntries(FIELDS.map((f) => [f, { type: "string" }])),
        required: [...FIELDS],
        additionalProperties: false,
      },
    },
  },
  required: ["words"],
  additionalProperties: false,
};

const isWordsReply = (x: unknown): x is WordsReply => {
  if (typeof x !== "object" || x === null || !Array.isArray((x as WordsReply).words)) return false;
  return (x as WordsReply).words.every(
    (w) => typeof w === "object" && w !== null && FIELDS.every((f) => typeof (w as Word)[f] === "string"),
  );
};

const SYSTEM = `You are a vocabulary coach for a software professional who dictates most of their writing.
From the dictation texts and the list of words already suggested, pick ${WORD_COUNT} new English words that fit the owner's work topics and level.
For each word give: "meaning" (plain English), "example" (a sentence in the owner's work context) and "from_sentence" (a real sentence from the owner's dictations that the word would improve).
Never repeat a word from the past list. Never pick a word the owner already uses correctly in the texts.`;

export type MorningDeps = {
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
  claudeModel: string;
  geminiModels: string[];
  compileOptions?: () => string[];
};

export type MorningResult = { status: RunStatus | "skipped"; detail: Record<string, unknown> };

const pickWords = (reply: WordsReply, past: Set<string>): Word[] => {
  const seen = new Set(past);
  const out: Word[] = [];
  for (const w of reply.words) {
    const key = w.word.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...w, word: w.word.trim() });
    if (out.length === WORD_COUNT) break;
  }
  return out;
};

export const runMorning = async (deps: MorningDeps): Promise<MorningResult> => {
  const { coach, log, offsetOf, notify } = deps;
  const now = deps.now();
  const gate = shouldRun({ db: coach, kind: "morning", now, scheduledHour: SCHEDULED_HOURS.morning, offsetOf });
  if (!gate.run) return { status: "skipped", detail: { reason: gate.reason } };

  const lock = acquireLock({
    path: deps.lockPath,
    pid: deps.pid,
    now,
    serialize: (fn) => coach.transaction(fn).immediate(),
  });
  if (!lock.ok) return { status: "skipped", detail: { reason: lock.error } };

  let runId = 0;
  const finish = (status: RunStatus, detail: Record<string, unknown>): MorningResult => {
    finishRun(coach, runId, status, detail, deps.now());
    return { status, detail };
  };
  const fail = (error: string): MorningResult => {
    log.error("morning run failed", { error: error.slice(0, 300) });
    const result = finish("failed", { error: error.slice(0, 300) });
    if (isFirstFailureOfStreak(coach, "morning", runId, deps.now())) {
      notify("Speech Coach", "Morning words failed. Yesterday's words stay.");
    }
    return result;
  };

  try {
    runId = startRun(coach, "morning", now);
    const today = todayLocal(now, offsetOf);
    const checks = await runStartupChecks({
      coach,
      wisprPath: deps.wisprPath,
      claude: deps.claude,
      gemini: deps.gemini,
      claudeModel: deps.claudeModel,
      geminiModels: deps.geminiModels,
      today,
      compileOptions: deps.compileOptions,
    });
    if (!checks.ok) return fail(checks.error);
    for (const warning of checks.value.warnings) log.warn("startup check warning", { warning });

    const skipList = getSkipList(coach);
    applySkipList({ coach, skipList });
    const texts = (
      coach
        .query(
          `SELECT asr_text FROM dictations
           WHERE day >= ? AND asr_text IS NOT NULL AND (app IS NULL OR app NOT IN (${skipList.map(() => "?").join(", ")}))
           ORDER BY ts`,
        )
        .all(addDays(today, -6), ...skipList) as { asr_text: string }[]
    ).map((r) => r.asr_text);
    if (texts.length === 0) return finish("ok", { dictations: 0 });

    const pastWords = (coach.query("SELECT word FROM daily_words").all() as { word: string }[]).map((r) => r.word);
    const reply = await deps.claude.structured({
      system: SYSTEM,
      user: JSON.stringify({ dictations: texts, pastWords }),
      schema: WORDS_SCHEMA,
      maxTokens: WORDS_MAX_TOKENS,
      validate: isWordsReply,
    });
    if (!reply.ok) return fail(`claude ${reply.error.kind}: ${reply.error.message}`);

    const words = pickWords(reply.value, new Set(pastWords.map((w) => w.trim().toLowerCase())));
    if (words.length === 0) return fail("claude returned no new valid words");

    const insert = coach.prepare(
      "INSERT OR REPLACE INTO daily_words (day, word, meaning, example, from_sentence) VALUES (?, ?, ?, ?, ?)",
    );
    coach.transaction(() => {
      for (const w of words) insert.run(today, w.word, w.meaning, w.example, w.from_sentence);
    })();
    notify("Speech Coach", `${words.length} new words: ${words.map((w) => w.word).join(", ")}`);
    return finish("ok", { words: words.length });
  } catch (e) {
    return fail(e instanceof Error ? `${e.name}: ${e.message}` : "unknown error");
  } finally {
    lock.value.release();
  }
};
