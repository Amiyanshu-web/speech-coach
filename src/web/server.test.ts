import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCoachDb } from "../db/coach";
import { getSkipList, setSkipList } from "../db/settings";
import { createLogger } from "../log";
import { err, ok, type Result } from "../result";
import type { WebContext } from "./html";
import { handleRequest, portFromEnv, startServer } from "./server";

let dir: string;
let db: Database;
let ctx: WebContext;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-server-"));
  const opened = openCoachDb(path.join(dir, "coach.sqlite"));
  if (!opened.ok) throw new Error(opened.error);
  db = opened.value;
  ctx = { db, now: () => new Date("2026-11-19T18:00:00Z"), port: 4777 };
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const GOOD = "127.0.0.1:4777";
const GET_ROUTES = ["/", "/calendar", "/repeats", "/search", "/settings", "/style.css", "/player.js"];

const get = (route: string, host: string) =>
  handleRequest(new Request(`http://${host}${route}`, { headers: { host } }), ctx);

const postSettings = (headers: Record<string, string>) =>
  handleRequest(
    new Request(`http://${GOOD}/settings`, {
      method: "POST",
      headers: { host: GOOD, "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ skipList: "com.example.new" }).toString(),
    }),
    ctx,
  );

describe("portFromEnv", () => {
  test("uses a valid SPEECH_COACH_PORT and falls back to 4777 for anything else", () => {
    expect(portFromEnv("4790")).toBe(4790);
    for (const bad of [undefined, "", "abc", "0", "70000", "-5", "47.5", "4790x"]) expect(portFromEnv(bad)).toBe(4777);
  });
});

describe("startServer", () => {
  test("binds 127.0.0.1 on a real port and serves / for a matching Host", async () => {
    const lines: string[] = [];
    const server = startServer({
      db,
      port: 0,
      log: createLogger((l) => lines.push(l)),
      now: () => new Date("2026-11-19T18:00:00Z"),
    });
    try {
      expect(server.hostname).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        headers: { host: `127.0.0.1:${server.port}` },
      });
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("a handler throw gives 500 with a plain message and logs only describeError output", async () => {
    const lines: string[] = [];
    const server = startServer({
      db,
      port: 0,
      log: createLogger((l) => lines.push(l)),
      now: () => new Date("2026-11-19T18:00:00Z"),
    });
    try {
      db.close();
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        headers: { host: `127.0.0.1:${server.port}` },
      });
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).toBe("Internal Server Error");
      const errors = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.level === "error");
      expect(errors).toHaveLength(1);
      const text = String(errors[0]?.error);
      expect(text).toMatch(/^\w*Error: /);
      expect(text.length).toBeLessThanOrEqual(300);
    } finally {
      server.stop(true);
    }
  });
});

describe("handleRequest", () => {
  test.each(GET_ROUTES)("GET %s returns 403 for a bad Host", async (route) => {
    expect((await get(route, "evil.example:4777")).status).toBe(403);
    expect((await get(route, "127.0.0.1:9999")).status).toBe(403);
  });

  test("POST /settings returns 403 for a bad Host", async () => {
    const res = await postSettings({ host: "evil.example:4777", origin: "http://127.0.0.1:4777" });
    expect(res.status).toBe(403);
  });

  test("POST /settings returns 403 for a cross-origin request", async () => {
    setSkipList(db, ["com.example.old"]);
    expect((await postSettings({ origin: "http://evil.example" })).status).toBe(403);
    expect((await postSettings({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(getSkipList(db)).toEqual(["com.example.old"]);
  });

  test("POST /settings with a same origin is accepted", async () => {
    const res = await postSettings({ origin: "http://127.0.0.1:4777" });
    expect(res.status).toBe(303);
  });

  test.each(GET_ROUTES)("GET %s returns 200 for a good Host", async (route) => {
    expect((await get(route, GOOD)).status).toBe(200);
    expect((await get(route, `localhost:4777`)).status).toBe(200);
  });

  test("/style.css is served as text/css", async () => {
    const res = await get("/style.css", GOOD);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  test("GET /player.js serves the player script as JavaScript", async () => {
    const res = await get("/player.js", GOOD);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("dataset.peaks");
  });

  test("player.js never sets .hidden on the svg wave, which is not an HTMLElement", async () => {
    const src = await (await get("/player.js", GOOD)).text();
    expect(src).not.toMatch(/wave\.hidden\s*=/);
    expect(src).toContain('wave.removeAttribute("hidden")');
  });

  test("player.js marks a gone or broken clip, ignores autoplay refusals, guards double init and handles the extra keys", async () => {
    const src = await (await get("/player.js", GOOD)).text();
    expect(src).toContain("Recording gone");
    expect(src).toContain('aria-disabled", "true"');
    expect(src).toContain("button.disabled = true");
    expect(src).toContain("NotAllowedError");
    expect(src).toContain("r.status === 404");
    expect(src).toContain('if (clip.dataset.ready) return;');
    for (const key of ["Home", "End", "ArrowUp", "ArrowDown", "PageUp", "PageDown"]) expect(src).toContain(`"${key}"`);
  });

  describe("GET /audio/<id>/peaks", () => {
    const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    const wavOf = (samples: number[]) => {
      const data = samples.flatMap((s) => [s & 255, (s >> 8) & 255]);
      const fmt = [...u32(16), 1, 0, 1, 0, ...u32(16000), ...u32(32000), 2, 0, 16, 0];
      const body = [..."WAVE".split("").map((c) => c.charCodeAt(0)), ..."fmt ".split("").map((c) => c.charCodeAt(0)), ...fmt, ..."data".split("").map((c) => c.charCodeAt(0)), ...u32(data.length), ...data];
      return new Uint8Array([..."RIFF".split("").map((c) => c.charCodeAt(0)), ...u32(body.length), ...body]);
    };
    const addClip = (id: string, over: { text?: string; audio?: string; issue?: boolean } = {}) => {
      db.run(
        `INSERT INTO dictations (id, ts, day, app, words, text_status, audio_status)
         VALUES (?, '2026-11-18 10:00:00.000 +00:00', '2026-11-18', 'Slack', 5, ?, ?)`,
        [id, over.text ?? "done", over.audio ?? "done"],
      );
      if (over.issue !== false) {
        db.run(
          `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern)
           VALUES (?, '2026-11-18', 'grammar', 'a', 'b', 'c', 'p')`,
          [id],
        );
      }
    };
    const getWith = (route: string, headers: Record<string, string> = {}) =>
      handleRequest(new Request(`http://${GOOD}${route}`, { headers: { host: GOOD, ...headers } }), ctx);

    test("returns 120 peaks between 0 and 1 as no-store JSON", async () => {
      addClip("abc-123");
      ctx = { ...ctx, readAudio: () => ok(wavOf(Array.from({ length: 1200 }, (_, i) => (i % 100) * 10))) };
      const res = await get("/audio/abc-123/peaks", GOOD);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const { peaks } = (await res.json()) as { peaks: number[] };
      expect(peaks).toHaveLength(120);
      expect(Math.max(...peaks)).toBe(1);
      expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0);
    });

    test("logs nothing about the audio or peaks on success", async () => {
      addClip("abc-123");
      ctx = { ...ctx, readAudio: () => ok(wavOf(Array.from({ length: 1200 }, (_, i) => i))) };
      const lines: string[] = [];
      const res = await handleRequest(
        new Request(`http://${GOOD}/audio/abc-123/peaks`, { headers: { host: GOOD } }),
        ctx,
        createLogger((l) => lines.push(l)),
      );
      expect(res.status).toBe(200);
      expect(lines).toEqual([]);
    });

    test("415 for a clip that is not 16-bit PCM WAV", async () => {
      addClip("abc-123");
      ctx = { ...ctx, readAudio: () => ok(new Uint8Array([1, 2, 3, 4])) };
      expect((await get("/audio/abc-123/peaks", GOOD)).status).toBe(415);
    });

    test("404 for an unknown, quiet or skipped clip, a bad id, a gone clip or no readAudio, without asking Wispr", async () => {
      addClip("quiet-1", { issue: false });
      addClip("skipped-1", { text: "skipped", audio: "skipped" });
      const asked: string[] = [];
      ctx = { ...ctx, readAudio: (id) => (asked.push(id), ok(wavOf([1, 2]))) };
      for (const route of ["/audio/ghost/peaks", "/audio/quiet-1/peaks", "/audio/skipped-1/peaks", "/audio/a.b/peaks", "/audio/a%2Fb/peaks", "/audio//peaks", "/audio/a/b/peaks"]) {
        expect((await get(route, GOOD)).status).toBe(404);
      }
      expect(asked).toEqual([]);
      addClip("abc-123");
      ctx = { ...ctx, readAudio: () => ok(null) };
      expect((await get("/audio/abc-123/peaks", GOOD)).status).toBe(404);
      ctx = { db, now: ctx.now, port: 4777 };
      expect((await get("/audio/abc-123/peaks", GOOD)).status).toBe(404);
    });

    test("503 when Wispr cannot be read, logging no audio or peaks", async () => {
      addClip("abc-123");
      ctx = { ...ctx, readAudio: () => err("locked") };
      const lines: string[] = [];
      const res = await handleRequest(
        new Request(`http://${GOOD}/audio/abc-123/peaks`, { headers: { host: GOOD } }),
        ctx,
        createLogger((l) => lines.push(l)),
      );
      expect(res.status).toBe(503);
      expect(lines.join("")).not.toContain("peaks\":");
    });

    test("403 for cross-site fetches and for a bad Host", async () => {
      addClip("abc-123");
      ctx = { ...ctx, readAudio: () => ok(wavOf([1, 2, 3, 4])) };
      expect((await getWith("/audio/abc-123/peaks", { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await getWith("/audio/abc-123/peaks", { "sec-fetch-site": "same-origin" })).status).toBe(200);
      expect((await get("/audio/abc-123/peaks", "evil.example:4777")).status).toBe(403);
    });
  });

  describe("GET /audio/<id>", () => {
    const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
    const addDictation = (id: string, over: { text?: string; audio?: string; issue?: boolean } = {}) => {
      db.run(
        `INSERT INTO dictations (id, ts, day, app, words, text_status, audio_status)
         VALUES (?, '2026-11-18 10:00:00.000 +00:00', '2026-11-18', 'Slack', 5, ?, ?)`,
        [id, over.text ?? "done", over.audio ?? "done"],
      );
      if (over.issue !== false) {
        db.run(
          `INSERT INTO issues (dictation_id, day, kind, said, better, reason, pattern)
           VALUES (?, '2026-11-18', 'grammar', 'a', 'b', 'c', 'p')`,
          [id],
        );
      }
    };
    const withAudio = (readAudio: (id: string) => Result<Uint8Array | null>) => {
      ctx = { ...ctx, readAudio };
    };
    const getWith = (route: string, headers: Record<string, string>) =>
      handleRequest(new Request(`http://${GOOD}${route}`, { headers: { host: GOOD, ...headers } }), ctx);

    test("serves the bytes as audio/wav with no-store and Accept-Ranges for a known id", async () => {
      addDictation("abc-123");
      const asked: string[] = [];
      withAudio((id) => (asked.push(id), ok(WAV)));
      const res = await get("/audio/abc-123", GOOD);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/wav");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(WAV);
      expect(asked).toEqual(["abc-123"]);
    });

    test("answers a byte range with 206 and Content-Range", async () => {
      addDictation("abc-123");
      withAudio(() => ok(WAV));
      const res = await getWith("/audio/abc-123", { range: "bytes=0-1" });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 0-1/7");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(WAV.slice(0, 2));
      const open = await getWith("/audio/abc-123", { range: "bytes=5-" });
      expect(open.headers.get("content-range")).toBe("bytes 5-6/7");
      const tail = await getWith("/audio/abc-123", { range: "bytes=-3" });
      expect(tail.status).toBe(206);
      expect(tail.headers.get("content-range")).toBe("bytes 4-6/7");
      expect(new Uint8Array(await tail.arrayBuffer())).toEqual(WAV.slice(4));
    });

    test("answers an unsatisfiable range with 416 and Content-Range bytes */len", async () => {
      addDictation("abc-123");
      withAudio(() => ok(WAV));
      for (const range of ["bytes=7-", "bytes=9-12", "bytes=-0"]) {
        const res = await getWith("/audio/abc-123", { range });
        expect(res.status).toBe(416);
        expect(res.headers.get("content-range")).toBe("bytes */7");
      }
    });

    test("404 for an id that is not in coach dictations, without asking Wispr", async () => {
      const asked: string[] = [];
      withAudio((id) => (asked.push(id), ok(WAV)));
      expect((await get("/audio/ghost", GOOD)).status).toBe(404);
      expect(asked).toEqual([]);
    });

    test("404 for a skip-list dictation and for a dictation with no issues, without asking Wispr", async () => {
      addDictation("skipped-1", { text: "skipped", audio: "skipped" });
      addDictation("quiet-1", { issue: false });
      const asked: string[] = [];
      withAudio((id) => (asked.push(id), ok(WAV)));
      expect((await get("/audio/skipped-1", GOOD)).status).toBe(404);
      expect((await get("/audio/quiet-1", GOOD)).status).toBe(404);
      expect(asked).toEqual([]);
    });

    test.each(["a%20b", "a.b", "a%2Fb", `${"a".repeat(65)}`, "x'--", "", "a/b"])(
      "404 for a bad id format %j",
      async (id) => {
        addDictation("abc-123");
        const asked: string[] = [];
        withAudio((i) => (asked.push(i), ok(WAV)));
        expect((await get(`/audio/${id}`, GOOD)).status).toBe(404);
        expect(asked).toEqual([]);
      },
    );

    test("404 when the clip is gone or readAudio is missing", async () => {
      addDictation("abc-123");
      withAudio(() => ok(null));
      expect((await get("/audio/abc-123", GOOD)).status).toBe(404);
      ctx = { db, now: ctx.now, port: 4777 };
      expect((await get("/audio/abc-123", GOOD)).status).toBe(404);
    });

    test("503 and one warning without bytes when Wispr cannot be read", async () => {
      addDictation("abc-123");
      withAudio(() => err("Cannot open Wispr database read-only: locked"));
      const lines: string[] = [];
      const res = await handleRequest(
        new Request(`http://${GOOD}/audio/abc-123`, { headers: { host: GOOD } }),
        ctx,
        createLogger((l) => lines.push(l)),
      );
      expect(res.status).toBe(503);
      const warns = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({ message: "wispr audio read failed", id: "abc-123" });
    });

    test("403 for a cross-site fetch, allowed for same-origin and none", async () => {
      addDictation("abc-123");
      withAudio(() => ok(WAV));
      expect((await getWith("/audio/abc-123", { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await getWith("/audio/abc-123", { "sec-fetch-site": "same-site" })).status).toBe(403);
      expect((await getWith("/audio/abc-123", { "sec-fetch-site": "same-origin" })).status).toBe(200);
      expect((await getWith("/audio/abc-123", { "sec-fetch-site": "none" })).status).toBe(200);
    });

    test("403 for a bad Host", async () => {
      addDictation("abc-123");
      withAudio(() => ok(WAV));
      expect((await get("/audio/abc-123", "evil.example:4777")).status).toBe(403);
    });
  });

  test("unknown path returns 404", async () => {
    expect((await get("/nope", GOOD)).status).toBe(404);
  });

  test("PUT /settings and POST /calendar return 404", async () => {
    const send = (method: string, route: string) =>
      handleRequest(
        new Request(`http://${GOOD}${route}`, {
          method,
          headers: { host: GOOD, origin: `http://${GOOD}` },
        }),
        ctx,
      );
    expect((await send("PUT", "/settings")).status).toBe(404);
    expect((await send("POST", "/calendar")).status).toBe(404);
  });

  test("a page that throws returns 500 with a plain message and no stack", async () => {
    db.close();
    const res = await handleRequest(
      new Request(`http://${GOOD}/`, { headers: { host: GOOD } }),
      ctx,
      createLogger(() => {}),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe("Internal Server Error");
  });
});
