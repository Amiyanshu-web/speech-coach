import { describe, expect, test } from "bun:test";
import { createLogger, describeError } from "./log";

const fixedNow = () => new Date("2026-11-19T10:00:00.000Z");

const capture = () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line), fixedNow);
  return { lines, logger };
};

describe("createLogger", () => {
  test("writes one JSON line per call with level, message, time and fields", () => {
    const { lines, logger } = capture();
    logger.info("started", { count: 3, ok: true, name: "x", none: null });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed).toMatchObject({
      level: "info",
      message: "started",
      count: 3,
      ok: true,
      name: "x",
      none: null,
    });
    expect(parsed.time).toBe("2026-11-19T10:00:00.000Z");
    expect(lines[0]).not.toContain("\n");
  });

  test("warn and error use their own level", () => {
    const { lines, logger } = capture();
    logger.warn("w");
    logger.error("e", { code: 1 });
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(["warn", "error"]);
  });

  test("uses the injected clock for the timestamp", () => {
    const { lines, logger } = capture();
    logger.info("t");
    expect(lines[0]).toContain("2026-11-19T10:00:00.000Z");
  });

  test("fields cannot override time, level or message", () => {
    const { lines, logger } = capture();
    logger.info("real", { level: "fake", message: "fake", time: "fake" });
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      level: "info",
      message: "real",
      time: "2026-11-19T10:00:00.000Z",
    });
  });

  test("the logger type rejects non-primitive fields", () => {
    const { logger } = capture();
    // @ts-expect-error a Uint8Array is not a primitive log field
    logger.info("audio", { bytes: new Uint8Array([1, 2, 3]) });
  });
});

describe("describeError", () => {
  test("returns name: message for an Error", () => {
    expect(describeError(new TypeError("bad input"))).toBe("TypeError: bad input");
  });

  test("never includes the stack or extra properties such as a body", () => {
    const sentinel = "SENTINEL-request-body";
    const error = Object.assign(new Error("failed"), { body: sentinel });
    const text = describeError(error);
    expect(text).toBe("Error: failed");
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("at ");
  });

  test("cuts the result to 300 characters", () => {
    expect(describeError(new Error("x".repeat(1000))).length).toBe(300);
  });

  test("describes a non-Error value without throwing", () => {
    expect(describeError("SENTINEL-body")).toBe("non-Error thrown: string");
    expect(describeError(undefined)).toBe("non-Error thrown: undefined");
  });
});
