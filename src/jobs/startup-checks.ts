import type { Database } from "bun:sqlite";
import type { ClaudeApi } from "../clients/claude";
import type { GeminiApi } from "../clients/gemini";
import { getSetting, setSetting } from "../db/settings";
import { err, ok, type Result } from "../result";
import { checkWisprColumns, openWisprReadOnly } from "../wispr/source";

export type StartupResult = { warnings: string[]; cached: boolean; audioEnabled: boolean };

const OK_KEY = "startup_check_ok";
const PRIMARY_MISSING_KEY = "startup_check_gemini_primary_missing";

const defaultCompileOptions = (coach: Database): string[] =>
  (coach.query("PRAGMA compile_options").all() as Record<string, string>[]).map(
    (row) => Object.values(row)[0] ?? "",
  );

export const runStartupChecks = async ({
  coach,
  wisprPath,
  claude,
  gemini,
  claudeModel,
  geminiModels,
  today,
  compileOptions = () => defaultCompileOptions(coach),
}: {
  coach: Database;
  wisprPath: string;
  claude: Pick<ClaudeApi, "listModelIds">;
  gemini: Pick<GeminiApi, "listModelIds">;
  claudeModel: string;
  geminiModels: readonly string[];
  today: string;
  compileOptions?: () => string[];
}): Promise<Result<StartupResult>> => {
  if (getSetting(coach, OK_KEY) === today) {
    return ok({ warnings: [], cached: true, audioEnabled: true });
  }
  if (getSetting(coach, PRIMARY_MISSING_KEY) === today) {
    return ok({
      warnings: ["Gemini primary model not listed (cached)"],
      cached: true,
      audioEnabled: false,
    });
  }

  const wispr = openWisprReadOnly(wisprPath);
  if (!wispr.ok) return err(wispr.error);
  try {
    const columns = checkWisprColumns(wispr.value);
    if (!columns.ok) return err(columns.error);
  } finally {
    wispr.value.close();
  }

  let options: string[];
  try {
    options = compileOptions();
  } catch (e) {
    return err(`Cannot read SQLite compile options: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!options.includes("ENABLE_FTS5")) {
    return err("SQLite was built without FTS5 (ENABLE_FTS5 missing from compile options)");
  }

  const claudeList = await claude.listModelIds();
  if (!claudeList.ok) return err(`Cannot list Claude models: ${claudeList.error}`);
  if (!claudeList.value.includes(claudeModel)) {
    return err(`Primary Claude model not available: ${claudeModel}`);
  }

  const warnings: string[] = [];
  const [primary, ...fallbacks] = geminiModels;
  const geminiList = await gemini.listModelIds();
  if (!geminiList.ok) {
    warnings.push(`Cannot list Gemini models, primary unverified: ${geminiList.error}`);
    return ok({ warnings, cached: false, audioEnabled: true });
  }
  const listed = new Set(geminiList.value);
  for (const model of fallbacks) {
    if (!listed.has(model)) warnings.push(`Gemini fallback model not listed: ${model}`);
  }
  if (primary !== undefined && !listed.has(primary)) {
    warnings.push(`Gemini primary model not listed: ${primary}`);
    setSetting(coach, PRIMARY_MISSING_KEY, today);
    return ok({ warnings, cached: false, audioEnabled: false });
  }
  setSetting(coach, OK_KEY, today);
  return ok({ warnings, cached: false, audioEnabled: true });
};
