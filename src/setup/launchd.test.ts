import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "../config/paths";
import { BOOTSTRAP_ATTEMPTS, BOOTSTRAP_RETRY_MS, buildAgents, buildPlist, installAgents } from "./launchd";

const BUN = "/opt/bun/bin/bun";
const REPO = "/work/speech-coach";
const paths = resolvePaths("/home/tester");
const agents = () => buildAgents({ bunPath: BUN, repoDir: REPO, paths });
const byLabel = (label: string) => {
  const agent = agents().find((a) => a.label === label);
  if (!agent) throw new Error(`missing agent ${label}`);
  return agent;
};

const base = {
  label: "local.test",
  programArguments: ["/bin/x", "a&b"],
  workingDirectory: "/wd",
  stdoutPath: "/o.log",
  stderrPath: "/e.log",
  runAtLoad: false,
};

describe("buildPlist", () => {
  test("escapes & in values", () => {
    const xml = buildPlist({ ...base, workingDirectory: "/Users/a&b/repo" });
    expect(xml).toContain("/Users/a&amp;b/repo");
    expect(xml).toContain("a&amp;b");
    expect(xml).not.toContain("a&b<");
  });

  test("omits optional keys when unset", () => {
    const xml = buildPlist(base);
    expect(xml).not.toContain("StartCalendarInterval");
    expect(xml).not.toContain("KeepAlive");
    expect(xml).not.toContain("ThrottleInterval");
  });
});

describe("buildAgents", () => {
  test("returns the three labelled agents with plist paths", () => {
    const list = agents();
    expect(list.map((a) => a.label)).toEqual([
      "local.speech-coach.nightly",
      "local.speech-coach.morning",
      "local.speech-coach.web",
    ]);
    for (const a of list) expect(a.path).toBe(`${paths.launchAgentsDir}/${a.label}.plist`);
  });

  test("each plist has bunPath, CLI arg per agent, WorkingDirectory and log paths", () => {
    const cli = {
      "local.speech-coach.nightly": "src/cli/nightly.ts",
      "local.speech-coach.morning": "src/cli/morning.ts",
      "local.speech-coach.web": "src/cli/web.ts",
    };
    for (const a of agents()) {
      expect(a.xml).toContain(`<string>${BUN}</string>`);
      expect(a.xml).toContain(`<string>${cli[a.label as keyof typeof cli]}</string>`);
      expect(a.xml).toContain(`<string>${REPO}</string>`);
      expect(a.xml).toContain(`<string>${paths.logDir}/${a.label}.out.log</string>`);
      expect(a.xml).toContain(`<string>${paths.logDir}/${a.label}.err.log</string>`);
      expect(a.xml).toContain(`<string>${a.label}</string>`);
    }
  });

  test("ProgramArguments lists bunPath first, then the CLI file", () => {
    const nightly = byLabel("local.speech-coach.nightly").xml;
    expect(nightly).toMatch(
      new RegExp(`<key>ProgramArguments</key>\\s*<array>\\s*<string>${BUN}</string>\\s*<string>src/cli/nightly.ts</string>\\s*</array>`),
    );
  });

  test("nightly runs at 21:00 and morning at 09:00", () => {
    const calendar = (h: number) =>
      new RegExp(`<key>StartCalendarInterval</key>\\s*<dict>\\s*<key>Hour</key>\\s*<integer>${h}</integer>\\s*<key>Minute</key>\\s*<integer>0</integer>\\s*</dict>`);
    expect(byLabel("local.speech-coach.nightly").xml).toMatch(calendar(21));
    expect(byLabel("local.speech-coach.morning").xml).toMatch(calendar(9));
  });

  test("RunAtLoad is true for all three", () => {
    for (const a of agents()) expect(a.xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  test("web has KeepAlive and ThrottleInterval 30, others have neither", () => {
    const web = byLabel("local.speech-coach.web").xml;
    expect(web).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(web).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    expect(web).not.toContain("StartCalendarInterval");
    for (const label of ["local.speech-coach.nightly", "local.speech-coach.morning"]) {
      expect(byLabel(label).xml).not.toContain("KeepAlive");
    }
  });

  test("a repo path with & is XML-escaped", () => {
    const [first] = buildAgents({ bunPath: BUN, repoDir: "/Users/a&b/repo", paths });
    expect(first?.xml).toContain("/Users/a&amp;b/repo");
  });
});

const plutil = Bun.spawnSync(["which", "plutil"]).exitCode === 0;

describe("plutil -lint", () => {
  test.skipIf(!plutil)("every generated plist is valid", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchd-test-"));
    try {
      for (const a of buildAgents({ bunPath: BUN, repoDir: "/Users/a&b/repo", paths })) {
        const file = join(dir, `${a.label}.plist`);
        writeFileSync(file, a.xml);
        const res = Bun.spawnSync(["plutil", "-lint", file]);
        expect(res.exitCode).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(a.xml);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const harness = (runStatus: (args: string[]) => number = () => 0) => {
  const writes: { path: string; content: string }[] = [];
  const dirs: string[] = [];
  const runs: { command: string; args: string[] }[] = [];
  const sleeps: number[] = [];
  return {
    writes,
    dirs,
    runs,
    sleeps,
    deps: {
      sleep: (ms: number) => {
        sleeps.push(ms);
      },
      writeFile: (path: string, content: string) => {
        writes.push({ path, content });
      },
      mkdir: (dir: string) => {
        dirs.push(dir);
      },
      run: (command: string, args: string[]) => {
        runs.push({ command, args });
        return { status: runStatus(args) };
      },
    },
  };
};

describe("installAgents", () => {
  test("makes the log dir, writes 3 plists, bootstraps each", () => {
    const h = harness();
    const result = installAgents({ agents: agents(), logDir: paths.logDir, uid: 501, ...h.deps });
    expect(result.ok).toBe(true);
    expect(h.dirs).toContain(paths.logDir);
    expect(h.writes.map((w) => w.path)).toEqual(agents().map((a) => a.path));
    expect(h.writes.every((w) => w.path.startsWith(paths.launchAgentsDir))).toBe(true);
    const bootstraps = h.runs.filter((r) => r.args[0] === "bootstrap");
    expect(bootstraps).toHaveLength(3);
    for (const [i, a] of agents().entries()) {
      expect(bootstraps[i]).toEqual({ command: "launchctl", args: ["bootstrap", "gui/501", a.path] });
    }
    expect(h.runs.filter((r) => r.args[0] === "bootout").map((r) => r.args)).toEqual(
      agents().map((a) => ["bootout", `gui/501/${a.label}`]),
    );
  });

  test("each agent's bootout runs before its bootstrap", () => {
    const h = harness();
    installAgents({ agents: agents(), logDir: paths.logDir, uid: 501, ...h.deps });
    for (const a of agents()) {
      const out = h.runs.findIndex((r) => r.args[0] === "bootout" && r.args[1] === `gui/501/${a.label}`);
      const boot = h.runs.findIndex((r) => r.args[0] === "bootstrap" && r.args[2] === a.path);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThan(boot);
    }
  });

  test("a failing bootout is ignored", () => {
    const h = harness((args) => (args[0] === "bootout" ? 3 : 0));
    const result = installAgents({ agents: agents(), logDir: paths.logDir, uid: 501, ...h.deps });
    expect(result.ok).toBe(true);
    expect(h.runs.filter((r) => r.args[0] === "bootstrap")).toHaveLength(3);
  });

  test("a bootstrap that always fails returns err after 5 attempts on the first agent", () => {
    const h = harness((args) => (args[0] === "bootstrap" ? 5 : 0));
    const result = installAgents({ agents: agents(), logDir: paths.logDir, uid: 501, ...h.deps });
    expect(result.ok).toBe(false);
    expect(h.runs.filter((r) => r.args[0] === "bootstrap").map((r) => r.args[2])).toEqual(
      Array(BOOTSTRAP_ATTEMPTS).fill(agents()[0]!.path),
    );
    expect(h.sleeps).toEqual(Array(BOOTSTRAP_ATTEMPTS - 1).fill(BOOTSTRAP_RETRY_MS));
  });

  test("a bootstrap that fails twice while the old service unloads is retried and succeeds", () => {
    let failures = 2;
    const h = harness((args) => (args[0] === "bootstrap" && failures-- > 0 ? 5 : 0));
    const result = installAgents({ agents: agents(), logDir: paths.logDir, uid: 501, ...h.deps });
    expect(result.ok).toBe(true);
    expect(h.runs.filter((r) => r.args[0] === "bootstrap")).toHaveLength(5);
    expect(h.sleeps).toEqual([BOOTSTRAP_RETRY_MS, BOOTSTRAP_RETRY_MS]);
  });

  test("no sleep when every bootstrap succeeds at once", () => {
    const h = harness();
    installAgents({ agents: agents(), logDir: paths.logDir, uid: 501, ...h.deps });
    expect(h.sleeps).toEqual([]);
  });

  test("a throwing writeFile or mkdir returns err", () => {
    const h = harness();
    const boom = () => {
      throw new Error("boom");
    };
    const base = { agents: agents(), logDir: paths.logDir, uid: 501, ...h.deps };
    expect(installAgents({ ...base, writeFile: boom }).ok).toBe(false);
    expect(installAgents({ ...base, mkdir: boom }).ok).toBe(false);
  });

  test("mkdir also covers the plist directory", () => {
    const h = harness();
    installAgents({ agents: agents(), logDir: paths.logDir, uid: 501, ...h.deps });
    expect(h.dirs).toContain(paths.launchAgentsDir);
  });

  test("bootstrap err includes trimmed stderr cut to 300 chars", () => {
    const h = harness();
    const run = (_c: string, args: string[]) =>
      args[0] === "bootstrap" ? { status: 5, stderr: `  ${"x".repeat(400)}  ` } : { status: 0 };
    const result = installAgents({ agents: agents(), logDir: paths.logDir, uid: 501, ...h.deps, run });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("x".repeat(300));
      expect(result.error).not.toContain("x".repeat(301));
    }
  });
});
