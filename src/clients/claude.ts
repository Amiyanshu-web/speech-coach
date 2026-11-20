import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../log";
import { describeError } from "../log";
import { type Result, err, ok } from "../result";

export const TEXT_MAX_TOKENS = 32000;
export const LESSON_MAX_TOKENS = 32000;
export const WORDS_MAX_TOKENS = 8000;

export type JsonSchema = Record<string, unknown>;

export type ClaudeError = {
  kind: "refusal" | "max_tokens" | "schema" | "api";
  message: string;
};

export type StructuredRequest<T> = {
  system: string;
  user: string;
  schema: JsonSchema;
  maxTokens: number;
  validate: (x: unknown) => x is T;
};

export type ClaudeApi = {
  structured<T>(req: StructuredRequest<T>): Promise<Result<T, ClaudeError>>;
  listModelIds(): Promise<Result<string[]>>;
};

type SdkMessage = Pick<Anthropic.Message, "stop_reason" | "content" | "stop_details">;

export type ClaudeSdkLike = {
  messages: {
    stream(body: Anthropic.MessageStreamParams): { finalMessage(): Promise<SdkMessage> };
  };
  models: { list(): AsyncIterable<{ id: string }> };
};

const fromAnthropic = (client: Anthropic): ClaudeSdkLike => ({
  messages: client.messages,
  models: { list: () => client.models.list() },
});

// An APIError message embeds the response body, so only status and type are safe to log.
export const describeClaudeError = (e: unknown): string => {
  if (e instanceof Anthropic.APIError) {
    const parts = [e.status === undefined ? e.name : String(e.status), e.type].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    return parts.join(" ");
  }
  return describeError(e);
};

export const createClaudeClient = ({
  apiKey,
  model,
  log,
  sdk,
}: {
  apiKey: string;
  model: string;
  log: Logger;
  sdk?: ClaudeSdkLike;
}): ClaudeApi => {
  const client = sdk ?? fromAnthropic(new Anthropic({ apiKey }));

  const structured = async <T>(req: StructuredRequest<T>): Promise<Result<T, ClaudeError>> => {
    let message: SdkMessage;
    try {
      message = await client.messages
        .stream({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { format: { type: "json_schema", schema: req.schema }, effort: "medium" },
        })
        .finalMessage();
    } catch (e) {
      const message = describeClaudeError(e);
      log.error("claude request failed", { error: message });
      return err({ kind: "api", message });
    }
    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category;
      log.warn("claude refused the request", category ? { category } : {});
      return err({ kind: "refusal", message: "model refused the request" });
    }
    if (message.stop_reason === "max_tokens") {
      log.warn("claude hit max_tokens", { maxTokens: req.maxTokens });
      return err({ kind: "max_tokens", message: "response hit max_tokens" });
    }
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return err({ kind: "schema", message: "response text is not valid JSON" });
    }
    if (!req.validate(parsed)) {
      return err({ kind: "schema", message: "response failed validation" });
    }
    return ok(parsed);
  };

  const listModelIds = async (): Promise<Result<string[]>> => {
    try {
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ok(ids);
    } catch (e) {
      const message = describeClaudeError(e);
      log.error("claude model list failed", { error: message });
      return err(message);
    }
  };

  return { structured, listModelIds };
};
