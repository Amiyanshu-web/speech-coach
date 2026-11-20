import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Result } from "../result";
import { createLogger, describeError, type Logger } from "../log";
import { wavPeaks } from "../audio/wav";
import { checkHost, checkSameOrigin } from "./guard";
import type { Handler, WebContext } from "./html";
import { calendarPage } from "./pages/calendar";
import { repeatsPage } from "./pages/repeats";
import { searchPage } from "./pages/search";
import { saveSettings, settingsPage } from "./pages/settings";
import { todayPage } from "./pages/today";

const STYLE_PATH = join(import.meta.dir, "style.css");
const PLAYER_PATH = join(import.meta.dir, "player.js");

const style: Handler = () =>
  new Response(Bun.file(STYLE_PATH), { headers: { "content-type": "text/css; charset=utf-8" } });

const player: Handler = () =>
  new Response(Bun.file(PLAYER_PATH), { headers: { "content-type": "text/javascript; charset=utf-8" } });

const GET_ROUTES: Record<string, Handler> = {
  "/": todayPage,
  "/calendar": calendarPage,
  "/repeats": repeatsPage,
  "/search": searchPage,
  "/settings": settingsPage,
  "/style.css": style,
  "/player.js": player,
};

const AUDIO_ID = /^[A-Za-z0-9-]{1,64}$/;
const AUDIO_PREFIX = "/audio/";
const PEAKS_SUFFIX = "/peaks";
const PEAK_BUCKETS = 120;

const notFound = () => new Response("Not Found", { status: 404 });

/** The first range of a `Range` header as inclusive [start, end], "none" when absent or unusable, null when unsatisfiable. */
const parseRange = (header: string | null, len: number): readonly [number, number] | "none" | null => {
  const m = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "none";
  if (m[1] === "") {
    const n = Number(m[2]);
    return n === 0 || len === 0 ? null : [Math.max(len - n, 0), len - 1];
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? len - 1 : Math.min(Number(m[2]), len - 1);
  return start >= len || end < start ? null : [start, end];
};

const AUDIO_KNOWN = `SELECT 1 FROM dictations d
  WHERE d.id = ? AND d.text_status <> 'skipped' AND d.audio_status <> 'skipped'
    AND EXISTS (SELECT 1 FROM issues i WHERE i.dictation_id = d.id)`;

/** The clip's bytes after the shared checks, or the response that refuses the request. */
const loadClip = (log: Logger, req: Request, ctx: WebContext, id: string): Uint8Array | Response => {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return forbidden();
  if (!AUDIO_ID.test(id) || !ctx.readAudio) return notFound();
  if (!ctx.db.query(AUDIO_KNOWN).get(id)) return notFound();
  const read = ctx.readAudio(id);
  if (!read.ok) {
    log.warn("wispr audio read failed", { id, error: read.error.slice(0, 300) });
    return new Response("Audio unavailable", { status: 503 });
  }
  return read.value ?? notFound();
};

const peaksHandler =
  (log: Logger): Handler =>
  (req, ctx) => {
    const rest = new URL(req.url).pathname.slice(AUDIO_PREFIX.length);
    const clip = loadClip(log, req, ctx, rest.slice(0, -PEAKS_SUFFIX.length));
    if (clip instanceof Response) return clip;
    const peaks = wavPeaks(clip, PEAK_BUCKETS);
    if (!peaks) return new Response("Unsupported audio format", { status: 415 });
    return Response.json({ peaks }, { headers: { "cache-control": "no-store" } });
  };

const audioHandler =
  (log: Logger): Handler =>
  (req, ctx) => {
    const bytes = loadClip(log, req, ctx, new URL(req.url).pathname.slice(AUDIO_PREFIX.length));
    if (bytes instanceof Response) return bytes;
    const base = { "content-type": "audio/wav", "cache-control": "no-store", "accept-ranges": "bytes" };
    const range = parseRange(req.headers.get("range"), bytes.length);
    if (range === "none") return new Response(bytes, { headers: base });
    if (range === null) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { ...base, "content-range": `bytes */${bytes.length}` },
      });
    }
    const [start, end] = range;
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...base, "content-range": `bytes ${start}-${end}/${bytes.length}` },
    });
  };

const forbidden = () => new Response("Forbidden", { status: 403 });

export const handleRequest = async (
  req: Request,
  ctx: WebContext,
  log: Logger = createLogger(),
): Promise<Response> => {
  if (!checkHost(req, ctx.port)) return forbidden();
  if (req.method === "POST" && !checkSameOrigin(req, ctx.port)) return forbidden();
  const path = new URL(req.url).pathname;
  const handler =
    req.method === "GET"
      ? path.startsWith(AUDIO_PREFIX)
        ? path.endsWith(PEAKS_SUFFIX)
          ? peaksHandler(log)
          : audioHandler(log)
        : GET_ROUTES[path]
      : req.method === "POST" && path === "/settings"
        ? saveSettings
        : undefined;
  if (!handler) return new Response("Not Found", { status: 404 });
  try {
    return await handler(req, ctx);
  } catch (e) {
    log.error("request failed", { error: describeError(e) });
    return new Response("Internal Server Error", { status: 500 });
  }
};

const DEFAULT_PORT = 4777;

/** The port from SPEECH_COACH_PORT, or 4777 when it is unset or not a whole number from 1 to 65535. */
export const portFromEnv = (value: string | undefined): number => {
  const n = Number(value);
  return value !== undefined && /^\d+$/.test(value) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
};

export const startServer = ({
  db,
  port = DEFAULT_PORT,
  log,
  now,
  readAudio,
}: {
  db: Database;
  port?: number;
  log: Logger;
  now: () => Date;
  readAudio?: (id: string) => Result<Uint8Array | null>;
}) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (req) => handleRequest(req, ctx, log),
  });
  const ctx: WebContext = { db, now, port: server.port ?? port, readAudio };
  return server;
};
