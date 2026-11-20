import { err, ok, type Result } from "../result";

export type Env = { geminiApiKey: string; anthropicApiKey: string };

const unquote = (value: string): string => {
  const first = value[0];
  const last = value[value.length - 1];
  return value.length >= 2 && (first === '"' || first === "'") && first === last
    ? value.slice(1, -1)
    : value;
};

export const parseEnvFile = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    out[body.slice(0, eq).trim()] = unquote(body.slice(eq + 1).trim());
  }
  return out;
};

const readFile = (path: string): Promise<string> => Bun.file(path).text();

export const loadEnv = async (
  path: string,
  readText: (path: string) => Promise<string> = readFile,
): Promise<Result<Env>> => {
  let text: string;
  try {
    text = await readText(path);
  } catch {
    return err(`cannot read env file at ${path}`);
  }
  const vars = parseEnvFile(text);
  for (const name of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (!vars[name]) return err(`missing ${name} in env file`);
  }
  return ok({
    geminiApiKey: vars.GEMINI_API_KEY as string,
    anthropicApiKey: vars.ANTHROPIC_API_KEY as string,
  });
};
