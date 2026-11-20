import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { correction, escapeHtml, fullDate, htmlResponse, kindLabel, layout, localTime, redirect, shortDate } from "./html";

describe("escapeHtml", () => {
  test("escapes & < > \" and '", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  test("escapes & first so entities are not double-escaped wrongly", () => {
    expect(escapeHtml("<a href=\"x\">Tom & 'Jerry'</a>")).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
  });

  test("leaves plain text unchanged", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });
});

describe("layout", () => {
  const page = (title: string, active: string) => layout({ title, active, body: "<p>BODY</p>" });

  test("escapes the title", () => {
    const html = page("<script>alert(1)</script>", "/");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("includes body unescaped and links the stylesheet", () => {
    const html = page("T", "/");
    expect(html).toContain("<p>BODY</p>");
    expect(html).toContain('href="/style.css"');
  });

  test("loads Spectral from Google Fonts with display=swap and no other family", () => {
    const html = page("T", "/");
    expect(html).toMatch(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Spectral:ital,wght@0,400;0,600;1,400&amp;display=swap"/);
    expect(html).not.toMatch(/Instrument|Newsreader/);
  });

  test("puts the app name and the nav in a top header, with no sidebar", () => {
    const html = page("T", "/");
    expect(html).toMatch(/<header class="top"><span class="brand">Speech Coach<\/span><nav/);
    expect(html).not.toContain('class="side"');
  });

  test("has a nav link for every page", () => {
    const html = page("T", "/");
    for (const [href, label] of [
      ["/", "Today"],
      ["/calendar", "Calendar"],
      ["/repeats", "Repeats"],
      ["/search", "Search"],
      ["/settings", "Settings"],
    ]) {
      expect(html).toMatch(new RegExp(`<a[^>]*href="${href}"[^>]*>\\s*${label}\\s*</a>`));
    }
  });

  test("marks only the active nav link with aria-current=page", () => {
    const html = page("T", "/calendar");
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
    expect(html).toMatch(/<a[^>]*href="\/calendar"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/calendar"/);
  });
});

describe("layout attributes", () => {
  test("adds data-mood and data-page to <html> only when given, and loads the player script deferred", () => {
    const plain = layout({ title: "T", active: "/", body: "" });
    expect(plain).toContain('<html lang="en">');
    const tinted = layout({ title: "T", active: "/", body: "", mood: "good", page: "today" });
    expect(tinted).toContain('<html lang="en" data-mood="good" data-page="today">');
    expect(plain).toContain('<script src="/player.js" defer></script>');
  });
});

describe("correction", () => {
  test("numbers the mark for the stagger when given an index", () => {
    expect(correction("a", "b", 3)).toContain('<del class="said" style="--i:3">a</del>');
  });

  test("strikes the said words and shows the better words after them", () => {
    expect(correction("more fast", "faster")).toBe(
      '<span class="fix"><del class="said">more fast</del> <ins class="better">faster</ins></span>',
    );
  });

  test("escapes both parts and omits the insert when there is no better text", () => {
    const html = correction("<b>x</b>", "");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<ins");
    expect(correction("a", "<i>")).toContain("&lt;i&gt;");
  });
});

describe("kindLabel", () => {
  test("uses sentence-case group names", () => {
    expect(["grammar", "word", "filler", "sound"].map(kindLabel)).toEqual(["Grammar", "Word choice", "Fillers", "Sounds"]);
  });
});

describe("kindLabel with unknown kinds", () => {
  test("returns the kind itself for names on the object prototype", () => {
    expect(kindLabel("constructor")).toBe("constructor");
    expect(kindLabel("toString")).toBe("toString");
    expect(kindLabel("mystery")).toBe("mystery");
  });
});

describe("date formats", () => {
  test("shortDate and fullDate", () => {
    expect(shortDate("2026-10-14")).toBe("14 Oct");
    expect(shortDate("2026-11-05")).toBe("5 Nov");
    expect(fullDate("2026-11-19")).toBe("19 Nov 2026");
  });

  test("localTime applies the offset, and keeps an unreadable value", () => {
    expect(localTime("2026-11-20T04:51:00.000Z", () => -330)).toBe("20 Nov, 10:21");
    expect(localTime("2026-11-20T23:30:00.000Z", () => -330)).toBe("21 Nov, 05:00");
    expect(localTime("not a time", () => 0)).toBe("not a time");
  });
});

describe("layout active link", () => {
  test("active / marks only the Today link", () => {
    const html = layout({ title: "T", active: "/", body: "" });
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/"/);
  });
});

describe("responses", () => {
  test("htmlResponse defaults to 200 with html content type", async () => {
    const res = htmlResponse("<p>hi</p>");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<p>hi</p>");
  });

  test("htmlResponse accepts a status", () => {
    expect(htmlResponse("x", 404).status).toBe(404);
  });

  test("redirect returns 303 with Location", () => {
    const res = redirect("/settings");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
  });
});

describe("style.css", () => {
  let css = "";
  beforeAll(() => {
    css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
  });
  const selectors = [
    ".top", ".brand", "nav", ".fix", ".entries", ".word", ".issue", ".filter", "button.text", "button.primary",
    "form", "fieldset", "label", "input", "textarea", "select", ".vh", ".hero", ".daynum", ".dayname",
    ".cal-row", ".cal-month", ".cal-dots", ".dot", ".cal-0", ".cal-1", ".cal-2", ".cal-3", ".cal-4", ".cal-grey",
    ".cal-legend", "mark", ".empty", ".error", ".fixed", ".status-failed",
  ];

  test.each(selectors)("defines %s", (sel) => {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(css).toMatch(new RegExp(`(^|[\\s,}])${escaped}(?![\\w-])[^{}]*\\{`, "m"));
  });
});

describe("style.css rules", () => {
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

  test("has only the paper, ink, grey, rule and pen tokens, light and dark", () => {
    const light = css.slice(0, css.indexOf("@media"));
    const dark = css.slice(css.indexOf("prefers-color-scheme: dark"), css.indexOf("* {"));
    for (const [t, l, d] of [
      ["paper", "#FFFFFF", "#000000"],
      ["ink", "#000000", "#F2F2F2"],
      ["grey", "#6B6B6B", "#8C8C8C"],
      ["rule", "#E6E6E6", "#262626"],
      ["pen", "#D62718", "#FF5A47"],
    ]) {
      expect(light).toContain(`--${t}: ${l};`);
      expect(dark).toContain(`--${t}: ${d};`);
    }
  });

  test("uses Spectral with a Georgia fallback and no sans-serif, other fonts or old colours", () => {
    expect(css).toContain('"Spectral", Georgia, serif');
    expect(css).not.toMatch(/sans-serif|Instrument|Newsreader|system-ui|monospace/);
    expect(css).not.toMatch(/box-shadow:[^;]*rgb|(?<!linear-)gradient\(|text-transform:\s*uppercase|#3B4FD8|#0F6E5C/i);
  });

  test("respects reduced motion and shows a pen-colour focus ring", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toMatch(/:focus-visible \{ outline: 2px solid var\(--pen\)/);
  });

  test("has no sidebar, cards, pills, tables or bars left", () => {
    expect(css).not.toMatch(/\.side|\.card|\.pill|\.bar|table|\.word-card|border-radius: (?!50%|0)/);
  });

  test("calendar dots are 12px with a 5px gap and a 24px hit area, so 31 days fit the 600px content width", () => {
    expect(css).toMatch(/\.dot \{[^}]*width: 12px; height: 12px/);
    expect(css).toMatch(/\.cal-dots \{ display: flex; flex-wrap: wrap; gap: 6px 5px/);
    expect(css).toMatch(/a\.dot::after \{[^}]*inset: -6px/);
    const monthLabel = 48;
    expect(monthLabel + 31 * 12 + 30 * 5).toBeLessThanOrEqual(640 - 2 * 20);
  });

  test("defines mood papers as tokens, light and dark, and overrides --paper under data-mood", () => {
    const light = css.slice(0, css.indexOf("@media"));
    const dark = css.slice(css.indexOf("prefers-color-scheme: dark"), css.indexOf("* {"));
    for (const [t, l, d] of [
      ["paper-good", "#EEF3EE", "#101712"],
      ["paper-busy", "#FBF1E4", "#1C150D"],
    ]) {
      expect(light).toContain(`--${t}: ${l};`);
      expect(dark).toContain(`--${t}: ${d};`);
    }
    expect(css).toMatch(/\[data-mood="good"\] \{ --paper: var\(--paper-good\); \}/);
    expect(css).toMatch(/\[data-mood="busy"\] \{ --paper: var\(--paper-busy\); \}/);
    expect(css).not.toMatch(/\[data-mood="even"\]/);
  });

  test("draws the pen line as a gradient that grows once on the Today page, still drawn without motion or in print", () => {
    expect(css).toMatch(/\.fix del \{[^}]*linear-gradient\(var\(--pen\), var\(--pen\)\)[^}]*box-decoration-break: clone/);
    expect(css).toMatch(/@keyframes strike \{ from \{ background-size: 0% 1\.5px; \} to \{ background-size: 100% 1\.5px; \} \}/);
    expect(css).toMatch(/\[data-page="today"\] \.fix del \{[^}]*animation: strike 350ms ease-out both[^}]*min\(var\(--i, 0\), 17\) \* 50ms/);
    const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) { [data-page"));
    expect(reduce).toMatch(/^@media \(prefers-reduced-motion: reduce\) \{ \[data-page="today"\] \.fix del \{ animation: none; \}/);
    expect(css).toMatch(/@media print \{[^}]*\.fix del \{[^}]*line-through/);
  });

  test("keeps the pen line visible in forced-colors mode", () => {
    expect(css).toMatch(/@media \(forced-colors: active\) \{ \.fix del \{ background: none; text-decoration: line-through; \} \}/);
  });

  test("styles the waveform player with ink and pen lines and no box, shadow or pill", () => {
    expect(css).toMatch(/\.clip \{[^}]*display: flex/);
    expect(css).toMatch(/\.wave \.base \{ stroke: var\(--ink\); \}/);
    expect(css).toMatch(/\.wave \.done \{ stroke: var\(--pen\); \}/);
    expect(css).toMatch(/\.time \{[^}]*color: var\(--grey\)/);
    expect(css).toMatch(/\.play \{/);
  });

  test("limits the page to one 640px column", () => {
    expect(css).toMatch(/max-width: 640px/);
  });
});
