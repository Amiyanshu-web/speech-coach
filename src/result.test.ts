import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "./result";

describe("ok", () => {
  test("wraps a value in a success result", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });
});

describe("err", () => {
  test("wraps an error in a failure result", () => {
    expect(err("boom")).toEqual({ ok: false, error: "boom" });
  });
});

describe("Result narrowing", () => {
  const parse = (input: string): Result<number> => {
    const n = Number(input);
    return Number.isNaN(n) ? err(`not a number: ${input}`) : ok(n);
  };

  test("value is reachable after checking ok", () => {
    const r = parse("7");
    // @ts-expect-error value is not accessible before narrowing
    void r.value;
    if (!r.ok) throw new Error("expected ok");
    expect(r.value).toBe(7);
  });

  test("error is reachable only after checking not ok", () => {
    const r = parse("x");
    // @ts-expect-error error is not accessible before narrowing
    void r.error;
    if (r.ok) throw new Error("expected err");
    expect(r.error).toBe("not a number: x");
  });

  test("error type defaults to string and accepts a custom type", () => {
    const notFound = (): Result<number, { code: number }> => err({ code: 404 });
    const r = notFound();
    if (r.ok) throw new Error("expected err");
    expect(r.error.code).toBe(404);
  });
});
