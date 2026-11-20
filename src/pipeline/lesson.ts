import type { Database } from "bun:sqlite";
import { type ClaudeApi, type JsonSchema, LESSON_MAX_TOKENS, describeClaudeError } from "../clients/claude";
import { addDays } from "../domain/time";
import type { Logger } from "../log";
import { type Result, err, ok } from "../result";

const KINDS = ["grammar", "word", "sound"] as const;
const FIELDS = ["pattern", "said", "better", "practice"] as const;

type LessonItem = { kind: (typeof KINDS)[number]; pattern: string; said: string; better: string; practice: string };
type Lesson = { items: LessonItem[] };

export const LESSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...KINDS] },
          pattern: { type: "string" },
          said: { type: "string" },
          better: { type: "string" },
          practice: { type: "string" },
        },
        required: ["kind", ...FIELDS],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

const isItem = (x: unknown): x is LessonItem =>
  isRecord(x) &&
  KINDS.some((k) => k === x.kind) &&
  FIELDS.every((f) => typeof x[f] === "string");

const isLesson = (x: unknown): x is Lesson => isRecord(x) && Array.isArray(x.items) && x.items.every(isItem);

const SYSTEM =
  "You are a speech coach. From the day's issues and the recent pattern counts, pick 2 grammar, 2 word and 1 sound item that matter most, repeats first. Use fewer when a kind has none. Write one practice sentence for each.";

type IssueRow = { kind: string; said: string; better: string; reason: string; pattern: string };
type PatternRow = { pattern: string; kind: string; days: number };

export const buildLesson = async ({
  coach,
  claude,
  day,
  log,
}: {
  coach: Database;
  claude: ClaudeApi;
  day: string;
  log: Logger;
}): Promise<Result<"saved" | "exists" | "no-issues">> => {
  try {
    if (coach.query("SELECT 1 FROM lessons WHERE day = ?").get(day)) return ok("exists");
    const issues = coach
      .query("SELECT kind, said, better, reason, pattern FROM issues WHERE day = ? ORDER BY id")
      .all(day) as IssueRow[];
    if (issues.length === 0) return ok("no-issues");
    const patterns = coach
      .query(
        `SELECT pattern, kind, COUNT(DISTINCT day) AS days FROM issues
         WHERE day >= ? AND day <= ? GROUP BY pattern, kind ORDER BY days DESC, pattern`,
      )
      .all(addDays(day, -29), day) as PatternRow[];
    const user = JSON.stringify({ day, issues, patterns_last_30_days: patterns });
    const reply = await claude.structured({
      system: SYSTEM,
      user,
      schema: LESSON_SCHEMA,
      maxTokens: LESSON_MAX_TOKENS,
      validate: isLesson,
    });
    if (!reply.ok) {
      log.error("lesson request failed", { day, kind: reply.error.kind });
      return err(reply.error.message);
    }
    coach.query("INSERT INTO lessons (day, json) VALUES (?, ?)").run(day, JSON.stringify(reply.value));
    return ok("saved");
  } catch (e) {
    const message = describeClaudeError(e);
    log.error("lesson step failed", { day, error: message });
    return err(message);
  }
};

export const lessonDaysToBuild = ({
  coach,
  issueDays,
  today,
}: {
  coach: Database;
  issueDays: string[];
  today: string;
}): string[] => {
  const oldest = addDays(today, -6);
  const has = coach.query("SELECT 1 FROM lessons WHERE day = ?");
  return [...new Set(issueDays)]
    .filter((d) => d >= oldest && d <= today && !has.get(d))
    .sort();
};
