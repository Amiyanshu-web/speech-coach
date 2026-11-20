import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCoachDb } from "../../db/coach";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODELS,
  getClaudeModel,
  getGeminiModels,
  getSkipList,
  setClaudeModel,
} from "../../db/settings";
import { finishRun, startRun } from "../../jobs/runs";
import type { WebContext } from "../html";
import { saveSettings, settingsPage } from "./settings";

let dir: string;
let db: Database;
let ctx: WebContext;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-page-"));
  const opened = openCoachDb(path.join(dir, "coach.sqlite"));
  if (!opened.ok) throw new Error(opened.error);
  db = opened.value;
  ctx = { db, now: () => new Date("2026-11-19T18:00:00Z"), port: 4747 };
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (fields: Record<string, string>, url = "http://127.0.0.1:4747/settings") =>
  saveSettings(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
    ctx,
  );

const get = async (url = "http://127.0.0.1:4747/settings") =>
  (await settingsPage(new Request(url), ctx)).text();

describe("saveSettings with a leftover keepDays field", () => {
  test("a keepDays field from an old form is ignored and no keep_days row is written", async () => {
    const res = await post({ keepDays: "7", skipList: "a.b.c" });
    expect(res.status).toBe(303);
    expect(getSkipList(db)).toEqual(["a.b.c"]);
    expect(db.query("SELECT value FROM settings WHERE key = 'keep_days'").get()).toBeNull();
  });
});

describe("saveSettings", () => {
  test("saves a trimmed non-empty skip list and Gemini model order", async () => {
    await post({
      skipList: "  com.a.one \r\n\r\n   \ncom.b.two\n",
      geminiModels: "gem-x, gem-y ,gem-z",
      claudeModel: "claude-test-1",
    });
    expect(getSkipList(db)).toEqual(["com.a.one", "com.b.two"]);
    expect(getGeminiModels(db)).toEqual(["gem-x", "gem-y", "gem-z"]);
    expect(getClaudeModel(db)).toBe("claude-test-1");
  });

  test("redirects 303 to /settings on success", async () => {
    const res = await post({ claudeModel: "claude-test-1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
  });

  test("an invalid model string is not saved and redirects with ?error=model", async () => {
    setClaudeModel(db, "claude-keep");
    const res = await post({
      claudeModel: "bad model!",
      geminiModels: "ok-model,bad/model",
    });
    expect(getClaudeModel(db)).toBe("claude-keep");
    expect(getGeminiModels(db)).toEqual([...DEFAULT_GEMINI_MODELS]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings?error=model");
  });

  test("an empty Gemini list is not saved", async () => {
    await post({ geminiModels: " , " });
    expect(getGeminiModels(db)).toEqual([...DEFAULT_GEMINI_MODELS]);
  });
});

describe("settingsPage", () => {
  test("shows the saved skip list and models", async () => {
    await post({
      skipList: "com.a.one\ncom.b.two",
      geminiModels: "gem-x,gem-y",
      claudeModel: "claude-test-1",
    });
    const res = await settingsPage(new Request("http://127.0.0.1:4747/settings"), ctx);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("com.a.one\ncom.b.two");
    expect(html).not.toContain("keepDays");
    expect(html.toLowerCase()).not.toContain("keep days");
    expect(html).toContain("claude-test-1");
    expect(html).toContain("gem-x,gem-y");
  });

  test("shows defaults on a fresh database", async () => {
    const html = await get();
    expect(html).toContain(DEFAULT_CLAUDE_MODEL);
    expect(html).toContain(DEFAULT_GEMINI_MODELS.join(","));
  });

  test("shows an error only when ?error=model is present", async () => {
    expect(await get()).not.toContain('role="alert"');
    const html = await get("http://127.0.0.1:4747/settings?error=model");
    expect(html).toContain('role="alert"');
    expect(html.toLowerCase()).toContain("model");
  });

  test("shows at most 10 runs, newest first", async () => {
    for (let i = 1; i <= 12; i++) {
      const at = new Date(Date.UTC(2026, 10, i, 12));
      const id = startRun(db, "nightly", at);
      finishRun(db, id, "ok", {}, new Date(at.getTime() + 1000));
    }
    const html = await get();
    expect(html.match(/<li>/g)?.length).toBe(10);
    expect(html).not.toContain("<table");
    expect(html).toContain("2026-11-12T12:00:00.000Z");
    expect(html).toContain("2026-11-03T12:00:00.000Z");
    expect(html).not.toContain("2026-11-02T12:00:00.000Z");
    expect(html.indexOf("2026-11-12T12:00:00.000Z")).toBeLessThan(
      html.indexOf("2026-11-11T12:00:00.000Z"),
    );
  });

  test("escapes stored values in the form", async () => {
    const evil = `<script>alert("x")</script>&'`;
    await post({ skipList: evil });
    setClaudeModel(db, `"><img src=x onerror=1>`);
    const html = await get();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  test("groups fields under Skip list and Models with helper text and a Save settings button", async () => {
    const html = await get();
    expect(html).toContain("<legend>Skip list</legend>");
    expect(html).toContain("<legend>Models</legend>");
    expect(html.match(/class="help"/g)?.length).toBe(3);
    expect(html).toContain('<button type="submit" class="primary">Save settings</button>');
    for (const name of ["skipList", "claudeModel", "geminiModels"]) expect(html).toContain(`name="${name}"`);
  });

  test("shows run times as local time with the raw value in title", async () => {
    finishRun(db, startRun(db, "nightly", new Date("2026-11-20T04:51:00.000Z")), "ok", {}, new Date("2026-11-20T04:52:00.000Z"));
    const html = await (await settingsPage(new Request("http://127.0.0.1:4747/settings"), { ...ctx, offsetOf: () => -330 })).text();
    expect(html).toContain('title="2026-11-20T04:51:00.000Z">20 Nov, 10:21</span> nightly');
  });

  test("shows each run as a plain line with the status in italic, failed in its own class", async () => {
    const at = new Date("2026-11-10T12:00:00Z");
    finishRun(db, startRun(db, "nightly", at), "ok", {}, at);
    finishRun(db, startRun(db, "nightly", new Date(at.getTime() + 1)), "failed", {}, at);
    startRun(db, "morning", new Date(at.getTime() + 2));
    const html = await get();
    expect(html).toContain('<em class="status status-other">ok</em>');
    expect(html).toContain('<em class="status status-failed">failed</em>');
    expect(html).toContain('<em class="status status-other">running</em>');
  });

});
