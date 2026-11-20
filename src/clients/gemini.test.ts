import { describe, expect, test } from "bun:test";
import { createLogger } from "../log";
import { createFakeFetch } from "../testing/fake-gemini";
import { createBudget, createGeminiClient } from "./gemini";

const KEY = "SENTINEL-KEY-gemini-123";
const MODELS = ["primary-model", "fallback-model"];
const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";

const wav = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0, 0, 0, 0,
  ...new TextEncoder().encode("WAVE"),
  ...new TextEncoder().encode("AUDIOMARKER-gemini"),
]);
const wavBase64 = Buffer.from(wav).toString("base64");

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const completed = (text: string) =>
  json(200, {
    status: "completed",
    steps: [{ type: "model_output", text }],
  });

const NOTES = [{ word: "Azure", sound: "ʒ", tip: "say the middle like measure" }];
const notesJson = JSON.stringify({ notes: NOTES });

const setup = (responses: Parameters<typeof createFakeFetch>[0], models = MODELS) => {
  const { fetch, requests } = createFakeFetch(responses);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const client = createGeminiClient({
    apiKey: KEY,
    models,
    log: createLogger((line) => logs.push(line)),
    fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  return { client, requests, sleeps, logs };
};

const analyze = (client: ReturnType<typeof setup>["client"], budget = createBudget({})) =>
  client.analyzeAudio({ wav, context: "I went to the Azure portal", budget });

describe("request shape", () => {
  test("posts to interactions with the three headers and the exact input array", async () => {
    const { client, requests } = setup([completed(notesJson)]);
    const result = await analyze(client);
    expect(result).toEqual({ ok: true, value: NOTES });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe(INTERACTIONS_URL);
    expect(req.method).toBe("POST");
    expect(req.headers["x-goog-api-key"]).toBe(KEY);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["api-revision"]).toBe("2026-05-20");
    const body = JSON.parse(req.body!);
    expect(body.model).toBe("primary-model");
    expect(body.input).toHaveLength(2);
    expect(body.input[0].type).toBe("text");
    expect(body.input[0].text).toContain("I went to the Azure portal");
    expect(body.input[1]).toEqual({ type: "audio", mime_type: "audio/wav", data: wavBase64 });
  });
});

describe("listModelIds", () => {
  test("follows two nextPageToken pages and strips the models/ prefix", async () => {
    const { client, requests } = setup([
      json(200, { models: [{ name: "models/a" }, { name: "models/b" }], nextPageToken: "T 1/=" }),
      json(200, { models: [{ name: "models/c" }], nextPageToken: "T2" }),
      json(200, { models: [{ name: "models/d" }] }),
    ]);
    const result = await client.listModelIds();
    expect(result).toEqual({ ok: true, value: ["a", "b", "c", "d"] });
    expect(requests.map((r) => r.url)).toEqual([
      MODELS_URL,
      `${MODELS_URL}&pageToken=T%201%2F%3D`,
      `${MODELS_URL}&pageToken=T2`,
    ]);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(requests.every((r) => r.headers["x-goog-api-key"] === KEY)).toBe(true);
  });

  test("returns err on a non-2xx list response", async () => {
    const { client } = setup([json(500, { error: { code: 500 } })]);
    const result = await client.listModelIds();
    expect(result.ok).toBe(false);
  });
});

describe("no models configured", () => {
  test("returns an api error with no HTTP call", async () => {
    const { client, requests } = setup([], []);
    const result = await analyze(client);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("no Gemini models configured");
    expect(requests).toHaveLength(0);
  });
});

describe("retry and fallback", () => {
  test.each([503, 429])("%i x4 then fallback 200 waits 30s, 60s, 120s over 5 attempts", async (status) => {
    const fail = () => json(status, { error: { code: status, message: "busy" } });
    const { client, requests, sleeps } = setup([fail, fail, fail, fail, completed(notesJson)]);
    const result = await analyze(client);
    expect(result).toEqual({ ok: true, value: NOTES });
    expect(sleeps).toEqual([30000, 60000, 120000]);
    expect(requests).toHaveLength(5);
    expect(requests.slice(0, 4).every((r) => JSON.parse(r.body!).model === "primary-model")).toBe(true);
    expect(JSON.parse(requests[4]!.body!).model).toBe("fallback-model");
  });

  test("400 returns an api error after one attempt with no sleep", async () => {
    const { client, requests, sleeps } = setup([json(400, { error: { code: 400, message: "bad" } })]);
    const result = await analyze(client);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("api");
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("503 on every model returns unavailable", async () => {
    const fail = () => json(503, { error: { code: 503 } });
    const { client, requests } = setup([fail, fail, fail, fail, fail]);
    const result = await analyze(client);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unavailable");
    expect(requests).toHaveLength(5);
  });
});

describe("budget", () => {
  test("maxAttempts 2 stops before the third attempt with a budget error", async () => {
    const fail = () => json(503, { error: { code: 503 } });
    const { client, requests } = setup([fail, fail, fail, fail, fail]);
    const result = await analyze(client, createBudget({ maxAttempts: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("budget");
    expect(requests).toHaveLength(2);
  });

  test("take is false once 60 minutes pass on the fake clock", () => {
    let nowMs = Date.UTC(2026, 10, 19, 21, 0, 0);
    const budget = createBudget({ now: () => new Date(nowMs) });
    expect(budget.take()).toBe(true);
    expect(budget.exhausted()).toBe(false);
    nowMs += 60 * 60 * 1000 + 1;
    expect(budget.take()).toBe(false);
    expect(budget.exhausted()).toBe(true);
  });

  test("take is false after 120 attempts by default", () => {
    const budget = createBudget({});
    for (let i = 0; i < 120; i++) expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    expect(budget.exhausted()).toBe(true);
  });
});

describe("parse", () => {
  test("ignores a thought step before the model_output step", async () => {
    const { client } = setup([
      json(200, {
        status: "completed",
        steps: [
          { type: "thought", text: JSON.stringify({ notes: [{ word: "WRONG", sound: "x", tip: "y" }] }) },
          { type: "model_output", text: notesJson },
        ],
      }),
    ]);
    expect(await analyze(client)).toEqual({ ok: true, value: NOTES });
  });

  test("reads notes from content[] text items", async () => {
    const { client } = setup([
      json(200, {
        status: "completed",
        steps: [
          { type: "model_output", content: [{ type: "image", text: "ignored" }, { type: "text", text: notesJson }] },
        ],
      }),
    ]);
    expect(await analyze(client)).toEqual({ ok: true, value: NOTES });
  });

  test("strips a ```json fence", async () => {
    const { client } = setup([completed("```json\n" + notesJson + "\n```")]);
    expect(await analyze(client)).toEqual({ ok: true, value: NOTES });
  });

  test("status incomplete returns an api error naming the status", async () => {
    const { client } = setup([json(200, { status: "incomplete", steps: [] })]);
    const result = await analyze(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("api");
      expect(result.error.message).toContain("incomplete");
    }
  });

  test.each(["failed", "cancelled", "requires_continuation"])("status %s returns an api error", async (status) => {
    const { client } = setup([json(200, { status, steps: [] })]);
    const result = await analyze(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("api");
      expect(result.error.message).toContain(status);
    }
  });

  test("an unknown non-completed status returns a parse error", async () => {
    const { client } = setup([json(200, { status: "weird", steps: [] })]);
    const result = await analyze(client);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("parse");
  });
});

describe("INV-1: no audio, body or key in logs", () => {
  const run = async (responses: Parameters<typeof createFakeFetch>[0]) => {
    const captured: string[] = [];
    const orig = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      out: process.stdout.write,
      errw: process.stderr.write,
    };
    const grab = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    console.log = grab;
    console.warn = grab;
    console.error = grab;
    process.stdout.write = ((chunk: unknown) => (grab(chunk), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (grab(chunk), true)) as typeof process.stderr.write;
    try {
      const { client, logs } = setup(responses);
      const result = await analyze(client);
      return { result, logs, captured };
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      process.stdout.write = orig.out;
      process.stderr.write = orig.errw;
    }
  };

  const expectClean = (texts: string[]) => {
    const all = texts.join("\n");
    expect(all).not.toContain("AUDIOMARKER");
    expect(all).not.toContain(wavBase64);
    expect(all).not.toContain(KEY);
  };

  const check = ({ result, logs, captured }: Awaited<ReturnType<typeof run>>) => {
    expect(result.ok).toBe(false);
    expectClean([...logs, ...captured, result.ok ? "" : result.error.message]);
  };

  test("503 path", async () => {
    const fail = () => json(503, { error: { code: 503, message: `echo ${wavBase64} ${KEY}` } });
    const out = await run([fail, fail, fail, fail, fail]);
    check(out);
    const all = out.logs.join("\n");
    expect(all).toContain("503");
    expect(all).toContain("primary-model");
  });

  test("400 path", async () => {
    check(await run([json(400, { error: { code: 400, message: `echo ${wavBase64} ${KEY}` } })]));
  });

  test("network throw path", async () => {
    check(
      await run([
        () => {
          throw new Error(`socket closed for ${wavBase64} AUDIOMARKER-gemini ${KEY}`);
        },
      ]),
    );
  });

  test("parse failure path", async () => {
    const out = await run([completed(`not json ${wavBase64} AUDIOMARKER-gemini ${KEY}`)]);
    check(out);
    if (!out.result.ok) expect(out.result.error.kind).toBe("parse");
  });
});

describe("request timeout", () => {
  const hanging = (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  const client = (logs: string[]) =>
    createGeminiClient({
      apiKey: KEY,
      models: MODELS,
      log: createLogger((line) => logs.push(line)),
      fetch: hanging,
      sleep: async () => {},
      timeoutMs: 10,
    });

  test("a hung audio request ends as an api error after the timeout", async () => {
    const logs: string[] = [];
    const result = await client(logs).analyzeAudio({ wav, context: "ctx", budget: createBudget({}) });
    expect(result).toEqual({ ok: false, error: { kind: "api", message: "network error calling Gemini" } });
    expect(logs.join("\n")).toContain("TimeoutError");
  });

  test("a hung models list ends as an error after the timeout", async () => {
    const result = await client([]).listModelIds();
    expect(result).toEqual({ ok: false, error: "Gemini models list failed: TimeoutError" });
  });
});
