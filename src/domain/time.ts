import { err, ok, type Result } from "../result";

export type OffsetOf = (d: Date) => number;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const defaultOffsetOf: OffsetOf = (d) => d.getTimezoneOffset();

const WISPR_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))? ([+-])(\d{2}):(\d{2})$/;

export const parseWisprTimestamp = (s: string): Result<number> => {
  const m = WISPR_TIMESTAMP.exec(s);
  if (!m) return err(`invalid Wispr timestamp: ${s}`);
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ];
  const millis = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
  const offsetHours = Number(m[9]);
  const offsetMinutes = Number(m[10]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) {
    return err(`invalid Wispr timestamp: ${s}`);
  }
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) {
    return err(`invalid Wispr timestamp: ${s}`);
  }
  const sign = m[8] === "-" ? -1 : 1;
  return ok(wall.getTime() - sign * (offsetHours * 60 + offsetMinutes) * MS_PER_MINUTE);
};

export const localDayFromUtc = (utcMs: number, offsetMinutes: number): string =>
  new Date(utcMs - offsetMinutes * MS_PER_MINUTE).toISOString().slice(0, 10);

export const todayLocal = (now: Date, offsetOf: OffsetOf = defaultOffsetOf): string =>
  localDayFromUtc(now.getTime(), offsetOf(now));

export const mostRecentScheduled = (
  now: Date,
  hour: number,
  offsetOf: OffsetOf = defaultOffsetOf,
): Date => {
  const offset = offsetOf(now);
  const localMs = now.getTime() - offset * MS_PER_MINUTE;
  const localMidnight = Math.floor(localMs / MS_PER_DAY) * MS_PER_DAY;
  const candidate = localMidnight + hour * MS_PER_HOUR + offset * MS_PER_MINUTE;
  return new Date(candidate > now.getTime() ? candidate - MS_PER_DAY : candidate);
};

export const addDays = (day: string, n: number): string => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
