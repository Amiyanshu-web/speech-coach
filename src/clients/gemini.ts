import { type Logger } from "../log";
import { err, ok, type Result } from "../result";

export type SoundNote = { word: string; sound: string; tip: string };
export type GeminiError = { kind: "budget" | "unavailable" | "api" | "parse"; message: string };
export type Budget = { take(): boolean; exhausted(): boolean };
export type GeminiApi = {
  analyzeAudio(input: {
    wav: Uint8Array;
    context: string;
    budget: Budget;
  }): Promise<Result<SoundNote[], GeminiError>>;
  listModelIds(): Promise<Result<string[]>>;
};

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const API_REVISION = "2026-05-20";
const RETRY_WAITS_MS = [30_000, 60_000, 120_000];
const REQUEST_TIMEOUT_MS = 120_000;
const API_STATUSES = ["incomplete", "requires_continuation", "failed", "cancelled"];

export const createBudget = ({
  maxAttempts = 120,
  maxMs = 3_600_000,
  now = () => new Date(),
}: {
  maxAttempts?: number;
  maxMs?: number;
  now?: () => Date;
}): Budget => {
  const start = now().getTime();
  let used = 0;
  const exhausted = () => used >= maxAttempts || now().getTime() - start >= maxMs;
  return {
    take: () => {
      if (exhausted()) return false;
      used += 1;
      return true;
    },
    exhausted,
  };
};

const buildPrompt = (context: string): string =>
  `Listen to the audio. Find words the speaker mispronounced. Reply with JSON only: {"notes":[{"word":"...","sound":"the sound that was wrong","tip":"how to say it"}]}. Use an empty notes array when nothing is wrong. Automatic transcript for context: ${context}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const stepTexts = (step: Record<string, unknown>): string[] => {
  const texts: string[] = [];
  if (typeof step.text === "string") texts.push(step.text);
  if (Array.isArray(step.content)) {
    for (const item of step.content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") texts.push(item.text);
    }
  }
  return texts;
};

export const parseInteraction = (body: unknown): Result<SoundNote[], GeminiError> => {
  if (!isRecord(body)) return err({ kind: "parse", message: "response is not an object" });
  const status = body.status;
  if (status !== "completed") {
    const name = typeof status === "string" ? status : "missing";
    return err({
      kind: typeof status === "string" && API_STATUSES.includes(status) ? "api" : "parse",
      message: `interaction status ${name}`,
    });
  }
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const text = steps
    .filter((s): s is Record<string, unknown> => isRecord(s) && s.type === "model_output")
    .flatMap(stepTexts)
    .join("\n")
    .trim();
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return err({ kind: "parse", message: "model output is not valid JSON" });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.notes)) {
    return err({ kind: "parse", message: "model output has no notes array" });
  }
  const notes: SoundNote[] = [];
  for (const n of parsed.notes) {
    if (!isRecord(n) || typeof n.word !== "string" || typeof n.sound !== "string" || typeof n.tip !== "string") {
      return err({ kind: "parse", message: "a note lacks word, sound or tip" });
    }
    notes.push({ word: n.word, sound: n.sound, tip: n.tip });
  }
  return ok(notes);
};

const errorCode = async (res: Response): Promise<number | null> => {
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "number") return body.error.code;
  } catch {
    return null;
  }
  return null;
};

export const createGeminiClient = ({
  apiKey,
  models,
  log,
  fetch: doFetch = (url, init) => fetch(url, init),
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  timeoutMs = REQUEST_TIMEOUT_MS,
}: {
  apiKey: string;
  models: string[];
  log: Logger;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): GeminiApi => {
  const post = (model: string, wav: Uint8Array, context: string) =>
    doFetch(`${BASE}/interactions`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json", "Api-Revision": API_REVISION },
      body: JSON.stringify({
        model,
        input: [
          { type: "text", text: buildPrompt(context) },
          { type: "audio", mime_type: "audio/wav", data: Buffer.from(wav).toString("base64") },
        ],
      }),
    });

  const analyzeAudio: GeminiApi["analyzeAudio"] = async ({ wav, context, budget }) => {
    if (models.length === 0) return err({ kind: "api", message: "no Gemini models configured" });
    const attempts = [...Array(RETRY_WAITS_MS.length + 1).fill(models[0]!), ...models.slice(1)] as string[];
    for (let i = 0; i < attempts.length; i++) {
      const model = attempts[i]!;
      if (!budget.take()) return err({ kind: "budget", message: "Gemini attempt budget spent" });
      let res: Response;
      try {
        res = await post(model, wav, context);
      } catch (e) {
        log.error("gemini request failed", { model, error: e instanceof Error ? e.name : "non-Error" });
        return err({ kind: "api", message: "network error calling Gemini" });
      }
      if (res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          log.error("gemini response unreadable", { model });
          return err({ kind: "parse", message: "response is not JSON" });
        }
        const parsed = parseInteraction(body);
        if (!parsed.ok) log.error("gemini response rejected", { model, kind: parsed.error.kind });
        return parsed;
      }
      const code = await errorCode(res);
      log.warn("gemini http error", { model, status: res.status, code });
      if (res.status !== 503 && res.status !== 429) {
        return err({ kind: "api", message: `Gemini HTTP ${res.status}` });
      }
      const wait = i < RETRY_WAITS_MS.length ? RETRY_WAITS_MS[i]! : null;
      if (wait !== null) await sleep(wait);
    }
    return err({ kind: "unavailable", message: "all Gemini models busy" });
  };

  const listModelIds: GeminiApi["listModelIds"] = async () => {
    const ids: string[] = [];
    let token: string | null = null;
    try {
      do {
        const url = `${BASE}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
        const res = await doFetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "x-goog-api-key": apiKey },
        });
        if (!res.ok) return err(`Gemini models list HTTP ${res.status}`);
        const body: unknown = await res.json();
        if (!isRecord(body)) return err("Gemini models list is not an object");
        for (const m of Array.isArray(body.models) ? body.models : []) {
          if (isRecord(m) && typeof m.name === "string") ids.push(m.name.replace(/^models\//, ""));
        }
        token = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
      } while (token);
    } catch (e) {
      return err(`Gemini models list failed: ${e instanceof Error ? e.name : "non-Error"}`);
    }
    return ok(ids);
  };

  return { analyzeAudio, listModelIds };
};
