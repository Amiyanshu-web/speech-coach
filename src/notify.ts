import { spawnSync } from "node:child_process";
import { err, ok, type Result } from "./result";

type Spawn = (command: string, args: string[]) => { status: number | null };

const defaultSpawn: Spawn = (command, args) => spawnSync(command, args, { stdio: "ignore" });

export const notify = ({ title, message, spawn = defaultSpawn }: { title: string; message: string; spawn?: Spawn }): Result<void> => {
  try {
    const { status } = spawn("osascript", [
      "-e", "on run argv",
      "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e", "end run",
      "--",
      message,
      title,
    ]);
    return status === 0 ? ok(undefined) : err(`osascript exited with ${status}`);
  } catch (e) {
    return err(`osascript failed: ${(e as Error).message}`);
  }
};
