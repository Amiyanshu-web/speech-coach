import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoachDb } from "../db/coach";
import { createLogger } from "../log";
import { LESSON_MAX_TOKENS } from "../clients/claude";
import { createFakeClaude } from "../testing/fake-claude";
import { LESSON_SCHEMA, buildLesson, lessonDaysToBuild } from "./lesson";

const DAY = "2026-11-19";
let dir: string;
let coach: Database;
const log = createLogger(() => {});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lesson-"));
  const r = openCoachDb(join(dir, "coach.sqlite"));
  if (!r.ok) throw new Error(r.error);
  coach = r.value;
});

afterEach(() => {
  coach.close();
  rmSync(dir, { recursive: true, force: true });
});

let nextId = 0;
const addIssue = (day: string, kind: string, pattern: string, said = `said-${pattern}`) => {
  const id = `d${nextId++}`;
  coach
    .query(
      "INSERT INTO dictations (id, ts, day, words, text_status, audio_status) VALUES (?, ?, ?, 5, 'done', 'done')",
    )
    .run(id, `${day} 10:00:00.000 +00:00`, day);
  coach
    .query(
      "INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern) VALUES (?, ?, ?, ?, 'better', 'why', ?)",
    )
    .run(id, day, kind, said, pattern);
};

const addLesson = (day: string) =>
  coach.query("INSERT INTO lessons (day, json) VALUES (?, '{}')").run(day);

const item = (kind: string) => ({
  kind,
  pattern: `p-${kind}`,
  said: "said",
  better: "better",
  practice: "Practice this sentence.",
});
const REPLY = { items: [item("grammar"), item("grammar"), item("word"), item("word"), item("sound")] };

const lessonRows = () => coach.query("SELECT day, json FROM lessons").all() as { day: string; json: string }[];

describe("buildLesson", () => {
  test("saves the validated reply after one call", async () => {
    addIssue(DAY, "grammar", "subject-verb");
    const claude = createFakeClaude({ handler: () => REPLY });
    const result = await buildLesson({ coach, claude, day: DAY, log });
    expect(result).toEqual({ ok: true, value: "saved" });
    expect(claude.calls).toHaveLength(1);
    expect(lessonRows()).toEqual([{ day: DAY, json: JSON.stringify(REPLY) }]);
  });

  test("a second call for the same day makes no call and returns exists", async () => {
    addIssue(DAY, "grammar", "subject-verb");
    const claude = createFakeClaude({ handler: () => REPLY });
    await buildLesson({ coach, claude, day: DAY, log });
    const second = await buildLesson({ coach, claude, day: DAY, log });
    expect(second).toEqual({ ok: true, value: "exists" });
    expect(claude.calls).toHaveLength(1);
  });

  test("a day with no issues makes no call and returns no-issues", async () => {
    addIssue("2026-11-18", "grammar", "other-day");
    const claude = createFakeClaude({ handler: () => REPLY });
    const result = await buildLesson({ coach, claude, day: DAY, log });
    expect(result).toEqual({ ok: true, value: "no-issues" });
    expect(claude.calls).toHaveLength(0);
    expect(lessonRows()).toEqual([]);
  });

  test("sends the day's issues and the 30-day patterns, not older ones", async () => {
    addIssue(DAY, "grammar", "today-pattern", "said-today-unique");
    addIssue("2026-11-10", "word", "recent-pattern");
    addIssue("2026-10-21", "word", "edge-pattern");
    addIssue("2026-10-20", "word", "thirty-days-pattern");
    addIssue("2026-10-19", "word", "stale-pattern");
    const claude = createFakeClaude({ handler: () => REPLY });
    await buildLesson({ coach, claude, day: DAY, log });
    const req = claude.calls[0]!;
    const sent = `${req.system}\n${req.user}`;
    expect(sent).toContain("said-today-unique");
    expect(sent).toContain("recent-pattern");
    expect(sent).toContain("edge-pattern");
    expect(sent).not.toContain("thirty-days-pattern");
    expect(sent).not.toContain("stale-pattern");
  });

  test("a Claude error returns err and saves nothing", async () => {
    addIssue(DAY, "grammar", "subject-verb");
    const claude = createFakeClaude({
      handler: () => {
        throw new Error("boom");
      },
    });
    const result = await buildLesson({ coach, claude, day: DAY, log });
    expect(result.ok).toBe(false);
    expect(lessonRows()).toEqual([]);
  });

  test("a reply that fails validation returns err and saves nothing", async () => {
    addIssue(DAY, "grammar", "subject-verb");
    const claude = createFakeClaude({ handler: () => ({ items: [{ kind: "grammar" }] }) });
    const result = await buildLesson({ coach, claude, day: DAY, log });
    expect(result.ok).toBe(false);
    expect(lessonRows()).toEqual([]);
  });

  test("the request carries the schema and the lesson token limit", async () => {
    addIssue(DAY, "grammar", "subject-verb");
    const claude = createFakeClaude({ handler: () => REPLY });
    await buildLesson({ coach, claude, day: DAY, log });
    expect(claude.calls[0]!.schema).toBe(LESSON_SCHEMA);
    expect(claude.calls[0]!.maxTokens).toBe(LESSON_MAX_TOKENS);
  });
});

describe("LESSON_SCHEMA", () => {
  test("forbids extra properties on the object and on each item", () => {
    const schema = LESSON_SCHEMA as {
      additionalProperties: boolean;
      properties: { items: { items: { additionalProperties: boolean } } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.items.items.additionalProperties).toBe(false);
  });
});

describe("lessonDaysToBuild", () => {
  const today = "2026-11-19";

  test("drops days older than 7 days and days with a lesson, keeps yesterday, sorts ascending", () => {
    addLesson("2026-11-17");
    const days = lessonDaysToBuild({
      coach,
      today,
      issueDays: ["2026-11-18", "2026-11-17", "2026-11-13", "2026-11-12", "2026-11-19"],
    });
    expect(days).toEqual(["2026-11-13", "2026-11-18", "2026-11-19"]);
  });

  test("returns an empty list when every day is covered or too old", () => {
    addLesson("2026-11-19");
    expect(lessonDaysToBuild({ coach, today, issueDays: ["2026-11-19", "2026-11-01"] })).toEqual([]);
  });
});
