import { describe, expect, test } from "bun:test";
import {
  MAX_FAILED_NIGHTS,
  STATUSES,
  onFailure,
} from "./status";

describe("onFailure", () => {
  test("adds an attempt on a new day", () => {
    expect(onFailure({ attempts: 3, lastAttemptDay: "2026-11-18", today: "2026-11-19" })).toEqual({
      status: "failed",
      attempts: 4,
      lastAttemptDay: "2026-11-19",
    });
  });

  test("skips when the new day reaches the maximum", () => {
    expect(onFailure({ attempts: 4, lastAttemptDay: "2026-11-18", today: "2026-11-19" })).toEqual({
      status: "skipped",
      attempts: 5,
      lastAttemptDay: "2026-11-19",
    });
  });

  test("keeps attempts when already failed today", () => {
    expect(onFailure({ attempts: 3, lastAttemptDay: "2026-11-19", today: "2026-11-19" })).toEqual({
      status: "failed",
      attempts: 3,
      lastAttemptDay: "2026-11-19",
    });
  });

  test("stays skipped at the maximum on the same day", () => {
    expect(onFailure({ attempts: 5, lastAttemptDay: "2026-11-19", today: "2026-11-19" })).toEqual({
      status: "skipped",
      attempts: 5,
      lastAttemptDay: "2026-11-19",
    });
  });

  test("counts the first failure when there is no previous attempt day", () => {
    expect(onFailure({ attempts: 0, lastAttemptDay: null, today: "2026-11-19" })).toEqual({
      status: "failed",
      attempts: 1,
      lastAttemptDay: "2026-11-19",
    });
  });
});

describe("constants", () => {
  test("MAX_FAILED_NIGHTS is 5", () => {
    expect(MAX_FAILED_NIGHTS).toBe(5);
  });

  test("STATUSES lists the four statuses", () => {
    expect([...STATUSES].sort()).toEqual(["done", "failed", "pending", "skipped"]);
  });
});
