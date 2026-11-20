import type { Paths } from "../config/paths";
import { err, ok, type Result } from "../result";

export type PlistSpec = {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  calendar?: { hour: number; minute: number };
  runAtLoad: boolean;
  keepAlive?: boolean;
  throttleInterval?: number;
};

export type Agent = { label: string; path: string; xml: string };

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const str = (key: string, value: string): string =>
  `  <key>${key}</key>\n  <string>${esc(value)}</string>`;
const bool = (key: string, value: boolean): string =>
  `  <key>${key}</key>\n  <${value}/>`;

export const buildPlist = (spec: PlistSpec): string => {
  const args = spec.programArguments.map((a) => `    <string>${esc(a)}</string>`).join("\n");
  const parts = [
    str("Label", spec.label),
    `  <key>ProgramArguments</key>\n  <array>\n${args}\n  </array>`,
    str("WorkingDirectory", spec.workingDirectory),
    str("StandardOutPath", spec.stdoutPath),
    str("StandardErrorPath", spec.stderrPath),
  ];
  if (spec.calendar) {
    parts.push(
      `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>${spec.calendar.hour}</integer>\n    <key>Minute</key>\n    <integer>${spec.calendar.minute}</integer>\n  </dict>`,
    );
  }
  parts.push(bool("RunAtLoad", spec.runAtLoad));
  if (spec.keepAlive !== undefined) parts.push(bool("KeepAlive", spec.keepAlive));
  if (spec.throttleInterval !== undefined) {
    parts.push(`  <key>ThrottleInterval</key>\n  <integer>${spec.throttleInterval}</integer>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${parts.join("\n")}
</dict>
</plist>
`;
};

export const buildAgents = ({
  bunPath,
  repoDir,
  paths,
}: {
  bunPath: string;
  repoDir: string;
  paths: Paths;
}): Agent[] => {
  const make = (
    name: string,
    extra: Pick<PlistSpec, "calendar" | "keepAlive" | "throttleInterval">,
  ): Agent => {
    const label = `local.speech-coach.${name}`;
    const xml = buildPlist({
      label,
      programArguments: [bunPath, `src/cli/${name}.ts`],
      workingDirectory: repoDir,
      stdoutPath: `${paths.logDir}/${label}.out.log`,
      stderrPath: `${paths.logDir}/${label}.err.log`,
      runAtLoad: true,
      ...extra,
    });
    return { label, path: `${paths.launchAgentsDir}/${label}.plist`, xml };
  };
  return [
    make("nightly", { calendar: { hour: 21, minute: 0 } }),
    make("morning", { calendar: { hour: 9, minute: 0 } }),
    make("web", { keepAlive: true, throttleInterval: 30 }),
  ];
};

export type InstallDeps = {
  agents: Agent[];
  logDir: string;
  writeFile: (path: string, content: string) => void;
  mkdir: (dir: string) => void;
  run: (command: string, args: string[]) => { status: number | null; stderr?: string };
  uid: number;
  sleep: (ms: number) => void;
};

export const BOOTSTRAP_ATTEMPTS = 5;
export const BOOTSTRAP_RETRY_MS = 1000;

export const installAgents = (deps: InstallDeps): Result<void> => {
  const { agents, logDir, writeFile, mkdir, run, uid, sleep } = deps;
  try {
    mkdir(logDir);
    for (const a of agents) {
      mkdir(a.path.slice(0, a.path.lastIndexOf("/")));
      writeFile(a.path, a.xml);
    }
    for (const a of agents) {
      run("launchctl", ["bootout", `gui/${uid}/${a.label}`]);
      let res = run("launchctl", ["bootstrap", `gui/${uid}`, a.path]);
      for (let attempt = 1; res.status !== 0 && attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
        sleep(BOOTSTRAP_RETRY_MS);
        res = run("launchctl", ["bootstrap", `gui/${uid}`, a.path]);
      }
      if (res.status !== 0) {
        const detail = (res.stderr ?? "").trim().slice(0, 300);
        return err(`launchctl bootstrap failed for ${a.label}: status ${res.status}${detail ? `: ${detail}` : ""}`);
      }
    }
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e.message : "install failed");
  }
};
