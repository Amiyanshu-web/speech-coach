import fs from "node:fs";
import { err, ok, type Result } from "../result";

export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

type LockOptions = {
  path: string;
  pid: number;
  now: Date;
  isAlive?: (pid: number) => boolean;
  mtimeOf?: (path: string) => number;
  serialize?: <T>(fn: () => T) => T;
};

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const defaultMtimeOf = (p: string): number => fs.statSync(p).mtimeMs;

type Created = "created" | "exists" | { error: string };

const tryCreate = (path: string, pid: number): Created => {
  try {
    const fd = fs.openSync(path, "wx");
    try {
      fs.writeSync(fd, String(pid));
    } finally {
      fs.closeSync(fd);
    }
    return "created";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EEXIST" ? "exists" : { error: `lock open failed: ${code ?? "unknown"}` };
  }
};

const readRaw = (path: string): string | null => {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const parsePid = (raw: string): number | null => {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const readPid = (path: string): number | null => {
  const raw = readRaw(path);
  return raw === null ? null : parsePid(raw);
};

export const acquireLock = (opts: LockOptions): Result<{ release(): void }> => {
  const { path, pid, now } = opts;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const mtimeOf = opts.mtimeOf ?? defaultMtimeOf;
  const handle = {
    release() {
      if (readPid(path) === pid) {
        try {
          fs.unlinkSync(path);
        } catch {}
      }
    },
  };

  const first = tryCreate(path, pid);
  if (first === "created") return ok(handle);
  if (first !== "exists") return err(first.error);

  const takeOver = (): Result<{ release(): void }> => {
    const raw = readRaw(path);
    const holder = raw === null ? null : parsePid(raw);
    let stale = holder === null || !isAlive(holder);
    if (!stale) {
      try {
        stale = now.getTime() - mtimeOf(path) > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
    }
    if (!stale) return err("locked");

    if (readRaw(path) !== raw) return err("locked");
    try {
      fs.unlinkSync(path);
    } catch {}
    const second = tryCreate(path, pid);
    if (second === "created") return ok(handle);
    return err(second === "exists" ? "locked" : second.error);
  };

  try {
    return opts.serialize ? opts.serialize(takeOver) : takeOver();
  } catch {
    return err("locked");
  }
};
