import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  PolicyPatchSchema,
  applyPatch,
  diffPolicy,
  lintPolicy,
  runIntentExamples,
  runPolicyTests,
  type IntentExample,
  type Policy,
  type PolicyDoc,
  type PolicyTestResult,
  type UnsupportedClause,
} from "@pfw/core";
import type { Firewall } from "@pfw/firewall";
import { ApprovalStateError, PolicyConflictError, RegistryError, type Store } from "@pfw/store";
import { LlmBudgetError, LlmRefusalError, type PolicyCompiler } from "@pfw/llm";
import { z } from "zod";

/** The live pieces. A getter is used so a demo reset can swap in a fresh database. */
export interface Runtime {
  store: Store;
  firewall: Firewall;
  /** The active policy: the newest activated version, else the deployment's policy file. */
  policy: () => Policy;
}

export interface AppDeps {
  runtime: () => Runtime;
  policyYaml: string;
  /** Compiles plain-English policies. Absent without an API key, and the endpoint says so. */
  compiler?: PolicyCompiler;
  /** Whether a live Claude agent can drive the demo runner. */
  llmAgent?: boolean;
  /** "sandbox" talks to the PayPal sandbox; "simulated" uses an in-process fake. The dashboard shows which. */
  mode: "sandbox" | "simulated";
  /** Whether the demo scenario runner is mounted. The dashboard shows its controls only then. */
  demo?: boolean;
  /** Required as a Bearer token for operator actions unless `openOperator` is set. */
  operatorToken?: string;
  /** Lets anyone approve or reject. For public demos against simulated or sandbox money only. */
  openOperator?: boolean;
  scorecard?: () => unknown;
  /** Requests per minute per client IP. Absent or 0 means no limit. */
  rateLimitPerMinute?: number;
  trustProxy?: boolean;
  /** Directory of the built dashboard, served at `/`. */
  staticDir?: string;
  /** Extra routes, registered under /api (the demo agent lives here). */
  extend?: (app: FastifyInstance, guard: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => void;
}

/** A query-string integer clamped to [min, max]; anything that is not a finite number falls back to `fallback`. */
const intParam = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? fallback : Math.min(Math.max(Math.trunc(n), min), max);
};

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: Boolean(deps.trustProxy) });
  if (deps.rateLimitPerMinute) {
    // Public demos can be driven by anyone, and some routes cost money or move sandbox funds, so cap how fast one client can go.
    // Fixed one-minute windows per client IP, in memory (a restart resets them).
    const windows = new Map<string, { start: number; count: number }>();
    const max = deps.rateLimitPerMinute;
    app.addHook("onRequest", async (req, reply) => {
      const now = Date.now();
      if (windows.size > 10_000) for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
      const w = windows.get(req.ip);
      if (!w || now - w.start >= 60_000) {
        windows.set(req.ip, { start: now, count: 1 });
        return;
      }
      if (++w.count > max) {
        const wait = Math.ceil((60_000 - (now - w.start)) / 1000);
        return reply.code(429).header("retry-after", String(wait)).send({ statusCode: 429, error: `Too many requests. Try again in ${wait} seconds.` });
      }
    });
  }

  // Keep the raw body: PayPal's webhook signature covers the exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("invalid JSON"), { statusCode: 400 }), undefined);
    }
  });

  const requireOperator = async (req: FastifyRequest, reply: FastifyReply) => {
    if (deps.openOperator) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!deps.operatorToken || !same(token, deps.operatorToken)) {
      return reply.code(401).send({ error: "operator authentication required" });
    }
  };

  app.get("/api/status", async () => {
    const { store, policy: activePolicy } = deps.runtime();
    const policy = activePolicy();
    const audit = store.audit.verify();
    return {
      mode: deps.mode,
      demo: Boolean(deps.demo),
      openOperator: Boolean(deps.openOperator),
      policy: { name: policy.name, version: policy.version, hash: policy.hash },
      compilerAvailable: Boolean(deps.compiler),
      llmAgentAvailable: Boolean(deps.llmAgent),
      audit: audit.ok ? { ok: true, count: audit.count, head: audit.head } : { ok: false, seq: audit.seq, reason: audit.reason },
      driftOpen: store.listDrift("open").length,
      pendingApprovals: store.listApprovals("pending").length,
    };
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/decisions", async (req) => ({
    decisions: deps.runtime().store.listDecisions({
      limit: intParam(req.query.limit, 200, 1, 500),
      offset: intParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    }),
  }));

  app.get<{ Params: { key: string } }>("/api/decisions/:key", async (req, reply) => {
    const rec = deps.runtime().store.getDecisionRecord(req.params.key);
    return rec ?? reply.code(404).send({ error: "no such decision" });
  });

  app.get<{ Querystring: { status?: string } }>("/api/approvals", async (req, reply) => {
    const s = req.query.status;
    if (s && s !== "pending" && s !== "approved" && s !== "rejected") return reply.code(400).send({ error: "bad status" });
    return { approvals: deps.runtime().store.listApprovals(s as "pending" | "approved" | "rejected" | undefined) };
  });

  const resolve = (approve: boolean) =>
    async (req: FastifyRequest<{ Params: { id: string }; Body: { approver?: string; note?: string } }>, reply: FastifyReply) => {
      const approver = req.body?.approver;
      if (typeof approver !== "string" || !approver.trim()) return reply.code(400).send({ error: "approver is required" });
      try {
        const input = { approver: approver.trim(), approve, ...(typeof req.body.note === "string" ? { note: req.body.note } : {}) };
        return await deps.runtime().firewall.resolveApproval(req.params.id, input);
      } catch (e) {
        if (e instanceof ApprovalStateError) return reply.code(/unknown/.test(e.message) ? 404 : /too long/.test(e.message) ? 400 : 409).send({ error: e.message });
        throw e;
      }
    };
  app.post<{ Params: { id: string }; Body: { approver?: string; note?: string } }>("/api/approvals/:id/approve", { preHandler: requireOperator }, resolve(true));
  app.post<{ Params: { id: string }; Body: { approver?: string; note?: string } }>("/api/approvals/:id/reject", { preHandler: requireOperator }, resolve(false));

  // ---- Vendor registry and purchase orders: the operator's trust anchor ----
  app.get("/api/registry", async () => {
    const { store } = deps.runtime();
    return { vendors: store.listVendors(), purchaseOrders: store.listPurchaseOrders() };
  });

  const registryBody = z.object({ changedBy: z.string() });
  app.post<{ Body: Record<string, unknown> }>("/api/registry/vendors", { preHandler: requireOperator }, async (req, reply) => {
    const parsed = registryBody.extend({ id: z.string(), name: z.string(), account: z.string(), category: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "id, name, account, category and changedBy are all required." });
    const { changedBy, ...vendor } = parsed.data;
    try {
      return deps.runtime().store.changeVendor(vendor, changedBy);
    } catch (e) {
      if (e instanceof RegistryError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post<{ Body: Record<string, unknown> }>("/api/registry/purchase-orders", { preHandler: requireOperator }, async (req, reply) => {
    const parsed = registryBody.extend({ id: z.string(), vendorId: z.string(), amount: z.number(), currency: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "id, vendorId, amount (in cents), currency and changedBy are all required." });
    const { changedBy, ...po } = parsed.data;
    try {
      deps.runtime().store.changePurchaseOrder(po, changedBy);
      return { ok: true };
    } catch (e) {
      if (e instanceof RegistryError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get("/api/drift", async () => ({ drift: deps.runtime().store.listDrift() }));

  app.get("/api/policy", async () => {
    const { store, policy } = deps.runtime();
    return { policy: { ...policy() }, yaml: deps.policyYaml, versions: store.listPolicyVersions(), compilerAvailable: Boolean(deps.compiler) };
  });

  // ---- Plain-English policies: compile, review, confirm ----
  const examplesSchema = z
    .array(
      z.object({
        description: z.string().min(1),
        amount: z.number().nonnegative(),
        category: z.string().min(1),
        newPayee: z.boolean().optional(),
        weekday: z.number().int().min(0).max(6).optional(),
        expect: z.enum(["allow", "require_approval", "deny"]),
      }),
    )
    .transform((list): IntentExample[] =>
      list.map((e) => ({
        description: e.description,
        amount: e.amount,
        category: e.category,
        ...(e.newPayee ? { newPayee: true } : {}),
        ...(e.weekday !== undefined ? { weekday: e.weekday } : {}),
        expect: e.expect,
      })),
    );

  /** Everything the review screen shows, derived on the server from a patch so the client cannot misreport it. */
  const review = (active: PolicyDoc, patch: unknown, examples: IntentExample[]) => {
    const proposed = applyPatch(active, PolicyPatchSchema.parse(patch));
    const tests: PolicyTestResult[] = [...runIntentExamples(proposed, examples), ...runPolicyTests(proposed)];
    return {
      proposed,
      diff: diffPolicy(active, proposed),
      lint: lintPolicy(proposed),
      tests,
      canActivate: tests.every((t) => t.passed),
    };
  };

  app.post<{ Body: { english?: string } }>("/api/policy/compile", { preHandler: requireOperator }, async (req, reply) => {
    if (!deps.compiler) return reply.code(503).send({ error: "Plain-English policies need a Claude API key (ANTHROPIC_API_KEY) on the server." });
    const english = req.body?.english;
    if (typeof english !== "string" || !english.trim()) return reply.code(400).send({ error: "Write the policy you want first." });
    // The same limit the store enforces on activation, checked before a paid model call rather than after it.
    if (english.length > 4000) return reply.code(400).send({ error: "That policy text is too long (4,000 characters at most)." });
    const active = deps.runtime().policy();
    try {
      const out = await deps.compiler.compile(english, active);
      return { baseVersion: active.version, english, summary: out.summary, patch: out.patch, unsupported: out.unsupported, examples: out.examples, ...review(active, out.patch, out.examples) };
    } catch (e) {
      if (e instanceof LlmBudgetError) return reply.code(429).send({ error: e.message });
      if (e instanceof LlmRefusalError) return reply.code(422).send({ error: e.message });
      if (e instanceof z.ZodError) return reply.code(422).send({ error: "The compiled policy was not valid, so it was discarded. Try rephrasing." });
      return reply.code(502).send({ error: e instanceof Error ? e.message : "The compiler failed." });
    }
  });

  app.post<{
    Body: { baseVersion?: number; patch?: unknown; english?: string; unsupported?: UnsupportedClause[]; examples?: unknown; confirmedBy?: string; acknowledgeUnsupported?: boolean };
  }>("/api/policy/activate", { preHandler: requireOperator }, async (req, reply) => {
    const b = req.body ?? {};
    const { store, policy } = deps.runtime();
    const active = policy();
    if (typeof b.confirmedBy !== "string" || !b.confirmedBy.trim()) return reply.code(400).send({ error: "Say who is confirming this change." });
    if (typeof b.baseVersion !== "number") return reply.code(400).send({ error: "baseVersion is required." });
    const unsupported = Array.isArray(b.unsupported) ? b.unsupported : [];
    if (unsupported.length > 0 && b.acknowledgeUnsupported !== true) {
      return reply.code(400).send({ error: "Some clauses could not be turned into rules. Acknowledge that they will not be enforced." });
    }
    let examples: IntentExample[];
    let result: ReturnType<typeof review>;
    try {
      examples = examplesSchema.parse(b.examples ?? []);
      result = review(active, b.patch ?? {}, examples);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? `That change is not a valid policy: ${e.message}` : "invalid policy change" });
    }
    // Re-checked here, not trusted from the browser: nothing activates unless every test passes.
    if (!result.canActivate) return reply.code(422).send({ error: "Some tests fail, so this policy cannot be activated.", failed: result.tests.filter((t) => !t.passed) });
    try {
      const next = store.activatePolicy({
        baseVersion: b.baseVersion,
        doc: result.proposed,
        confirmedBy: b.confirmedBy,
        ...(typeof b.english === "string" ? { sourceText: b.english } : {}),
        patch: b.patch ?? {},
        note: { unsupportedAcknowledged: unsupported, examples, testsPassed: result.tests.length, lint: result.lint },
      });
      return { ok: true, version: next.version, hash: next.hash };
    } catch (e) {
      if (e instanceof PolicyConflictError) return reply.code(/too long/.test(e.message) ? 400 : 409).send({ error: e.message });
      throw e;
    }
  });

  app.get<{ Querystring: { after?: string; limit?: string } }>("/api/audit", async (req) => ({
    entries: deps.runtime().store.audit.entries({ after: intParam(req.query.after, 0, 0, Number.MAX_SAFE_INTEGER), limit: intParam(req.query.limit, 200, 1, 1000) }),
  }));
  // Everything needed to verify the log offline: `pnpm verify:audit <file>` checks it without trusting this server.
  app.get("/api/audit/export", async (_req, reply) => {
    reply.header("content-disposition", 'attachment; filename="audit-export.json"');
    return deps.runtime().store.audit.exportAll();
  });
  app.get("/api/audit/verify", async () => deps.runtime().store.audit.verify());

  app.get("/api/scorecard", async (_req, reply) => {
    const card = deps.scorecard?.();
    return card ?? reply.code(404).send({ error: "no scorecard available" });
  });

  app.post("/api/webhooks/paypal", async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const out = await deps.runtime().firewall.handleWebhook(headers, raw);
    return reply.code(out.status === "rejected" ? 400 : 200).send(out);
  });

  deps.extend?.(app, requireOperator);

  if (deps.staticDir && existsSync(deps.staticDir)) {
    void app.register(fastifyStatic, { root: deps.staticDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
