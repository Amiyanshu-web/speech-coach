import { addDays, todayLocal } from "../../domain/time";
import { htmlResponse, layout, type Handler } from "../html";

const DAYS = 90;

export const issuesPer100 = (issues: number, words: number): number | null =>
  words > 0 ? (issues / words) * 100 : null;

export const BUCKET_LIMITS = [2, 3.5, 5, 7] as const;

export const bucketOf = (rate: number): 0 | 1 | 2 | 3 | 4 => {
  if (rate < BUCKET_LIMITS[0]) return 0;
  if (rate < BUCKET_LIMITS[1]) return 1;
  if (rate < BUCKET_LIMITS[2]) return 2;
  if (rate < BUCKET_LIMITS[3]) return 3;
  return 4;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const cellTitle = (day: string, rate: number | null): string =>
  rate === null ? `${day}: no analysed speech` : `${day}: ${rate.toFixed(1)} issues per 100 words`;

/** The tally strokes drawn in a day cell: one upright stroke per bucket step, none for the calmest day. */
export const strokes = (bucket: number): string =>
  bucket === 0
    ? ""
    : `<svg viewBox="0 0 14 22" aria-hidden="true" focusable="false">${Array.from(
        { length: bucket },
        (_, k) => `<line x1="${2.5 + k * 3}" y1="${4 + (k % 2) * 0.6}" x2="${2.5 + k * 3 + (k % 2 ? 0.5 : -0.3)}" y2="18"/>`,
      ).join("")}</svg>`;

const legend = (): string => {
  const dots = [0, 1, 2, 3, 4].map((n) => `<span class="dot cal-${n}">${strokes(n)}</span>`).join("");
  return `<p class="cal-legend">Fewer mistakes ${dots} More mistakes <span class="dot cal-grey"></span> No speech</p>`;
};

export const calendarPage: Handler = (_req, ctx) => {
  const today = todayLocal(ctx.now(), ctx.offsetOf);
  const first = addDays(today, -(DAYS - 1));
  const words = new Map(
    (
      ctx.db
        .query("SELECT day, SUM(words) AS n FROM dictations WHERE text_status = 'done' AND day >= ? GROUP BY day")
        .all(first) as { day: string; n: number }[]
    ).map((r) => [r.day, r.n]),
  );
  const issues = new Map(
    (
      ctx.db.query("SELECT day, COUNT(*) AS n FROM issues WHERE day >= ? GROUP BY day").all(first) as {
        day: string;
        n: number;
      }[]
    ).map((r) => [r.day, r.n]),
  );
  const months = new Map<string, string[]>();
  const spoken = new Set<string>();
  for (let i = 0; i < DAYS; i++) {
    const day = addDays(first, i);
    const rate = issuesPer100(issues.get(day) ?? 0, words.get(day) ?? 0);
    const cls = rate === null ? "cal-grey" : `cal-${bucketOf(rate)}`;
    const title = cellTitle(day, rate);
    const dot = `<a class="dot ${cls}${day === today ? " today" : ""}" href="/?day=${day}" title="${title}" aria-label="${title}">${rate === null ? "" : strokes(bucketOf(rate))}</a>`;
    if (rate !== null) spoken.add(day.slice(0, 7));
    months.set(day.slice(0, 7), [...(months.get(day.slice(0, 7)) ?? []), dot]);
  }
  const rows = [...months]
    .filter(([month]) => spoken.has(month) || month === today.slice(0, 7))
    .map(
      ([month, dots]) =>
        `<div class="cal-row"><span class="cal-month">${MONTHS[Number(month.slice(5, 7)) - 1]}</span><span class="cal-dots">${dots.join("")}</span></div>`,
    )
    .join("");
  return htmlResponse(
    layout({ title: "Calendar", active: "/calendar", body: `<h1>Calendar</h1>${legend()}<div class="cal">${rows}</div>` }),
  );
};
