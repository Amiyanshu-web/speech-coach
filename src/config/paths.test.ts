import { describe, expect, test } from "bun:test";
import { resolvePaths } from "./paths";

describe("resolvePaths", () => {
  test("returns exactly the documented paths under the home directory", () => {
    expect(resolvePaths("/h")).toEqual({
      envFile: "/h/.config/speech-coach/env",
      dataDir: "/h/.local/share/speech-coach",
      coachDb: "/h/.local/share/speech-coach/coach.sqlite",
      lockDir: "/h/.local/share/speech-coach",
      logDir: "/h/Library/Logs/speech-coach",
      launchAgentsDir: "/h/Library/LaunchAgents",
      wisprDb: "/h/Library/Application Support/Wispr Flow/flow.sqlite",
    });
  });
});
