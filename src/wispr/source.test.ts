import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createWisprFixture, fixtureWav, snapshotNonAudio } from "../testing/wispr-fixture";
import {
  REQUIRED_COLUMNS,
  checkWisprColumns,
  listHistoryIds,
  openWisprReadOnly,
  readAudio,
  readAudioFromPath,
  readHistoryRows,
} from "./source";

let dir: string;
const open: Database[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wispr-source-"));
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const wav = fixtureWav("MARKER-A");

const setup = (rows: Parameters<typeof createWisprFixture>[1]) => {
  const fixture = createWisprFixture(dir, rows);
  open.push(fixture.db);
  const opened = openWisprReadOnly(fixture.path);
  if (!opened.ok) throw new Error(opened.error);
  open.push(opened.value);
  return { fixture, db: opened.value };
};

const sampleRows = [
  { transcriptEntityId: "a", asrText: "hello world", formattedText: "Hello world.", audio: wav, duration: 2.5, extraColumn: "keep" },
  { transcriptEntityId: "b", asrText: "no audio here", audio: null, needsUploading: 1, status: "raw_transcript" },
];

describe("openWisprReadOnly (INV-2)", () => {
  test("UPDATE, DELETE and INSERT each fail on the read-only handle", () => {
    const { db } = setup(sampleRows);
    expect(() => db.exec("UPDATE History SET audio = NULL")).toThrow(/readonly/i);
    expect(() => db.exec("DELETE FROM History")).toThrow(/readonly/i);
    expect(() =>
      db.exec("INSERT INTO History (transcriptEntityId) VALUES ('zzz')"),
    ).toThrow(/readonly/i);
  });

  test("returns err for a missing file", () => {
    const result = openWisprReadOnly(join(dir, "missing.sqlite"));
    expect(result.ok).toBe(false);
  });

  test("snapshotNonAudio and audio bytes are unchanged after every read function", () => {
    const { fixture, db } = setup(sampleRows);
    const before = snapshotNonAudio(fixture.db);
    const audioBefore = fixture.db.query("SELECT audio FROM History WHERE transcriptEntityId = 'a'").get() as { audio: Uint8Array };
    const audioBeforeCopy = new Uint8Array(audioBefore.audio);

    checkWisprColumns(db);
    const ids = listHistoryIds(db);
    readHistoryRows(db, ids);
    readAudio(db, "a");
    readAudio(db, "b");

    expect(snapshotNonAudio(fixture.db)).toBe(before);
    const audioAfter = fixture.db.query("SELECT audio FROM History WHERE transcriptEntityId = 'a'").get() as { audio: Uint8Array };
    expect(new Uint8Array(audioAfter.audio)).toEqual(audioBeforeCopy);
    expect(
      (fixture.db.query("SELECT COUNT(*) AS n FROM History").get() as { n: number }).n,
    ).toBe(2);
  });
});

describe("checkWisprColumns", () => {
  test("returns ok on the fixture", () => {
    const { db } = setup(sampleRows);
    expect(checkWisprColumns(db).ok).toBe(true);
  });

  test("returns err naming needsUploading when the column is missing", () => {
    const fixture = createWisprFixture(dir, sampleRows);
    fixture.db.exec("ALTER TABLE History DROP COLUMN needsUploading");
    fixture.db.close();
    const opened = openWisprReadOnly(fixture.path);
    if (!opened.ok) throw new Error(opened.error);
    open.push(opened.value);
    const result = checkWisprColumns(opened.value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("needsUploading");
  });

  test("REQUIRED_COLUMNS lists the ten needed columns", () => {
    expect([...REQUIRED_COLUMNS].sort()).toEqual(
      [
        "transcriptEntityId", "timestamp", "app", "duration", "asrText",
        "formattedText", "audio", "needsUploading", "status", "timezoneOffsetMinutes",
      ].sort(),
    );
  });
});

describe("listHistoryIds", () => {
  test("returns every History id", () => {
    const { db } = setup(sampleRows);
    expect([...listHistoryIds(db)].sort()).toEqual(["a", "b"]);
  });
});

describe("readHistoryRows", () => {
  test("maps columns and sets hasAudio, with no Uint8Array value", () => {
    const { db } = setup(sampleRows);
    const rows = readHistoryRows(db, ["a", "b"]);
    const a = rows.find((r) => r.id === "a");
    const b = rows.find((r) => r.id === "b");
    expect(a).toMatchObject({
      id: "a",
      app: "com.apple.Terminal",
      duration: 2.5,
      asrText: "hello world",
      formattedText: "Hello world.",
      status: "formatted",
      timezoneOffsetMinutes: -330,
      needsUploading: 0,
      hasAudio: true,
    });
    expect(b).toMatchObject({ id: "b", hasAudio: false, needsUploading: 1, status: "raw_transcript" });
    for (const row of rows) {
      for (const value of Object.values(row)) expect((value as unknown) instanceof Uint8Array).toBe(false);
      expect(typeof row.hasAudio).toBe("boolean");
      expect("audio" in row).toBe(false);
    }
  });

  test("returns only the requested ids", () => {
    const { db } = setup(sampleRows);
    expect(readHistoryRows(db, ["b"]).map((r) => r.id)).toEqual(["b"]);
    expect(readHistoryRows(db, [])).toEqual([]);
  });

  test("handles more ids than one 500-id chunk", () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({
      transcriptEntityId: `id-${i}`,
      asrText: `text ${i}`,
    }));
    const { db } = setup(many);
    const ids = listHistoryIds(db);
    expect(ids).toHaveLength(1200);
    const rows = readHistoryRows(db, ids);
    expect(rows).toHaveLength(1200);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1200);
  });
});

describe("readAudio", () => {
  test("returns the exact fixture bytes", () => {
    const { db } = setup(sampleRows);
    const audio = readAudio(db, "a");
    expect(audio).not.toBeNull();
    expect(Array.from(audio as Uint8Array)).toEqual(Array.from(wav));
  });

  test("returns null for a row with null audio", () => {
    const { db } = setup(sampleRows);
    expect(readAudio(db, "b")).toBeNull();
  });

  test("returns null for an unknown id", () => {
    const { db } = setup(sampleRows);
    expect(readAudio(db, "nope")).toBeNull();
  });
});

describe("readAudioFromPath", () => {
  test("returns the bytes, ok(null) for an unknown id, err for a missing file, and leaves Wispr unchanged", () => {
    const fixture = createWisprFixture(dir, sampleRows);
    open.push(fixture.db);
    const before = snapshotNonAudio(fixture.db);
    const got = readAudioFromPath(fixture.path, "a");
    expect(got.ok && got.value && Array.from(got.value)).toEqual(Array.from(wav));
    expect(readAudioFromPath(fixture.path, "nope")).toEqual({ ok: true, value: null });
    expect(readAudioFromPath(join(dir, "missing.sqlite"), "a").ok).toBe(false);
    expect(snapshotNonAudio(fixture.db)).toBe(before);
  });
});

const SRC = join(import.meta.dir, "..");

const productionFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === "testing" ? [] : productionFiles(full);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
  });

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("INV-2 source scan: Speech Coach never writes to Wispr", () => {
  const files = productionFiles(SRC).map((f) => ({ name: relative(SRC, f), text: stripComments(readFileSync(f, "utf8")) }));

  test("finds the production source files", () => {
    expect(files.map((f) => f.name)).toContain(join("wispr", "source.ts"));
  });

  test("only db/coach.ts and wispr/source.ts import a value from bun:sqlite, and the Wispr open is read-only", () => {
    const allowed = [join("db", "coach.ts"), join("wispr", "source.ts")];
    const bad: string[] = [];
    for (const { name, text } of files) {
      const valueImport = [...text.matchAll(/import\s+([^;]*?)\s+from\s+["']bun:sqlite["']/g)].some((m) => {
        const clause = m[1]!.trim();
        if (clause.startsWith("type ")) return false;
        const named = /\{([^}]*)\}/.exec(clause)?.[1];
        const hasDefaultOrNs = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim() !== "";
        return hasDefaultOrNs || (named ?? "").split(",").some((x) => x.trim() !== "" && !x.trim().startsWith("type "));
      });
      const other = /require\s*\(\s*["']bun:sqlite["']|import\s*\(\s*["']bun:sqlite["']|import\s+["']bun:sqlite["']|export\s[^;]*from\s+["']bun:sqlite["']/.test(text);
      if ((valueImport || other) && !allowed.includes(name)) bad.push(name);
    }
    expect(bad).toEqual([]);
    const source = files.find((f) => f.name === join("wispr", "source.ts"))!;
    const opens = [...source.text.matchAll(/new\s+Database\s*\(([^)]*)\)/g)];
    expect(opens.length).toBeGreaterThan(0);
    for (const m of opens) expect(m[1]).toMatch(/readonly:\s*true/);
    expect(source.text).not.toMatch(/Database\s*\.\s*open/);
  });

  test("the coach database module refuses Wispr Flow paths", () => {
    const coach = files.find((f) => f.name === join("db", "coach.ts"));
    expect(coach?.text).toContain("insideWisprFolder(file)");
  });

  test("no production code runs VACUUM, ATTACH, or write SQL on the History table", () => {
    const table = String.raw`["'\x60\[]?(?:main\.)?History["'\x60\]]?`;
    const forbidden = new RegExp(
      [
        String.raw`\bVACUUM\b`,
        String.raw`\bATTACH\b`,
        String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?${table}`,
        String.raw`\bDELETE\s+FROM\s+${table}`,
        String.raw`\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+${table}`,
      ].join("|"),
      "i",
    );
    const bad = files.filter((f) => forbidden.test(f.text)).map((f) => f.name);
    expect(bad).toEqual([]);
  });

  test("no file in src/wispr runs any write SQL", () => {
    const write = /\bDELETE\s+FROM\b|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b|\bREPLACE\s+INTO\b|\bUPDATE\s+\S+\s+SET\b|\bVACUUM\b|\bDROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b|\bALTER\s+TABLE\b|\bCREATE\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/i;
    const bad = files.filter((f) => f.name.startsWith("wispr") && write.test(f.text)).map((f) => f.name);
    expect(bad).toEqual([]);
  });
});
