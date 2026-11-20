import { describe, expect, test } from "bun:test";
import { checkHost, checkSameOrigin } from "./guard";

const req = (headers: Record<string, string>) =>
  new Request("http://127.0.0.1:4777/x", { method: "POST", headers });

describe("checkHost", () => {
  test.each(["127.0.0.1:4777", "localhost:4777"])("accepts %s", (host) => {
    expect(checkHost(req({ host }), 4777)).toBe(true);
  });

  test.each(["evil.com", "127.0.0.1:80", "localhost", "evil.com:4777", "127.0.0.1:4777.evil.com"])(
    "rejects %s",
    (host) => {
      expect(checkHost(req({ host }), 4777)).toBe(false);
    },
  );

  test("rejects a missing Host", () => {
    const r = { headers: new Headers() } as unknown as Request;
    expect(checkHost(r, 4777)).toBe(false);
  });

  test("uses the given port", () => {
    expect(checkHost(req({ host: "localhost:5000" }), 5000)).toBe(true);
    expect(checkHost(req({ host: "localhost:4777" }), 5000)).toBe(false);
  });
});

describe("checkSameOrigin", () => {
  test.each(["http://127.0.0.1:4777", "http://localhost:4777"])("accepts Origin %s", (origin) => {
    expect(checkSameOrigin(req({ origin }), 4777)).toBe(true);
  });

  test.each(["http://evil.com", "null", "https://127.0.0.1:4777", "http://localhost:80"])(
    "rejects Origin %s",
    (origin) => {
      expect(checkSameOrigin(req({ origin }), 4777)).toBe(false);
    },
  );

  test("accepts Sec-Fetch-Site same-origin when Origin is absent", () => {
    expect(checkSameOrigin(req({ "sec-fetch-site": "same-origin" }), 4777)).toBe(true);
  });

  test("rejects Sec-Fetch-Site cross-site and none when Origin is absent", () => {
    expect(checkSameOrigin(req({ "sec-fetch-site": "cross-site" }), 4777)).toBe(false);
    expect(checkSameOrigin(req({ "sec-fetch-site": "none" }), 4777)).toBe(false);
  });

  test("rejects when neither header is present", () => {
    expect(checkSameOrigin(req({}), 4777)).toBe(false);
  });

  test("a bad Origin is not rescued by Sec-Fetch-Site same-origin", () => {
    expect(
      checkSameOrigin(req({ origin: "http://evil.com", "sec-fetch-site": "same-origin" }), 4777),
    ).toBe(false);
  });
});
