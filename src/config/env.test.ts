import { describe, expect, test } from "bun:test";
import { loadEnv, parseEnvFile } from "./env";

describe("parseEnvFile", () => {
  test("reads KEY=VALUE lines and skips comments and blank lines", () => {
    const text = "# comment\n\nA=1\n  # indented comment\nB=two\n";
    expect(parseEnvFile(text)).toEqual({ A: "1", B: "two" });
  });

  test("strips surrounding single and double quotes", () => {
    expect(parseEnvFile(`A="x y"\nB='z'\n`)).toEqual({ A: "x y", B: "z" });
  });

  test("tolerates an export prefix", () => {
    expect(parseEnvFile("export A=1\n")).toEqual({ A: "1" });
  });

  test("keeps equals signs inside the value", () => {
    expect(parseEnvFile("A=b=c==\n")).toEqual({ A: "b=c==" });
  });

  test("handles CRLF line endings", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("loadEnv", () => {
  test("returns both keys from a valid file", async () => {
    const readText = async () => "GEMINI_API_KEY=g-1\nANTHROPIC_API_KEY=a-1\n";
    expect(await loadEnv("/any", readText)).toEqual({
      ok: true,
      value: { geminiApiKey: "g-1", anthropicApiKey: "a-1" },
    });
  });

  test("names only the missing variable and never prints the other key", async () => {
    const sentinel = "SENTINEL-gemini-secret-value";
    const readText = async () => `GEMINI_API_KEY=${sentinel}\n`;
    const result = await loadEnv("/any", readText);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ANTHROPIC_API_KEY");
    expect(result.error).not.toContain(sentinel);
  });

  test("treats an empty value as missing", async () => {
    const readText = async () => "GEMINI_API_KEY=g\nANTHROPIC_API_KEY=\n";
    const result = await loadEnv("/any", readText);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ANTHROPIC_API_KEY");
  });

  test("returns err instead of throwing when the file cannot be read", async () => {
    const readText = async () => {
      throw new Error("ENOENT: no such file");
    };
    const result = await loadEnv("/missing/env", readText);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error).toBe("string");
  });

  test("does not leak key values when the read error carries file content", async () => {
    const sentinel = "SENTINEL-in-read-error";
    const readText = async () => {
      throw new Error(`bad read ${sentinel}`);
    };
    const result = await loadEnv("/p", readText);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain(sentinel);
  });
});
