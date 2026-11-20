import type { Budget, GeminiApi, GeminiError, SoundNote } from "../clients/gemini";
import { err, ok, type Result } from "../result";

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

export type FakeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export const createFakeFetch = (
  responses: Array<Response | (() => Response)>,
): { fetch: FakeFetch; requests: RecordedRequest[] } => {
  const queue = [...responses];
  const requests: RecordedRequest[] = [];
  const fetch: FakeFetch = async (url, init) => {
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error("fake fetch: no response queued");
    return typeof next === "function" ? next() : next;
  };
  return { fetch, requests };
};

export const createFakeGemini = ({
  handler,
  modelIds = [],
  listError,
}: {
  handler: (input: { wav: Uint8Array; context: string; budget: Budget }) => Result<SoundNote[], GeminiError>;
  modelIds?: string[];
  listError?: string;
}) => {
  const fake = {
    calls: 0,
    listCalls: 0,
    modelIds,
    listError,
    analyzeAudio: async (input: { wav: Uint8Array; context: string; budget: Budget }) => {
      fake.calls += 1;
      return handler(input);
    },
    listModelIds: async (): Promise<Result<string[]>> => {
      fake.listCalls += 1;
      return fake.listError === undefined ? ok(fake.modelIds) : err(fake.listError);
    },
  } satisfies GeminiApi & { calls: number; listCalls: number; modelIds: string[]; listError?: string };
  return fake;
};
