import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolvePaths } from "../config/paths";
import { buildAgents, installAgents } from "../setup/launchd";

const bunPath = process.execPath;
if (!bunPath.startsWith("/")) {
  console.error("bun path is not absolute");
  process.exit(1);
}
if (!process.getuid) {
  console.error("cannot read the user id on this platform");
  process.exit(1);
}
const paths = resolvePaths(homedir());
const agents = buildAgents({ bunPath, repoDir: resolve(import.meta.dir, "../.."), paths });
const result = installAgents({
  agents,
  logDir: paths.logDir,
  writeFile: (path, content) => writeFileSync(path, content),
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  run: (command, args) => {
    const res = Bun.spawnSync([command, ...args]);
    return { status: res.exitCode, stderr: res.stderr.toString() };
  },
  uid: process.getuid(),
  sleep: (ms) => Bun.sleepSync(ms),
});
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
console.log(`installed ${agents.length} launch agents`);
