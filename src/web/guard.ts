export const checkHost = (req: Request, port: number): boolean => {
  const host = req.headers.get("host");
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
};

export const checkSameOrigin = (req: Request, port: number): boolean => {
  const origin = req.headers.get("origin");
  if (origin !== null) return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  return req.headers.get("sec-fetch-site") === "same-origin";
};
