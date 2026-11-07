/**
 * Accessibility and layout check of the built dashboard, in a real browser.
 *
 *   pnpm build && pnpm ui:check
 *
 * Starts the demo server on a free port (simulated PayPal, in-memory database), runs a few scenarios so every screen has data, then
 * opens each screen at phone, tablet and laptop widths in light and dark and fails on:
 *   - any axe-core violation of WCAG 2.1 A or AA, and
 *   - any horizontal page scroll (the page is wider than the window).
 * Needs a Chromium: `pnpm exec playwright install chromium` (CI does this; the pre-installed one in cloud sandboxes already matches).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { chromium } from "playwright";

// The root tsconfig has no DOM library; the browser callback below only touches these two members.
declare const document: { documentElement: { scrollWidth: number; clientWidth: number } };

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn("pnpm", ["exec", "tsx", "packages/server/src/main.ts"], {
  env: { ...process.env, DEMO_MODE: "1", OPEN_OPERATOR: "1", DATABASE_PATH: ":memory:", PORT: String(port), HOST: "127.0.0.1" },
  stdio: ["ignore", "inherit", "inherit"],
});
const stop = () => server.kill("SIGTERM");
process.on("exit", stop);

let failures = 0;
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) break;
    if (i === 99) throw new Error("the demo server did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
  for (const scenarioId of ["inj-note-redirect", "legit-po-match", "swap-account-field", "legit-new-vendor"]) {
    await fetch(`${base}/api/demo/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenarioId }) }).catch(() => undefined);
  }
  const key = ((await (await fetch(`${base}/api/decisions`)).json()) as { decisions: { idempotencyKey: string }[] }).decisions[0]?.idempotencyKey;
  const routes = ["#/activity", "#/approvals", "#/registry", "#/policy", ...(key ? [`#/decision/${encodeURIComponent(key)}`] : [])];

  const browser = await chromium.launch();
  const sizes = [
    ["phone", { width: 390, height: 844 }],
    ["tablet", { width: 768, height: 900 }],
    ["laptop", { width: 1280, height: 900 }],
  ] as const;
  let screens = 0;
  for (const [name, viewport] of sizes) {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await (await browser.newContext({ viewport, colorScheme })).newPage();
      for (const route of routes) {
        await page.goto(`${base}/${route}`);
        await page.waitForSelector("main", { state: "attached" });
        await page.waitForTimeout(800);
        await page.addScriptTag({ content: axeSource });
        const res = await page.evaluate(async () => {
          // @ts-expect-error axe is injected into the page above
          const axe = window.axe as { run: (o: unknown) => Promise<{ violations: { id: string; help: string; nodes: { target: unknown[] }[] }[] }> };
          const r = await axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] });
          return { violations: r.violations.map((v) => ({ id: v.id, help: v.help, targets: v.nodes.slice(0, 3).map((n) => String(n.target[0])) })), scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
        });
        screens++;
        const where = `${name} ${colorScheme} ${route.slice(0, 18)}`;
        for (const v of res.violations) {
          failures++;
          console.log(`FAIL  ${where}: axe ${v.id}: ${v.help} (${v.targets.join(", ")})`);
        }
        if (res.scrollWidth > res.clientWidth) {
          failures++;
          console.log(`FAIL  ${where}: the page scrolls sideways (${res.scrollWidth}px content in a ${res.clientWidth}px window)`);
        }
      }
    }
  }
  await browser.close();
  console.log(failures ? `\n${failures} problem(s) across ${screens} screens.` : `All ${screens} screens pass: no WCAG 2.1 A/AA violations, no sideways page scroll.`);
} catch (e) {
  failures++;
  console.error(e instanceof Error ? e.message : e);
} finally {
  stop();
}
process.exit(failures ? 1 : 0);
