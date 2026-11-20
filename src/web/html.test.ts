import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { correction, cutPhrase, escapeHtml, fullDate, htmlResponse, kindLabel, kindRing, layout, localTime, redirect, shortDate } from "./html";

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

  test("loads Alegreya and Alegreya Sans from Google Fonts with display=swap and no other family", () => {
    const html = page("T", "/");
    expect(html).toMatch(
      /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Alegreya:ital,wght@0,400;0,500;0,700;1,400&amp;family=Alegreya\+Sans:ital,wght@0,400;0,500;0,700;1,400&amp;display=swap"/,
    );
    expect(html).not.toMatch(/Spectral|Instrument|Newsreader/);
  });

  test("puts the header and the page inside one sheet", () => {
    const html = page("T", "/");
    expect(html).toMatch(/<body><div class="sheet"><header class="top">[\s\S]*<\/header><main><p>BODY<\/p><\/main><\/div><\/body>/);
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
      '<span class="fix" data-b="faster"><del class="said">more fast</del> <ins class="better">faster</ins></span>',
    );
  });

  test("a known kind picks its mark class, an unknown or missing kind keeps the plain strike", () => {
    expect(correction("a", "b", undefined, "word")).toContain('<span class="fix k-word" data-b="b">');
    expect(correction("a", "b", undefined, "sound")).toContain('class="fix k-sound"');
    expect(correction("a", "b", undefined, "constructor")).toContain('<span class="fix" ');
    expect(correction("a", "b")).not.toContain("k-");
  });

  test("a filler loops only the words the better version drops", () => {
    expect(correction("to, you know, convert", "to convert", 2, "filler")).toBe(
      '<span class="fix k-filler" data-b="to convert"><del class="said" style="--i:2">to, <span class="cut">you know,</span> convert</del> <ins class="better">to convert</ins></span>',
    );
    expect(correction("um", "", undefined, "filler")).toBe(
      '<span class="fix k-filler"><del class="said"><span class="cut">um</span></del></span>',
    );
  });

  test("escapes the better words in the width-reserving attribute", () => {
    expect(correction("a", '"><script>')).toContain('data-b="&quot;&gt;&lt;script&gt;"');
  });

  test("escapes both parts and omits the insert when there is no better text", () => {
    const html = correction("<b>x</b>", "");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<ins");
    expect(html).not.toContain("data-b");
    expect(correction("a", "<i>")).toContain("&lt;i&gt;");
  });
});

describe("cutPhrase", () => {
  test("loops separate dropped runs, ignoring case and punctuation when matching the better words", () => {
    expect(cutPhrase("Like, are these", "Are these")).toBe('<span class="cut">Like,</span> are these');
    expect(cutPhrase("there we I was only able to see like what we say", "I was only able to see what we call")).toBe(
      '<span class="cut">there we</span> I was only able to see <span class="cut">like</span> what we <span class="cut">say</span>',
    );
  });

  test("loops the whole phrase when nothing is kept, nothing is dropped or there is no better text", () => {
    expect(cutPhrase("blah blah", "")).toBe('<span class="cut">blah blah</span>');
    expect(cutPhrase("a b", "a b")).toBe('<span class="cut">a b</span>');
    expect(cutPhrase("a b", "x y")).toBe('<span class="cut">a b</span>');
  });

  test("escapes the said words", () => {
    expect(cutPhrase("<b>x</b> y", "y")).toBe('<span class="cut">&lt;b&gt;x&lt;/b&gt;</span> y');
  });
});

describe("kindRing", () => {
  test("gives each known kind its circled code, hidden from assistive tech, and nothing for an unknown kind", () => {
    expect(["grammar", "word", "filler", "sound"].map(kindRing)).toEqual([
      '<span class="ring" aria-hidden="true">gr</span>',
      '<span class="ring" aria-hidden="true">wc</span>',
      '<span class="ring" aria-hidden="true">fl</span>',
      '<span class="ring" aria-hidden="true">so</span>',
    ]);
    expect(kindRing("constructor")).toBe("");
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
  const light = css.slice(0, css.indexOf("@media"));
  const dark = css.slice(css.indexOf("prefers-color-scheme: dark"), css.indexOf("* {"));

  test("has the proof-sheet colour tokens, light and dark", () => {
    for (const [t, l, d] of [
      ["desk", "#EEF1F5", "#121418"],
      ["sheet", "#FFFFFF", "#1B1E23"],
      ["ink", "#1C1E22", "#E8EAEE"],
      ["graphite", "#5A6070", "#9EA5B2"],
      ["rule", "#DDE3EB", "#2C313A"],
      ["nonrepro", "#8DB8E2", "#375C82"],
      ["red", "#C42B1C", "#FF7A6B"],
      ["blue", "#1D5BB3", "#86B6FF"],
      ["green", "#2E7D4F", "#6BCB93"],
    ]) {
      expect(light).toContain(`--${t}: ${l};`);
      expect(dark).toContain(`--${t}: ${d};`);
    }
  });

  test("uses Alegreya and Alegreya Sans with fallbacks, and none of the old fonts or colours", () => {
    expect(css).toContain('"Alegreya", Georgia, serif');
    expect(css).toContain('"Alegreya Sans", "Gill Sans", system-ui, sans-serif');
    expect(css).not.toMatch(/Spectral|Instrument|Newsreader|monospace/);
    expect(css).not.toMatch(/box-shadow:[^;]*rgb|text-transform:\s*uppercase|#3B4FD8|#0F6E5C/i);
    expect(css.match(/(?<!linear-)(?<!repeating-linear-)gradient\(/g)).toBeNull();
  });

  test("respects reduced motion and shows a blue focus ring", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toMatch(/:focus-visible \{ outline: 2px solid var\(--blue\)/);
  });

  test("has no sidebar, cards, pills, tables or bars left", () => {
    expect(css).not.toMatch(/\.side|\.card|\.pill|\.bar|table|\.word-card|border-radius: (?!50%|0)/);
  });

  test("calendar days are 14px tally cells with a 5px gap and a hit area past the cell, so 31 days fit the 560px content width", () => {
    expect(css).toMatch(/\.dot \{[^}]*width: 14px; height: 22px/);
    expect(css).toMatch(/\.cal-dots \{ display: flex; flex-wrap: wrap; gap: 6px 5px/);
    expect(css).toMatch(/a\.dot::after \{[^}]*inset: -6px/);
    const monthLabel = 48;
    expect(monthLabel + 31 * 14 + 30 * 5).toBeLessThanOrEqual(900 - 2 * 32 - 2 * 24);
  });

  test("draws one tally stroke per bucket step, from none for the calmest day to four", () => {
    for (const n of [0, 1, 2, 3, 4]) expect(css).toContain(`.cal-${n} { --n: ${n}; }`);
    expect(css).toMatch(/\.dot::before \{[^}]*width: calc\(var\(--n, 0\) \* 3px\)[^}]*repeating-linear-gradient\(90deg, var\(--red\)/);
  });

  test("defines mood sheets as tokens, light and dark, and overrides --sheet under data-mood", () => {
    for (const [t, l, d] of [
      ["sheet-good", "#F0F8F3", "#19261F"],
      ["sheet-busy", "#FCF1EF", "#2A1F20"],
    ]) {
      expect(light).toContain(`--${t}: ${l};`);
      expect(dark).toContain(`--${t}: ${d};`);
    }
    expect(css).toMatch(/\[data-mood="good"\] \{ --sheet: var\(--sheet-good\); \}/);
    expect(css).toMatch(/\[data-mood="busy"\] \{ --sheet: var\(--sheet-busy\); \}/);
    expect(css).not.toMatch(/\[data-mood="even"\]/);
  });

  test("draws the red strike as a gradient that grows once on the Today page, still drawn without motion or in print", () => {
    expect(css).toMatch(/\.fix del \{[^}]*linear-gradient\(var\(--red\), var\(--red\)\)[^}]*box-decoration-break: clone/);
    expect(css).toMatch(/@keyframes strike \{ from \{ background-size: 0% 1\.5px; \} to \{ background-size: 100% 1\.5px; \} \}/);
    expect(css).toMatch(/\[data-page="today"\] \.fix del \{[^}]*animation: strike 420ms ease-out both[^}]*min\(var\(--i, 0\), 17\) \* 50ms/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \[data-page="today"\] \.fix del \{ animation: none; \} \}/);
    expect(css).toMatch(/@media print \{[^}]*\.fix[^{]*del \{[^}]*line-through/);
  });

  test("gives each kind its own mark: strike, delete loop, blue circle, dotted underline, none of them drawn in", () => {
    expect(css).toMatch(/\.fix\.k-filler del, \.fix\.k-word del, \.fix\.k-sound del \{ background: none; animation: none; \}/);
    expect(css).toMatch(/\.fix \.cut \{[^}]*border: 1\.5px solid var\(--red\)/);
    expect(css).toMatch(/\.fix\.k-word del \{[^}]*border: 1\.5px solid var\(--blue\)/);
    expect(css).toMatch(/\.fix\.k-sound del \{[^}]*underline dotted var\(--red\)/);
  });

  test("writes the fix above the words and moves it under them in a narrow line", () => {
    expect(css).toMatch(/\.fix ins \{ position: absolute;[^}]*bottom: calc\(100% - 1\.15em\)/);
    expect(css).toMatch(/\.fix::after \{ content: attr\(data-b\); display: block; height: 0;[^}]*visibility: hidden/);
    expect(css).toMatch(/@container line \(max-width: 24rem\) \{[\s\S]*?\.fix ins \{ position: static; display: block;/);
    expect(css).toMatch(/\.line \{[^}]*overflow-wrap: anywhere;[^}]*container: line \/ inline-size/);
  });

  test("keeps every mark visible in forced-colors mode", () => {
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\.fix:not\(\.k-filler\):not\(\.k-word\):not\(\.k-sound\) del \{ background: none; text-decoration: line-through; \}/);
    expect(forced).toMatch(/\.fix \.cut \{ text-decoration: line-through; \}/);
    expect(forced).toMatch(/\.fix \.cut::after \{ background: CanvasText; \}/);
  });

  test("styles the waveform player with graphite and red lines and no box, shadow or pill", () => {
    expect(css).toMatch(/\.clip \{[^}]*display: flex/);
    expect(css).toMatch(/\.wave \.base \{ stroke: var\(--graphite\); \}/);
    expect(css).toMatch(/\.wave \.done \{ stroke: var\(--red\);/);
    expect(css).toMatch(/\.time \{[^}]*color: var\(--graphite\)/);
    expect(css).toMatch(/\.play \{/);
    expect(css).toMatch(/\.play:disabled \{[^}]*opacity: 0\.45/);
  });

  test("sets the sheet at 900px with a 200px margin column above 720px and notes under the line below", () => {
    expect(css).toMatch(/\.sheet \{[^}]*max-width: 900px/);
    expect(css).toContain("--margin: 200px;");
    expect(css).toMatch(/@media \(min-width: 720px\) \{[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--margin\)/);
    expect(css).toMatch(/nav a\[aria-current="page"\]::after \{[^}]*border: 1\.5px solid var\(--red\)/);
  });
});
