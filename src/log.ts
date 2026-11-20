export type LogFields = Record<string, string | number | boolean | null>;

export type Logger = {
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
};

const MAX_ERROR_LENGTH = 300;

export const createLogger = (
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
  now: () => Date = () => new Date(),
): Logger => {
  const emit = (level: string) => (message: string, fields: LogFields = {}) =>
    write(JSON.stringify({ ...fields, time: now().toISOString(), level, message }));
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
};

export const describeError = (e: unknown): string => {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : `non-Error thrown: ${typeof e}`;
  return text.slice(0, MAX_ERROR_LENGTH);
};
