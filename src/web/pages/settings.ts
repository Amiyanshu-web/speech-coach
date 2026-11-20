import {
  getClaudeModel,
  getGeminiModels,
  getSkipList,
  setClaudeModel,
  setGeminiModels,
  setSkipList,
} from "../../db/settings";
import { listRecentRuns } from "../../jobs/runs";
import { escapeHtml, htmlResponse, layout, localTime, redirect, type Handler } from "../html";

const RUN_LIMIT = 10;
const MODEL_PATTERN = /^[A-Za-z0-9._-]+$/;

const runItems = (runs: ReturnType<typeof listRecentRuns>, offsetOf: (d: Date) => number): string =>
  runs.length === 0
    ? '<p class="empty">No runs yet.</p>'
    : `<ul class="plain runs">${runs
        .map(
          (r) =>
            `<li><span class="when" title="${escapeHtml(r.started)}">${escapeHtml(localTime(r.started, offsetOf))}</span> ${escapeHtml(r.kind)} <em class="status status-${r.status === "failed" ? "failed" : "other"}">${escapeHtml(r.status)}</em></li>`,
        )
        .join("")}</ul>`;

export const settingsPage: Handler = (req, ctx) => {
  const showError = new URL(req.url).searchParams.get("error") === "model";
  const error = showError
    ? `<p role="alert">A model name was not saved. Use only letters, digits, dots, dashes and underscores.</p>`
    : "";
  const body = `<h1>Settings</h1>${error}
<form class="settings" method="post" action="/settings">
<fieldset><legend>Skip list</legend>
<label>Apps to skip<textarea name="skipList" rows="8">${escapeHtml(getSkipList(ctx.db).join("\n"))}</textarea><span class="help">One bundle id per line. Speech from these apps is not analysed.</span></label>
</fieldset>
<fieldset><legend>Models</legend>
<label>Claude model<input type="text" name="claudeModel" value="${escapeHtml(getClaudeModel(ctx.db))}"><span class="help">The model that writes the lessons.</span></label>
<label>Gemini model order<input type="text" name="geminiModels" value="${escapeHtml(getGeminiModels(ctx.db).join(","))}"><span class="help">Comma-separated. The first model is tried first.</span></label>
</fieldset>
<button type="submit" class="primary">Save settings</button>
</form>
<h2>Recent runs</h2>
${runItems(listRecentRuns(ctx.db, RUN_LIMIT), ctx.offsetOf ?? ((d) => d.getTimezoneOffset()))}`;
  return htmlResponse(layout({ title: "Settings", active: "/settings", body }));
};

export const saveSettings: Handler = async (req, ctx) => {
  const form = new URLSearchParams(await req.text());
  let modelRejected = false;

  const skipRaw = form.get("skipList");
  if (skipRaw !== null) {
    setSkipList(
      ctx.db,
      skipRaw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    );
  }

  const claude = form.get("claudeModel")?.trim();
  if (claude !== undefined) {
    if (MODEL_PATTERN.test(claude)) setClaudeModel(ctx.db, claude);
    else modelRejected = true;
  }

  const geminiRaw = form.get("geminiModels");
  if (geminiRaw !== null) {
    const models = geminiRaw
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "");
    if (models.length > 0 && models.every((m) => MODEL_PATTERN.test(m))) setGeminiModels(ctx.db, models);
    else modelRejected = true;
  }

  return redirect(modelRejected ? "/settings?error=model" : "/settings");
};
