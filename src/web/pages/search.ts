import { escapeHtml, fullDate, htmlResponse, layout, type Handler } from "../html";

const OPEN = "";
const CLOSE = "";
const MAX_RESULTS = 100;

export const toFtsQuery = (q: string): string | null => {
  const terms = q
    .replace(/[]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
};

const highlight = (snippet: string): string =>
  escapeHtml(snippet).replaceAll(OPEN, "<mark>").replaceAll(CLOSE, "</mark>");

type Hit = { source: string; day: string; app: string | null; snip: string };

const SNIP = (table: string, col: number) =>
  `snippet(${table}, ${col}, '${OPEN}', '${CLOSE}', '...', 24)`;

const DICTATIONS_SQL = `SELECT 'dictation' AS source, d.day AS day, d.app AS app, ${SNIP("dictations_fts", 0)} AS snip
  FROM dictations_fts JOIN dictations d ON d.rowid = dictations_fts.rowid
  WHERE dictations_fts MATCH ?1 AND d.asr_text IS NOT NULL AND (?2 IS NULL OR d.app = ?2)
  ORDER BY d.day DESC LIMIT ${MAX_RESULTS}`;

const ISSUES_SQL = `SELECT 'issue' AS source, i.day AS day, d.app AS app, ${SNIP("issues_fts", -1)} AS snip
  FROM issues_fts JOIN issues i ON i.id = issues_fts.rowid JOIN dictations d ON d.id = i.dictation_id
  WHERE issues_fts MATCH ?1 AND (?2 IS NULL OR d.app = ?2)
  ORDER BY i.day DESC LIMIT ${MAX_RESULTS}`;

export const searchPage: Handler = (req, ctx) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const app = url.searchParams.get("app") || null;
  const fts = toFtsQuery(q);

  let hits: Hit[] = [];
  let failed = false;
  if (fts) {
    try {
      hits = [
        ...ctx.db.query<Hit, [string, string | null]>(DICTATIONS_SQL).all(fts, app),
        ...ctx.db.query<Hit, [string, string | null]>(ISSUES_SQL).all(fts, app),
      ].sort((a, b) => b.day.localeCompare(a.day));
    } catch {
      failed = true;
    }
  }

  const apps = ctx.db
    .query<{ app: string }, []>(
      "SELECT DISTINCT app FROM dictations WHERE app IS NOT NULL ORDER BY app",
    )
    .all();
  const options = [
    `<option value=""${app === null ? " selected" : ""}>All apps</option>`,
    ...apps.map(
      (a) =>
        `<option value="${escapeHtml(a.app)}"${a.app === app ? " selected" : ""}>${escapeHtml(a.app)}</option>`,
    ),
  ].join("");
  const form = `<form class="search-form" method="get" action="/search"><label class="grow"><span class="vh">Search</span><input type="search" name="q" value="${escapeHtml(q)}"></label><label><span class="vh">App</span><select name="app">${options}</select></label><button type="submit" class="text">Search</button></form>`;

  let results = "";
  if (failed) results = '<p class="error">Search failed. Try different words.</p>';
  else if (fts && hits.length === 0) results = '<p class="empty">No matches.</p>';
  else if (hits.length > 0)
    results = `<ul class="results">${hits
      .map(
        (h) =>
          `<li><span class="meta">${fullDate(h.day)}, ${escapeHtml(h.app ?? "unknown")}</span><span class="hit">${highlight(h.snip)}</span></li>`,
      )
      .join("")}</ul>`;

  return htmlResponse(
    layout({ title: "Search", active: "/search", body: `<h1>Search</h1>${form}${results}` }),
  );
};
