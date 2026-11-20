import { describe, expect, test } from "bun:test";
import {
  addDays,
  localDayFromUtc,
  mostRecentScheduled,
  parseWisprTimestamp,
  todayLocal,
} from "./time";

const IST = () => -330;
const UTC = () => 0;
const NEW_YORK_STANDARD = () => 300;

describe("parseWisprTimestamp", () => {
  test("parses a UTC timestamp with milliseconds", () => {
    expect(parseWisprTimestamp("2026-11-19 15:19:21.936 +00:00")).toEqual({
      ok: true,
      value: Date.UTC(2026, 10, 19, 15, 19, 21, 936),
    });
  });

  test("parses the form without milliseconds", () => {
    expect(parseWisprTimestamp("2026-11-19 15:19:21 +00:00")).toEqual({
      ok: true,
      value: Date.UTC(2026, 10, 19, 15, 19, 21),
    });
  });

  test("subtracts a positive offset", () => {
    expect(parseWisprTimestamp("2026-11-19 20:49:21.936 +05:30")).toEqual({
      ok: true,
      value: Date.UTC(2026, 10, 19, 15, 19, 21, 936),
    });
  });

  test("adds a negative offset", () => {
    expect(parseWisprTimestamp("2026-11-19 07:19:21.936 -08:00")).toEqual({
      ok: true,
      value: Date.UTC(2026, 10, 19, 15, 19, 21, 936),
    });
  });

  test("crosses a day boundary through the offset", () => {
    expect(parseWisprTimestamp("2026-11-20 01:00:00 +05:30")).toEqual({
      ok: true,
      value: Date.UTC(2026, 10, 19, 19, 30, 0),
    });
  });

  test.each([
    "",
    "not a date",
    "2026-11-19",
    "2026-11-19 15:19:21.936",
    "2026-11-19T15:19:21.936+00:00",
    "2026-11-19 15:19:21.936 +0530",
    "2026-13-45 10:00:00 +00:00",
  ])("returns err for %p", (input) => {
    const result = parseWisprTimestamp(input);
    expect(result.ok).toBe(false);
  });
});

describe("localDayFromUtc", () => {
  test("rolls to the next local day after 18:30 UTC at offset -330", () => {
    expect(localDayFromUtc(Date.UTC(2026, 10, 19, 20, 0), -330)).toBe("2026-11-20");
  });

  test("stays on the same local day before 18:30 UTC at offset -330", () => {
    expect(localDayFromUtc(Date.UTC(2026, 10, 19, 18, 0), -330)).toBe("2026-11-19");
  });

  test("goes back a day for a positive offset", () => {
    expect(localDayFromUtc(Date.UTC(2026, 10, 19, 2, 0), 300)).toBe("2026-11-18");
  });

  test("handles the year boundary", () => {
    expect(localDayFromUtc(Date.UTC(2026, 11, 31, 20, 0), -330)).toBe("2027-01-01");
  });
});

describe("todayLocal", () => {
  test("uses the injected offset", () => {
    const now = new Date(Date.UTC(2026, 10, 19, 20, 0));
    expect(todayLocal(now, IST)).toBe("2026-11-20");
    expect(todayLocal(now, UTC)).toBe("2026-11-19");
    expect(todayLocal(now, NEW_YORK_STANDARD)).toBe("2026-11-19");
  });

  test("passes the date to offsetOf", () => {
    const seen: Date[] = [];
    const now = new Date(Date.UTC(2026, 10, 19, 20, 0));
    todayLocal(now, (d) => {
      seen.push(d);
      return 0;
    });
    expect(seen.map((d) => d.getTime())).toContain(now.getTime());
  });
});

describe("mostRecentScheduled", () => {
  test("at local 20:59 returns the previous day's 21:00", () => {
    const now = new Date(Date.UTC(2026, 10, 19, 15, 29));
    const result = mostRecentScheduled(now, 21, IST);
    expect(result.getTime()).toBe(Date.UTC(2026, 10, 18, 15, 30));
  });

  test("at local 21:00 returns that same instant", () => {
    const now = new Date(Date.UTC(2026, 10, 19, 15, 30));
    const result = mostRecentScheduled(now, 21, IST);
    expect(result.getTime()).toBe(now.getTime());
  });

  test("after the hour returns the same day's occurrence", () => {
    const now = new Date(Date.UTC(2026, 10, 19, 17, 0));
    const result = mostRecentScheduled(now, 21, IST);
    expect(result.getTime()).toBe(Date.UTC(2026, 10, 19, 15, 30));
  });

  test("works across a local day boundary with a positive offset", () => {
    const now = new Date(Date.UTC(2026, 10, 19, 3, 0));
    const result = mostRecentScheduled(now, 21, NEW_YORK_STANDARD);
    expect(result.getTime()).toBe(Date.UTC(2026, 10, 19, 2, 0));
  });
});

describe("addDays", () => {
  test("adds within a month", () => {
    expect(addDays("2026-11-19", 1)).toBe("2026-11-20");
  });

  test("crosses a month boundary forward and back", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-01", -1)).toBe("2026-11-30");
  });

  test("crosses a year boundary forward and back", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  test("handles leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  test("zero returns the same day", () => {
    expect(addDays("2026-11-19", 0)).toBe("2026-11-19");
  });

  test("adds many days", () => {
    expect(addDays("2026-11-19", 45)).toBe("2027-01-03");
  });
});
