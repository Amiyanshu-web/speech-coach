import { homedir } from "node:os";
import { createClaudeClient } from "../clients/claude";
import { createGeminiClient } from "../clients/gemini";
import { loadEnv } from "../config/env";
import { resolvePaths } from "../config/paths";
import { openCoachDb } from "../db/coach";
import { getClaudeModel, getGeminiModels } from "../db/settings";
import { runNightly } from "../jobs/nightly";
import { recordFailedStart } from "../jobs/runs";
import { createLogger } from "../log";
import { notify } from "../notify";

const sendNotice = (title: string, message: string): void => {
  notify({ title, message });
};

const main = async (): Promise<number> => {
  const log = createLogger();
  const paths = resolvePaths(homedir());
  const opened = openCoachDb(paths.coachDb);
  if (!opened.ok) {
    log.error("cannot open coach database", { error: opened.error.slice(0, 300) });
    sendNotice("Speech Coach", "Nightly run failed: cannot open the database.");
    return 1;
  }
  const coach = opened.value;
  try {
    const env = await loadEnv(paths.envFile);
    if (!env.ok) {
      log.error("cannot load env file", { error: env.error.slice(0, 300) });
      const failure = recordFailedStart({ db: coach, kind: "nightly", now: new Date(), error: env.error });
      if (failure.notify) sendNotice("Speech Coach", "Nightly run failed: check the env file.");
      return 1;
    }
    const claudeModel = getClaudeModel(coach);
    const geminiModels = getGeminiModels(coach);
    const result = await runNightly({
      coach,
      wisprPath: paths.wisprDb,
      claude: createClaudeClient({ apiKey: env.value.anthropicApiKey, model: claudeModel, log }),
      gemini: createGeminiClient({ apiKey: env.value.geminiApiKey, models: geminiModels, log }),
      log,
      now: () => new Date(),
      pid: process.pid,
      lockPath: `${paths.lockDir}/nightly.lock`,
      notify: sendNotice,
      claudeModel,
      geminiModels,
    });
    log.info("nightly run finished", { status: result.status });
    return result.status === "failed" ? 1 : 0;
  } finally {
    coach.close();
  }
};

process.exit(await main());
