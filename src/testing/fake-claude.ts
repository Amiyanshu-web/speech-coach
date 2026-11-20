import { type ClaudeApi, type StructuredRequest } from "../clients/claude";
import { err, ok } from "../result";

export const createFakeClaude = ({
  handler,
  modelIds = [],
  listError,
}: {
  handler: (req: StructuredRequest<unknown>) => unknown;
  modelIds?: string[];
  listError?: string;
}): ClaudeApi & { calls: StructuredRequest<unknown>[]; listCalls: number } => {
  const fake = {
    calls: [] as StructuredRequest<unknown>[],
    listCalls: 0,
    async structured<T>(req: StructuredRequest<T>) {
      fake.calls.push(req as StructuredRequest<unknown>);
      let output: unknown;
      try {
        output = handler(req as StructuredRequest<unknown>);
      } catch {
        return err({ kind: "api" as const, message: "fake handler threw" });
      }
      if (!req.validate(output)) {
        return err({ kind: "schema" as const, message: "response failed validation" });
      }
      return ok(output);
    },
    async listModelIds() {
      fake.listCalls += 1;
      return listError === undefined ? ok([...modelIds]) : err(listError);
    },
  };
  return fake;
};
