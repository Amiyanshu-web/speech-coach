export type Paths = {
  envFile: string;
  dataDir: string;
  coachDb: string;
  lockDir: string;
  logDir: string;
  launchAgentsDir: string;
  wisprDb: string;
};

export const resolvePaths = (home: string): Paths => {
  const dataDir = `${home}/.local/share/speech-coach`;
  return {
    envFile: `${home}/.config/speech-coach/env`,
    dataDir,
    coachDb: `${dataDir}/coach.sqlite`,
    lockDir: dataDir,
    logDir: `${home}/Library/Logs/speech-coach`,
    launchAgentsDir: `${home}/Library/LaunchAgents`,
    wisprDb: `${home}/Library/Application Support/Wispr Flow/flow.sqlite`,
  };
};
