import type { Database } from "bun:sqlite";

export const DEFAULT_SKIP_LIST: readonly string[] = [
  "com.1password.1password",
  "com.bitwarden.desktop",
  "com.apple.keychainaccess",
  "com.apple.loginwindow",
  "com.apple.MobileSMS",
  "com.tinyspeck.slackmacgap",
];
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
export const DEFAULT_GEMINI_MODELS: readonly string[] = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];

export const getSetting = (db: Database, key: string): string | null =>
  db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;

export const setSetting = (db: Database, key: string, value: string): void => {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
};

const readStrings = (db: Database, key: string, fallback: readonly string[], allowEmpty: boolean): string[] => {
  const stored = getSetting(db, key);
  if (stored === null) return [...fallback];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) return [...fallback];
    if (!allowEmpty && parsed.length === 0) return [...fallback];
    return parsed;
  } catch {
    return [...fallback];
  }
};

export const getSkipList = (db: Database): string[] => readStrings(db, "skip_list", DEFAULT_SKIP_LIST, true);
export const setSkipList = (db: Database, ids: string[]): void => setSetting(db, "skip_list", JSON.stringify(ids));

export const getClaudeModel = (db: Database): string => {
  const v = getSetting(db, "claude_model")?.trim();
  return v ? v : DEFAULT_CLAUDE_MODEL;
};
export const setClaudeModel = (db: Database, model: string): void => setSetting(db, "claude_model", model);

export const getGeminiModels = (db: Database): string[] => readStrings(db, "gemini_models", DEFAULT_GEMINI_MODELS, false);
export const setGeminiModels = (db: Database, models: string[]): void =>
  setSetting(db, "gemini_models", JSON.stringify(models));
