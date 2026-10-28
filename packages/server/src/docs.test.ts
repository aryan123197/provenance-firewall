import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** Judges and contributors follow what the docs say. These checks keep the commands, links, settings and headline numbers they quote true. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const DOCS = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "THREAT_MODEL.md", "docs/SUBMISSION.md", "docs/PAYPAL_ASSUMPTIONS.md", "docs/ORDERS_DESIGN.md", "scripts/README.md"].filter((p) => existsSync(join(root, p)));
const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    if (["node_modules", "dist", ".git", "data"].includes(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("documented commands", () => {
  test("every `pnpm <script>` named in the docs is a script in package.json", () => {
    const builtins = new Set(["install", "i", "add", "run", "exec", "audit", "-r", "--filter", "-F", "dlx", "approve-builds", "store", "update", "up"]);
    const missing: string[] = [];
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/\bpnpm\s+([a-z][a-z0-9:_-]*)/g)) {
        const name = m[1]!;
        if (!builtins.has(name) && !(name in scripts)) missing.push(`${doc}: pnpm ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("documented links", () => {
  test("every relative markdown link points at a file that exists", () => {
    const broken: string[] = [];
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!.split("#")[0]!;
        if (!target || /^[a-z]+:/i.test(target)) continue;
        if (!existsSync(resolve(root, dirname(doc), target))) broken.push(`${doc}: ${m[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("documented settings", () => {
  const source = walk(join(root, "packages")).concat(walk(join(root, "scripts")), [join(root, "render.yaml")]).filter((p) => /\.(ts|tsx|yaml)$/.test(p) && !/\.test\.tsx?$/.test(p)).map((p) => readFileSync(p, "utf8")).join("\n");

  test("every environment variable in the README's settings table is read by the code", () => {
    const table = read("README.md");
    const names = new Set<string>();
    for (const line of table.split("\n")) {
      if (!line.startsWith("| `")) continue;
      const first = line.split("|")[1] ?? "";
      for (const m of first.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) names.add(m[1]!);
    }
    expect(names.size).toBeGreaterThan(10);
    expect([...names].filter((n) => !source.includes(n))).toEqual([]);
  });

  test("every variable in .env.example is read by the code", () => {
    const names = [...read(".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => !source.includes(n))).toEqual([]);
  });
});

describe("headline numbers", () => {
  const card = JSON.parse(read("reports/scorecard.json")) as {
    attacks: { total: number; baselineLost: number; firewalledLost: number; baselineAmount: number; firewalledAmount: number };
    scenarios: unknown[];
  };
  const WORDS: Record<string, number> = { sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, "twenty-one": 21, "twenty-two": 22, "twenty-three": 23, "twenty-four": 24, "twenty-five": 25, "twenty-six": 26 };
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);
  const NUMBER = "(\\d+|sixteen|seventeen|eighteen|nineteen|twenty(?:-[a-z]+)?)";
  const claims = (re: RegExp) => DOCS.flatMap((doc) => [...read(doc).matchAll(re)].map((m) => ({ doc, text: m[0], n: num(m[1]!) })));

  test("the number of scenarios quoted anywhere matches the scorecard", () => {
    const found = claims(new RegExp(`\\b${NUMBER}\\s+(?:attack and legitimate\\s+)?scenarios`, "gi"));
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((c) => c.n !== card.scenarios.length)).toEqual([]);
  });

  test("the number of attacks quoted anywhere matches the scorecard", () => {
    const found = claims(new RegExp(`\\b${NUMBER}\\s+attacks\\b`, "gi"));
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((c) => c.n !== card.attacks.total)).toEqual([]);
  });

  test("the dollar totals quoted next to them match the scorecard", () => {
    const usd = (minor: number) => `$${Math.round(minor / 100).toLocaleString("en-US")}`;
    const text = DOCS.map(read).join("\n");
    expect(text).toContain(usd(card.attacks.baselineAmount));
    expect(text).toContain(usd(card.attacks.firewalledAmount));
    // Any "$N" total in an attacks row that is not one of the two scorecard totals is stale.
    const rows = text.split("\n").filter((l) => /Attacks that moved money/i.test(l));
    for (const row of rows) for (const m of row.matchAll(/\$\d(?:[\d,]*\d)?/g)) expect([usd(card.attacks.baselineAmount), usd(card.attacks.firewalledAmount)]).toContain(m[0]);
  });
});
