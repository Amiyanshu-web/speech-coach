import { describe, expect, test } from "bun:test";
import { notify } from "./notify";

const fakeSpawn = (status: number | null = 0) => {
  const calls: { command: string; args: string[] }[] = [];
  const spawn = (command: string, args: string[]) => {
    calls.push({ command, args });
    return { status };
  };
  return { spawn, calls };
};

const SCRIPT = [
  "-e", "on run argv",
  "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
  "-e", "end run",
  "--",
];

describe("notify", () => {
  test("runs osascript with the fixed script then message and title as separate args", () => {
    const { spawn, calls } = fakeSpawn();
    const r = notify({ title: "Speech Coach", message: "Nightly done", spawn });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      { command: "osascript", args: [...SCRIPT, "Nightly done", "Speech Coach"] },
    ]);
  });

  test("passes quotes and backslashes unchanged and never splices them into the script", () => {
    const { spawn, calls } = fakeSpawn();
    const message = `He said "hi" and it's \\ done`;
    const title = `Tom's "title"`;
    notify({ title, message, spawn });
    const args = calls[0]!.args;
    expect(args.slice(-2)).toEqual([message, title]);
    expect(args.slice(0, -2)).toEqual(SCRIPT);
  });

  test("passes a dash-leading message unchanged after --", () => {
    const { spawn, calls } = fakeSpawn();
    notify({ title: "t", message: "-e boom", spawn });
    expect(calls[0]!.args.slice(-3)).toEqual(["--", "-e boom", "t"]);
  });

  test("returns err when osascript exits non-zero", () => {
    const { spawn } = fakeSpawn(1);
    const r = notify({ title: "t", message: "m", spawn });
    expect(r.ok).toBe(false);
  });

  test("returns err when status is null", () => {
    const { spawn } = fakeSpawn(null);
    expect(notify({ title: "t", message: "m", spawn }).ok).toBe(false);
  });

  test("returns err instead of throwing when spawn throws", () => {
    const spawn = () => {
      throw new Error("boom");
    };
    const r = notify({ title: "t", message: "m", spawn });
    expect(r.ok).toBe(false);
  });
});
