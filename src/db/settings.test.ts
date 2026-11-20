import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCoachDb } from "./coach";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODELS,
  DEFAULT_SKIP_LIST,
  getClaudeModel,
  getGeminiModels,
  getSetting,
  getSkipList,
  setClaudeModel,
  setGeminiModels,
  setSetting,
  setSkipList,
} from "./settings";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "coach-"));
  const r = openCoachDb(path.join(dir, "coach.db"));
  if (!r.ok) throw new Error(r.error);
  db = r.value;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const rawPut = (key: string, value: string) =>
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);

describe("defaults", () => {
  test("match the design", () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5-5");
    expect(DEFAULT_GEMINI_MODELS).toEqual(["gemini-3.5-flash-lite", "gemini-3.8-flash"]);
    expect([...DEFAULT_SKIP_LIST]).toEqual([
      "com.1password.1password",
      "com.bitwarden.desktop",
      "com.apple.keychainaccess",
      "com.apple.loginwindow",
      "com.apple.MobileSMS",
      "com.tinyspeck.slackmacgap",
    ]);
  });
});

describe("a stored keep_days row from an older version", () => {
  test("is ignored: no setting reads it and the other settings are unchanged", () => {
    rawPut("keep_days", "0");
    expect(getSkipList(db)).toEqual([...DEFAULT_SKIP_LIST]);
    expect(getClaudeModel(db)).toBe(DEFAULT_CLAUDE_MODEL);
    expect(getGeminiModels(db)).toEqual([...DEFAULT_GEMINI_MODELS]);
    expect(getSetting(db, "keep_days")).toBe("0");
  });
});

describe("getSetting and setSetting", () => {
  test("returns null for a missing key", () => {
    expect(getSetting(db, "nope")).toBeNull();
  });

  test("round-trips and overwrites a value", () => {
    setSetting(db, "k", "v1");
    expect(getSetting(db, "k")).toBe("v1");
    setSetting(db, "k", "v2");
    expect(getSetting(db, "k")).toBe("v2");
  });
});

describe("skip list", () => {
  test("missing -> default", () => {
    expect(getSkipList(db)).toEqual([...DEFAULT_SKIP_LIST]);
  });

  test("round-trips a custom list", () => {
    setSkipList(db, ["com.example.a", "com.example.b"]);
    expect(getSkipList(db)).toEqual(["com.example.a", "com.example.b"]);
  });

  test("round-trips an empty list without falling back to default", () => {
    setSkipList(db, []);
    expect(getSkipList(db)).toEqual([]);
  });

  test("bad JSON -> default", () => {
    rawPut("skip_list", "{not json");
    expect(getSkipList(db)).toEqual([...DEFAULT_SKIP_LIST]);
  });

  test("valid JSON of the wrong shape -> default", () => {
    rawPut("skip_list", JSON.stringify({ a: 1 }));
    expect(getSkipList(db)).toEqual([...DEFAULT_SKIP_LIST]);
    rawPut("skip_list", JSON.stringify([1, 2]));
    expect(getSkipList(db)).toEqual([...DEFAULT_SKIP_LIST]);
  });
});

describe("claude model", () => {
  test("missing -> default", () => {
    expect(getClaudeModel(db)).toBe(DEFAULT_CLAUDE_MODEL);
  });

  test("round-trips", () => {
    setClaudeModel(db, "claude-test-1");
    expect(getClaudeModel(db)).toBe("claude-test-1");
  });

  test("a blank stored value -> default", () => {
    rawPut("claude_model", "   ");
    expect(getClaudeModel(db)).toBe(DEFAULT_CLAUDE_MODEL);
  });
});

describe("gemini models", () => {
  test("missing -> default", () => {
    expect(getGeminiModels(db)).toEqual([...DEFAULT_GEMINI_MODELS]);
  });

  test("round-trips", () => {
    setGeminiModels(db, ["g-a", "g-b"]);
    expect(getGeminiModels(db)).toEqual(["g-a", "g-b"]);
  });

  test("bad JSON -> default", () => {
    rawPut("gemini_models", "oops[");
    expect(getGeminiModels(db)).toEqual([...DEFAULT_GEMINI_MODELS]);
  });

  test("valid JSON of the wrong shape, or an empty list -> default", () => {
    rawPut("gemini_models", JSON.stringify("g-a"));
    expect(getGeminiModels(db)).toEqual([...DEFAULT_GEMINI_MODELS]);
    rawPut("gemini_models", JSON.stringify([]));
    expect(getGeminiModels(db)).toEqual([...DEFAULT_GEMINI_MODELS]);
  });
});
