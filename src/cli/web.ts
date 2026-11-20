import { homedir } from "node:os";
import { resolvePaths } from "../config/paths";
import { openCoachDb } from "../db/coach";
import { createLogger } from "../log";
import { readAudioFromPath } from "../wispr/source";
import { portFromEnv, startServer } from "../web/server";

const log = createLogger();
const paths = resolvePaths(homedir());
const opened = openCoachDb(paths.coachDb);
if (!opened.ok) {
  log.error("cannot open coach database", { error: opened.error.slice(0, 300) });
  process.exit(1);
}
const server = startServer({ db: opened.value, port: portFromEnv(process.env.SPEECH_COACH_PORT), log, now: () => new Date(), readAudio: (id) => readAudioFromPath(paths.wisprDb, id) });
log.info("web server started", { port: server.port ?? 0 });
