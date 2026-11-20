import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../log";
import { createFakeClaude } from "../testing/fake-claude";
import {
  type ClaudeApi,
  type ClaudeSdkLike,
  LESSON_MAX_TOKENS,
  TEXT_MAX_TOKENS,
  WORDS_MAX_TOKENS,
  createClaudeClient,
  describeClaudeError,
} from "./claude";

const MODEL = "claude-opus-5-5";
const SENTINEL_KEY = "sk-ant-SENTINEL-KEY-123";
const SENTINEL_BODY = "SENTINEL-BODY-do-not-log";
const SCHEMA = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };

type Item = { n: number };
const isItem = (x: unknown): x is Item =>
  typeof x === "object" && x !== null && typeof (x as { n?: unknown }).n === "number";

type FakeMessage = { stop_reason: string; content: Record<string, unknown>[] };
const textMessage = (text: string, stop_reason = "end_turn"): FakeMessage => ({
  stop_reason,
  content: [{ type: "text", text }],
});

const makeSdk = (
  respond: (body: Record<string, unknown>) => FakeMessage | Promise<FakeMessage>,
  modelPages: string[][] = [],
) => {
  const bodies: Record<string, unknown>[] = [];
  const sdk = {
    messages: {
      stream: (body: Record<string, unknown>) => {
        bodies.push(body);
        return { finalMessage: async () => respond(body) };
      },
    },
    models: {
      list: () =>
        (async function* () {
          for (const page of modelPages) for (const id of page) yield { id };
        })(),
    },
  } as unknown as ClaudeSdkLike;
  return { sdk, bodies };
};

const setup = (
  respond: (body: Record<string, unknown>) => FakeMessage | Promise<FakeMessage>,
  modelPages: string[][] = [],
) => {
  const lines: string[] = [];
  const log = createLogger((line) => lines.push(line));
  const { sdk, bodies } = makeSdk(respond, modelPages);
  const claude = createClaudeClient({ apiKey: SENTINEL_KEY, model: MODEL, log, sdk });
  return { claude, bodies, lines };
};

const request = (maxTokens = 1234) => ({
  system: "sys prompt",
  user: "user prompt",
  schema: SCHEMA,
  maxTokens,
  validate: isItem,
});

describe("constants", () => {
  test("max token budgets match the plan", () => {
    expect(TEXT_MAX_TOKENS).toBe(32000);
    expect(LESSON_MAX_TOKENS).toBe(32000);
    expect(WORDS_MAX_TOKENS).toBe(8000);
  });
});

describe("structured request shape", () => {
  test("sends model, max_tokens, system, one user message and json_schema output_config", async () => {
    const { claude, bodies } = setup(() => textMessage('{"n":1}'));
    await claude.structured(request(1234));
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(1234);
    expect(body.system).toBe("sys prompt");
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
    expect(body.output_config).toEqual({
      format: { type: "json_schema", schema: SCHEMA },
      effort: "medium",
    });
  });

  test("sends no fallbacks or betas key (no server-side fallback model)", async () => {
    const { claude, bodies } = setup(() => textMessage('{"n":1}'));
    await claude.structured(request());
    const body = bodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("fallbacks");
    expect(body).not.toHaveProperty("betas");
  });

  test("sends no parameter that disables thinking or sets sampling", async () => {
    const { claude, bodies } = setup(() => textMessage('{"n":1}'));
    await claude.structured(request());
    const body = bodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("temperature");
    expect(JSON.stringify(body)).not.toContain("disabled");
  });
});

describe("structured response handling", () => {
  test("returns the validated value for a text block", async () => {
    const { claude } = setup(() => textMessage('{"n":7}'));
    expect(await claude.structured(request())).toEqual({ ok: true, value: { n: 7 } });
  });

  test("parses the text block when a thinking block comes first", async () => {
    const { claude } = setup(() => ({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "not json {", signature: "sig" },
        { type: "text", text: '{"n":9}' },
      ],
    }));
    expect(await claude.structured(request())).toEqual({ ok: true, value: { n: 9 } });
  });

  test("concatenates several text blocks in order before parsing", async () => {
    const { claude } = setup(() => ({
      stop_reason: "end_turn",
      content: [
        { type: "text", text: '{"n":' },
        { type: "thinking", thinking: "x", signature: "s" },
        { type: "text", text: "42}" },
      ],
    }));
    expect(await claude.structured(request())).toEqual({ ok: true, value: { n: 42 } });
  });

  test("refusal gives a refusal error without parsing the text", async () => {
    let validated = false;
    const { claude } = setup(() => textMessage('{"n":1}', "refusal"));
    const result = await claude.structured({
      ...request(),
      validate: (x): x is Item => {
        validated = true;
        return isItem(x);
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("refusal");
    expect(validated).toBe(false);
  });

  test("max_tokens gives a max_tokens error without parsing a truncated body", async () => {
    const { claude } = setup(() => textMessage('{"n":', "max_tokens"));
    const result = await claude.structured(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("max_tokens");
  });

  test("non-JSON text gives a schema error", async () => {
    const { claude } = setup(() => textMessage("not json"));
    const result = await claude.structured(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema");
  });

  test("a validator failure gives a schema error", async () => {
    const { claude } = setup(() => textMessage('{"n":"x"}'));
    const result = await claude.structured(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema");
  });

  test("a response with no text block gives a schema error", async () => {
    const { claude } = setup(() => ({ stop_reason: "end_turn", content: [] }));
    const result = await claude.structured(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("schema");
  });

  test("an SDK throw gives an api error", async () => {
    const { claude } = setup(() => {
      throw new Error("connection reset");
    });
    const result = await claude.structured(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("api");
  });
});

describe("describeClaudeError", () => {
  const apiError = () =>
    new Anthropic.APIError(
      529,
      { type: "error", error: { type: "overloaded_error", message: SENTINEL_BODY } },
      `529 ${SENTINEL_BODY}`,
      new Headers(),
    );

  test("returns only status and error type for an APIError", () => {
    const text = describeClaudeError(apiError());
    expect(text).toBe("529 overloaded_error");
    expect(text).not.toContain(SENTINEL_BODY);
  });

  test("an APIConnectionError without a status gives a plain description", () => {
    const text = describeClaudeError(new Anthropic.APIConnectionError({ message: SENTINEL_BODY }));
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
    expect(text).not.toContain(SENTINEL_BODY);
    expect(text.length).toBeGreaterThan(0);
  });

  test("falls back to describeError for other values", () => {
    expect(describeClaudeError(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeClaudeError("str")).toBe("non-Error thrown: string");
  });

  test("an APIError body never reaches the log or the returned error", async () => {
    const { claude, lines } = setup(() => {
      throw apiError();
    });
    const result = await claude.structured(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("api");
      expect(result.error.message).toContain("overloaded_error");
      expect(result.error.message).not.toContain(SENTINEL_BODY);
    }
    expect(lines.join("\n")).toContain("overloaded_error");
    expect(lines.join("\n")).not.toContain(SENTINEL_BODY);
  });
});

describe("secrets", () => {
  test("the API key never appears in logs or the returned error after an SDK throw", async () => {
    const { claude, lines } = setup(() => {
      throw new Error("connection reset");
    });
    const result = await claude.structured(request());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_KEY);
  });

  test("the user prompt body never appears in logs on failure", async () => {
    const { claude, lines } = setup(() => textMessage("not json"));
    await claude.structured({ ...request(), user: "PRIVATE-TRANSCRIPT-TEXT" });
    expect(lines.join("\n")).not.toContain("PRIVATE-TRANSCRIPT-TEXT");
  });
});

describe("listModelIds", () => {
  test("returns ids from every page", async () => {
    const { claude } = setup(() => textMessage("{}"), [["claude-opus-5-5", "claude-sonnet-5-5"], ["claude-haiku-5-5"]]);
    expect(await claude.listModelIds()).toEqual({
      ok: true,
      value: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    });
  });

  test("an SDK throw while listing gives an err result without the body", async () => {
    const lines: string[] = [];
    const sdk = {
      messages: { stream: () => ({ finalMessage: async () => textMessage("{}") }) },
      models: {
        list: () => {
          throw new Anthropic.APIError(
            401,
            { type: "error", error: { type: "authentication_error", message: SENTINEL_BODY } },
            SENTINEL_BODY,
            new Headers(),
          );
        },
      },
    } as unknown as ClaudeSdkLike;
    const claude = createClaudeClient({
      apiKey: SENTINEL_KEY,
      model: MODEL,
      log: createLogger((l) => lines.push(l)),
      sdk,
    });
    const result = await claude.listModelIds();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(SENTINEL_BODY);
    expect(lines.join("\n")).not.toContain(SENTINEL_BODY);
  });
});

describe("listModelIds iteration failure", () => {
  test("a throw during async iteration gives err without the body", async () => {
    const lines: string[] = [];
    const sdk = {
      messages: { stream: () => ({ finalMessage: async () => textMessage("{}") }) },
      models: {
        list: () =>
          (async function* () {
            yield { id: "claude-opus-5-5" };
            throw new Anthropic.APIError(
              500,
              { type: "error", error: { type: "api_error", message: SENTINEL_BODY } },
              SENTINEL_BODY,
              new Headers(),
            );
          })(),
      },
    } as unknown as ClaudeSdkLike;
    const claude = createClaudeClient({
      apiKey: SENTINEL_KEY,
      model: MODEL,
      log: createLogger((l) => lines.push(l)),
      sdk,
    });
    const result = await claude.listModelIds();
    expect(result).toEqual({ ok: false, error: "500 api_error" });
    expect(lines.join("\n")).not.toContain(SENTINEL_BODY);
  });
});

describe("createFakeClaude", () => {
  test("satisfies ClaudeApi, records calls and validates handler output", async () => {
    const fake = createFakeClaude({
      handler: (req) => (req.user === "bad" ? { wrong: true } : { n: 5 }),
      modelIds: ["claude-opus-5-5"],
    });
    const api: ClaudeApi = fake;

    const good = await api.structured({ ...request(), user: "good" });
    expect(good).toEqual({ ok: true, value: { n: 5 } });

    const bad = await api.structured({ ...request(), user: "bad" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe("schema");

    expect(fake.calls.map((c) => c.user)).toEqual(["good", "bad"]);
    expect(await api.listModelIds()).toEqual({ ok: true, value: ["claude-opus-5-5"] });
    expect(fake.listCalls).toBe(1);
  });

  test("listError makes listModelIds fail", async () => {
    const fake = createFakeClaude({ handler: () => ({ n: 1 }), listError: "down" });
    expect(await fake.listModelIds()).toEqual({ ok: false, error: "down" });
  });
});
