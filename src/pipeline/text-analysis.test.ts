import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeApi, ClaudeError, StructuredRequest } from "../clients/claude";
import { TEXT_MAX_TOKENS } from "../clients/claude";
import { openCoachDb } from "../db/coach";
import { createLogger } from "../log";
import { err } from "../result";
import { createFakeClaude } from "../testing/fake-claude";
import { TEXT_ISSUES_SCHEMA, TEXT_SYSTEM_PROMPT, analyzeText } from "./text-analysis";

const TODAY = "2026-11-19";
let dir: string;
let coach: Database;
const logLines: string[] = [];
const log = createLogger((line) => logLines.push(line));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "text-analysis-"));
  logLines.length = 0;
  const opened = openCoachDb(join(dir, "coach.sqlite"));
  if (!opened.ok) throw new Error(opened.error);
  coach = opened.value;
});

afterEach(() => {
  coach.close();
  rmSync(dir, { recursive: true, force: true });
});

const idOf = (n: number): string => `d${String(n).padStart(4, "0")}`;

type Seed = {
  id: string;
  day?: string;
  textStatus?: string;
  attempts?: number;
  lastDay?: string | null;
  asr?: string | null;
};

const seed = (s: Seed, index: number): void => {
  coach
    .query(
      `INSERT INTO dictations (id, ts, day, asr_text, words, text_status, audio_status, text_attempts, text_last_attempt_day)
       VALUES (?, ?, ?, ?, 5, ?, 'pending', ?, ?)`,
    )
    .run(
      s.id,
      `2026-11-18T10:${String(index % 60).padStart(2, "0")}:00.${String(index).padStart(4, "0")}Z`,
      s.day ?? "2026-11-18",
      s.asr === undefined ? `text for ${s.id}` : s.asr,
      s.textStatus ?? "pending",
      s.attempts ?? 0,
      s.lastDay ?? null,
    );
};

const seedMany = (n: number, over: Partial<Seed> = {}): string[] => {
  const ids = Array.from({ length: n }, (_, i) => idOf(i + 1));
  ids.forEach((id, i) => seed({ id, ...over }, i));
  return ids;
};

const idsIn = (req: StructuredRequest<unknown>): string[] => [
  ...new Set(req.user.match(/d\d{4}/g) ?? []),
];

const issue = (said: string, kind = "grammar") => ({
  kind,
  said,
  better: `better ${said}`,
  reason: `reason for ${said}`,
  pattern: `pattern:${said}`,
});

const okReply = (req: StructuredRequest<unknown>) => ({
  dictations: idsIn(req).map((id) => ({ id, issues: [] })),
});

type Row = {
  id: string;
  text_status: string;
  text_attempts: number;
  text_last_attempt_day: string | null;
};

const rows = (): Row[] =>
  coach
    .query("SELECT id, text_status, text_attempts, text_last_attempt_day FROM dictations ORDER BY id")
    .all() as Row[];

const rowOf = (id: string): Row => {
  const found = rows().find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

type Script = (req: StructuredRequest<unknown>, callIndex: number) => ClaudeError | undefined;

// The fake only yields schema/api errors, so refusal and max_tokens come from this wrapper.
const scripted = (
  script: Script,
  handler: (req: StructuredRequest<unknown>) => unknown = okReply,
): ClaudeApi & { calls: StructuredRequest<unknown>[] } => {
  const inner = createFakeClaude({ handler });
  const calls: StructuredRequest<unknown>[] = [];
  return {
    calls,
    listModelIds: () => inner.listModelIds(),
    async structured<T>(req: StructuredRequest<T>) {
      const failure = script(req as StructuredRequest<unknown>, calls.length);
      calls.push(req as StructuredRequest<unknown>);
      if (failure) return err(failure);
      return inner.structured(req);
    },
  };
};

const run = (claude: ClaudeApi) => analyzeText({ coach, claude, log, today: TODAY });

describe("analyzeText selection and chunking", () => {
  test("151 pending rows make 2 calls of 150 and 1", async () => {
    seedMany(151);
    const claude = createFakeClaude({ handler: okReply });
    const result = await run(claude);
    expect(claude.calls.map((c) => idsIn(c).length)).toEqual([150, 1]);
    expect(claude.calls.every((c) => c.maxTokens === TEXT_MAX_TOKENS)).toBe(true);
    expect(result).toEqual({ ok: true, value: { done: 151, failed: 0, skipped: 0, issueDays: [] } });
    expect(rows().every((r) => r.text_status === "done")).toBe(true);
  });

  test("failed rows from an earlier night are sent, done and skipped rows are not", async () => {
    seed({ id: "d0001", textStatus: "pending" }, 0);
    seed({ id: "d0002", textStatus: "failed", attempts: 2, lastDay: "2026-11-18" }, 1);
    seed({ id: "d0003", textStatus: "done" }, 2);
    seed({ id: "d0004", textStatus: "skipped" }, 3);
    seed({ id: "d0005", textStatus: "pending", asr: null }, 4);
    const claude = createFakeClaude({ handler: okReply });
    await run(claude);
    expect(claude.calls).toHaveLength(1);
    expect(idsIn(claude.calls[0]!)).toEqual(["d0001", "d0002"]);
    expect(rowOf("d0002").text_status).toBe("done");
    expect(rowOf("d0003").text_status).toBe("done");
    expect(rowOf("d0004").text_status).toBe("skipped");
    expect(rowOf("d0005").text_status).toBe("pending");
  });

  test("no pending or failed rows makes 0 calls", async () => {
    seed({ id: "d0001", textStatus: "done" }, 0);
    seed({ id: "d0002", textStatus: "skipped" }, 1);
    const claude = createFakeClaude({ handler: okReply });
    const result = await run(claude);
    expect(claude.calls).toHaveLength(0);
    expect(result).toEqual({ ok: true, value: { done: 0, failed: 0, skipped: 0, issueDays: [] } });
  });
});

describe("analyzeText failures", () => {
  test.each(["refusal", "schema"] as const)(
    "a %s chunk fails only its own rows while another chunk succeeds",
    async (kind) => {
      const ids = seedMany(151);
      const claude = scripted((req, i) => {
        if (i !== 0) return undefined;
        return { kind, message: "x" };
      });
      const result = await run(claude);
      const first = new Set(idsIn(claude.calls[0]!));
      expect(first.size).toBe(150);
      for (const id of ids) {
        const r = rowOf(id);
        if (first.has(id)) {
          expect(r.text_status).toBe("failed");
          expect(r.text_attempts).toBe(1);
          expect(r.text_last_attempt_day).toBe(TODAY);
        } else {
          expect(r.text_status).toBe("done");
          expect(r.text_attempts).toBe(0);
        }
      }
      expect(result).toEqual({ ok: true, value: { done: 1, failed: 150, skipped: 0, issueDays: [] } });
      expect(logLines.some((l) => l.includes(`"kind":"${kind}"`))).toBe(true);
    },
  );

  test("a reply that fails validation counts as schema and fails the chunk", async () => {
    seedMany(2);
    const claude = createFakeClaude({ handler: () => ({ nope: true }) });
    await run(claude);
    expect(rows().map((r) => [r.text_status, r.text_attempts])).toEqual([
      ["failed", 1],
      ["failed", 1],
    ]);
  });

  test("a row at 4 attempts on a new day becomes skipped", async () => {
    seed({ id: "d0001", textStatus: "failed", attempts: 4, lastDay: "2026-11-18" }, 0);
    const claude = scripted(() => ({ kind: "refusal", message: "x" }));
    const result = await run(claude);
    const r = rowOf("d0001");
    expect(r.text_status).toBe("skipped");
    expect(r.text_attempts).toBe(5);
    expect(result).toEqual({ ok: true, value: { done: 0, failed: 0, skipped: 1, issueDays: [] } });
  });

  test("a second failure on the same day adds no attempt", async () => {
    seed({ id: "d0001", textStatus: "failed", attempts: 1, lastDay: TODAY }, 0);
    const claude = scripted(() => ({ kind: "api", message: "x" }));
    await run(claude);
    const r = rowOf("d0001");
    expect(r.text_status).toBe("failed");
    expect(r.text_attempts).toBe(1);
  });
});

describe("analyzeText max_tokens split", () => {
  test("a 10-row chunk with max_tokens becomes two 5-row calls", async () => {
    seedMany(10);
    const claude = scripted((req, i) => (i === 0 ? { kind: "max_tokens", message: "x" } : undefined));
    const result = await run(claude);
    expect(claude.calls.map((c) => idsIn(c).length)).toEqual([10, 5, 5]);
    expect(idsIn(claude.calls[1]!)).toEqual([idOf(1), idOf(2), idOf(3), idOf(4), idOf(5)]);
    expect(idsIn(claude.calls[2]!)).toEqual([idOf(6), idOf(7), idOf(8), idOf(9), idOf(10)]);
    expect(result).toEqual({ ok: true, value: { done: 10, failed: 0, skipped: 0, issueDays: [] } });
  });

  test("a half that hits max_tokens again fails with no further split", async () => {
    seedMany(10);
    const claude = scripted((req, i) => (i === 0 || i === 2 ? { kind: "max_tokens", message: "x" } : undefined));
    const result = await run(claude);
    expect(claude.calls).toHaveLength(3);
    const status = rows().map((r) => r.text_status);
    expect(status.slice(0, 5)).toEqual(Array(5).fill("done"));
    expect(status.slice(5)).toEqual(Array(5).fill("failed"));
    expect(rows().slice(5).every((r) => r.text_attempts === 1)).toBe(true);
    expect(result).toEqual({ ok: true, value: { done: 5, failed: 5, skipped: 0, issueDays: [] } });
  });

  test("a 1-row chunk with max_tokens fails after exactly 1 call", async () => {
    seedMany(1);
    const claude = scripted(() => ({ kind: "max_tokens", message: "x" }));
    await run(claude);
    expect(claude.calls).toHaveLength(1);
    expect(rowOf(idOf(1))).toMatchObject({ text_status: "failed", text_attempts: 1 });
  });
});

describe("analyzeText saving issues", () => {
  test("saves every field with the dictation day, ignores unknown ids, returns issueDays", async () => {
    seed({ id: "d0001", day: "2026-11-17" }, 0);
    seed({ id: "d0002", day: "2026-11-18" }, 1);
    seed({ id: "d0003", day: "2026-11-18" }, 2);
    seed({ id: "d0008", day: "2026-11-18", textStatus: "done" }, 7);
    const claude = createFakeClaude({
      handler: () => ({
        dictations: [
          { id: "d0008", issues: [issue("outside")] },
          { id: "d0001", issues: [issue("more fast", "grammar")] },
          { id: "d0002", issues: [issue("um", "filler"), issue("big", "word")] },
          { id: "d9999", issues: [issue("ghost")] },
        ],
      }),
    });
    const result = await run(claude);
    expect(result.ok && result.value.issueDays.sort()).toEqual(["2026-11-17", "2026-11-18"]);
    const saved = coach
      .query("SELECT dictation_id, day, kind, said, better, reason, pattern FROM issues ORDER BY id")
      .all();
    expect(saved).toEqual([
      { dictation_id: "d0001", day: "2026-11-17", kind: "grammar", said: "more fast", better: "better more fast", reason: "reason for more fast", pattern: "pattern:more fast" },
      { dictation_id: "d0002", day: "2026-11-18", kind: "filler", said: "um", better: "better um", reason: "reason for um", pattern: "pattern:um" },
      { dictation_id: "d0002", day: "2026-11-18", kind: "word", said: "big", better: "better big", reason: "reason for big", pattern: "pattern:big" },
    ]);
    expect(rows().map((r) => [r.id, r.text_status])).toEqual([
      ["d0001", "done"],
      ["d0002", "done"],
      ["d0003", "failed"],
      ["d0008", "done"],
    ]);
    expect(coach.query("SELECT 1 FROM issues WHERE dictation_id = 'd0008'").all()).toHaveLength(0);
  });

  test("a row the reply leaves out is failed for a retry, not done", async () => {
    seedMany(3);
    const claude = createFakeClaude({
      handler: () => ({ dictations: [{ id: "d0002", issues: [] }] }),
    });
    const result = await run(claude);
    expect(result).toEqual({ ok: true, value: { done: 1, failed: 2, skipped: 0, issueDays: [] } });
    expect(rowOf("d0001")).toMatchObject({ text_status: "failed", text_attempts: 1, text_last_attempt_day: TODAY });
    expect(rowOf("d0002")).toMatchObject({ text_status: "done", text_attempts: 0 });
    expect(rowOf("d0003")).toMatchObject({ text_status: "failed", text_attempts: 1, text_last_attempt_day: TODAY });
  });

  test("a dictation id repeated in the reply saves its issues once", async () => {
    seedMany(1);
    const claude = createFakeClaude({
      handler: () => ({
        dictations: [
          { id: "d0001", issues: [issue("first")] },
          { id: "d0001", issues: [issue("second")] },
        ],
      }),
    });
    await run(claude);
    expect(coach.query("SELECT said FROM issues").all()).toEqual([{ said: "first" }]);
  });

  test("saved issues are findable through issues_fts", async () => {
    seedMany(1);
    const claude = createFakeClaude({
      handler: (req) => ({ dictations: [{ id: idsIn(req)[0], issues: [issue("zebrafish")] }] }),
    });
    await run(claude);
    const hit = coach
      .query("SELECT rowid FROM issues_fts WHERE issues_fts MATCH 'zebrafish'")
      .all();
    expect(hit).toHaveLength(1);
  });
});

describe("text analysis schema and prompt", () => {
  const BANNED = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"];

  const walk = (node: unknown, visit: (n: Record<string, unknown>) => void): void => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
    if (node && typeof node === "object") {
      visit(node as Record<string, unknown>);
      Object.values(node).forEach((n) => walk(n, visit));
    }
  };

  test("every object forbids extra properties and no size constraints appear", () => {
    let objects = 0;
    walk(TEXT_ISSUES_SCHEMA, (n) => {
      for (const key of BANNED) expect(Object.keys(n)).not.toContain(key);
      if (n.type === "object") {
        objects += 1;
        expect(n.additionalProperties).toBe(false);
      }
    });
    expect(objects).toBeGreaterThanOrEqual(3);
  });

  test("the schema lists the three kinds", () => {
    expect(JSON.stringify(TEXT_ISSUES_SCHEMA)).toContain('"filler"');
    expect(JSON.stringify(TEXT_ISSUES_SCHEMA)).toContain('"grammar"');
    expect(JSON.stringify(TEXT_ISSUES_SCHEMA)).toContain('"word"');
  });

  test("the system prompt tells the model not to flag imperative phrasing", () => {
    expect(TEXT_SYSTEM_PROMPT).toMatch(/imperative/i);
    expect(TEXT_SYSTEM_PROMPT).toMatch(/not flag|do not|must not/i);
    expect(TEXT_SYSTEM_PROMPT).toContain("pattern");
  });
});
