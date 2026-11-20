import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCK_STALE_MS, acquireLock } from "./lock";

let dir: string;
let lockPath: string;
const now = new Date("2026-11-19T12:00:00Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
  lockPath = path.join(dir, "job.lock");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("acquireLock", () => {
  test("LOCK_STALE_MS is 2 hours", () => {
    expect(LOCK_STALE_MS).toBe(2 * 60 * 60 * 1000);
  });

  test("acquires a free lock and writes the PID", () => {
    const r = acquireLock({ path: lockPath, pid: 111, now });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe("111");
  });

  test("a second acquire with a live PID fails with locked", () => {
    acquireLock({ path: lockPath, pid: 111, now });
    const r = acquireLock({ path: lockPath, pid: 222, now, isAlive: () => true, mtimeOf: () => now.getTime() });
    expect(r).toEqual({ ok: false, error: "locked" });
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe("111");
  });

  test("takes over a lock whose PID is dead", () => {
    fs.writeFileSync(lockPath, "111");
    const r = acquireLock({ path: lockPath, pid: 222, now, isAlive: () => false, mtimeOf: () => now.getTime() });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe("222");
  });

  test("takes over a live-PID lock older than 2 hours", () => {
    fs.writeFileSync(lockPath, "111");
    const old = now.getTime() - LOCK_STALE_MS - 1;
    const r = acquireLock({ path: lockPath, pid: 222, now, isAlive: () => true, mtimeOf: () => old });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe("222");
  });

  test("keeps a live-PID lock just under 2 hours old", () => {
    fs.writeFileSync(lockPath, "111");
    const recent = now.getTime() - LOCK_STALE_MS + 1000;
    const r = acquireLock({ path: lockPath, pid: 222, now, isAlive: () => true, mtimeOf: () => recent });
    expect(r).toEqual({ ok: false, error: "locked" });
  });

  test("default isAlive treats EPERM as alive", () => {
    fs.writeFileSync(lockPath, "111");
    const orig = process.kill;
    process.kill = (() => {
      throw Object.assign(new Error("perm"), { code: "EPERM" });
    }) as typeof process.kill;
    try {
      const r = acquireLock({ path: lockPath, pid: 222, now, mtimeOf: () => now.getTime() });
      expect(r).toEqual({ ok: false, error: "locked" });
    } finally {
      process.kill = orig;
    }
  });

  test("default isAlive treats ESRCH as dead", () => {
    fs.writeFileSync(lockPath, "111");
    const orig = process.kill;
    process.kill = (() => {
      throw Object.assign(new Error("no such"), { code: "ESRCH" });
    }) as typeof process.kill;
    try {
      const r = acquireLock({ path: lockPath, pid: 222, now, mtimeOf: () => now.getTime() });
      expect(r.ok).toBe(true);
    } finally {
      process.kill = orig;
    }
  });

  test("default isAlive treats a live process (this one) as alive", () => {
    fs.writeFileSync(lockPath, String(process.pid));
    const r = acquireLock({ path: lockPath, pid: 222, now });
    expect(r).toEqual({ ok: false, error: "locked" });
  });

  test("treats an empty or garbage PID as stale", () => {
    fs.writeFileSync(lockPath, "garbage");
    const r = acquireLock({ path: lockPath, pid: 222, now, isAlive: () => true, mtimeOf: () => now.getTime() });
    expect(r.ok).toBe(true);
  });

  test("a lock path in a missing directory returns a non-locked error", () => {
    const r = acquireLock({ path: path.join(dir, "missing", "job.lock"), pid: 111, now });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toBe("locked");
      expect(r.error).toContain("ENOENT");
    }
  });

  test("release removes the file when it holds this PID", () => {
    const r = acquireLock({ path: lockPath, pid: 111, now });
    if (!r.ok) throw new Error("expected lock");
    r.value.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("release leaves the file when another PID holds it", () => {
    const r = acquireLock({ path: lockPath, pid: 111, now });
    if (!r.ok) throw new Error("expected lock");
    fs.writeFileSync(lockPath, "999");
    r.value.release();
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe("999");
  });

  test("release does not throw when the file is already gone", () => {
    const r = acquireLock({ path: lockPath, pid: 111, now });
    if (!r.ok) throw new Error("expected lock");
    fs.unlinkSync(lockPath);
    expect(() => r.value.release()).not.toThrow();
  });

  test("two acquires against one stale lock in sequence: exactly one wins", () => {
    fs.writeFileSync(lockPath, "111");
    const isAlive = (pid: number) => pid !== 111;
    const mtimeOf = () => now.getTime();
    const a = acquireLock({ path: lockPath, pid: 222, now, isAlive, mtimeOf });
    const b = acquireLock({ path: lockPath, pid: 333, now, isAlive, mtimeOf });
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(b).toEqual({ ok: false, error: "locked" });
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe("222");
  });

  test("takeover whose retry loses the race returns locked", () => {
    fs.writeFileSync(lockPath, "111");
    const isAlive = () => false;
    const mtimeOf = () => now.getTime();
    const winnerWrites = () => fs.writeFileSync(lockPath, "444");
    const origUnlink = fs.unlinkSync;
    (fs as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = ((p: fs.PathLike) => {
      origUnlink(p);
      winnerWrites();
    }) as typeof fs.unlinkSync;
    try {
      const r = acquireLock({ path: lockPath, pid: 222, now, isAlive, mtimeOf });
      expect(r).toEqual({ ok: false, error: "locked" });
      expect(fs.readFileSync(lockPath, "utf8").trim()).toBe("444");
    } finally {
      (fs as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = origUnlink;
    }
  });

  test("a free lock is taken without serialize", () => {
    let calls = 0;
    const r = acquireLock({ path: lockPath, pid: 222, now, serialize: (fn) => (calls++, fn()) });
    expect(r.ok).toBe(true);
    expect(calls).toBe(0);
  });

  test("a competitor that takes over just before serialize starts keeps the lock", () => {
    fs.writeFileSync(lockPath, "111");
    const isAlive = (pid: number) => pid !== 111;
    const mtimeOf = () => now.getTime();
    const r = acquireLock({
      path: lockPath,
      pid: 222,
      now,
      isAlive,
      mtimeOf,
      serialize: (fn) => {
        expect(acquireLock({ path: lockPath, pid: 333, now, isAlive, mtimeOf }).ok).toBe(true);
        return fn();
      },
    });
    expect(r).toEqual({ ok: false, error: "locked" });
    expect(fs.readFileSync(lockPath, "utf8")).toBe("333");
  });

  test("a serialize that throws returns locked and leaves the stale file", () => {
    fs.writeFileSync(lockPath, "111");
    const r = acquireLock({
      path: lockPath,
      pid: 222,
      now,
      isAlive: () => false,
      serialize: () => {
        throw new Error("SQLITE_BUSY");
      },
    });
    expect(r).toEqual({ ok: false, error: "locked" });
    expect(fs.readFileSync(lockPath, "utf8")).toBe("111");
  });
});
