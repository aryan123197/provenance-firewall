import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Policy } from "@pfw/core";
import type { Firewall } from "@pfw/firewall";
import { ApprovalStateError, type Store } from "@pfw/store";

export interface AppDeps {
  store: Store;
  firewall: Firewall;
  policy: Policy;
  policyYaml: string;
  /** "sandbox" talks to the PayPal sandbox; "simulated" uses an in-process fake. The dashboard shows which. */
  mode: "sandbox" | "simulated";
  /** Required as a Bearer token for operator actions unless `openOperator` is set. */
  operatorToken?: string;
  /** Lets anyone approve or reject. For public demos against simulated or sandbox money only. */
  openOperator?: boolean;
  scorecard?: () => unknown;
  /** Directory of the built dashboard, served at `/`. */
  staticDir?: string;
  /** Extra routes, registered under /api (the demo agent lives here). */
  extend?: (app: FastifyInstance) => void;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp(deps: AppDeps): FastifyInstance {
  const { store, firewall } = deps;
  const app = Fastify({ logger: false });

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
    const audit = store.audit.verify();
    return {
      mode: deps.mode,
      openOperator: Boolean(deps.openOperator),
      policy: { name: deps.policy.name, version: deps.policy.version, hash: deps.policy.hash },
      audit: audit.ok ? { ok: true, count: audit.count, head: audit.head } : { ok: false, seq: audit.seq, reason: audit.reason },
      driftOpen: store.listDrift("open").length,
      pendingApprovals: store.listApprovals("pending").length,
    };
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/decisions", async (req) => ({
    decisions: store.listDecisions({
      limit: Math.min(Number(req.query.limit ?? 200) || 200, 500),
      offset: Number(req.query.offset ?? 0) || 0,
    }),
  }));

  app.get<{ Params: { key: string } }>("/api/decisions/:key", async (req, reply) => {
    const rec = store.getDecisionRecord(req.params.key);
    return rec ?? reply.code(404).send({ error: "no such decision" });
  });

  app.get<{ Querystring: { status?: string } }>("/api/approvals", async (req, reply) => {
    const s = req.query.status;
    if (s && s !== "pending" && s !== "approved" && s !== "rejected") return reply.code(400).send({ error: "bad status" });
    return { approvals: store.listApprovals(s as "pending" | "approved" | "rejected" | undefined) };
  });

  const resolve = (approve: boolean) =>
    async (req: FastifyRequest<{ Params: { id: string }; Body: { approver?: string; note?: string } }>, reply: FastifyReply) => {
      const approver = req.body?.approver;
      if (typeof approver !== "string" || !approver.trim()) return reply.code(400).send({ error: "approver is required" });
      try {
        const input = { approver: approver.trim(), approve, ...(typeof req.body.note === "string" ? { note: req.body.note } : {}) };
        return await firewall.resolveApproval(req.params.id, input);
      } catch (e) {
        if (e instanceof ApprovalStateError) return reply.code(/unknown/.test(e.message) ? 404 : 409).send({ error: e.message });
        throw e;
      }
    };
  app.post<{ Params: { id: string }; Body: { approver?: string; note?: string } }>("/api/approvals/:id/approve", { preHandler: requireOperator }, resolve(true));
  app.post<{ Params: { id: string }; Body: { approver?: string; note?: string } }>("/api/approvals/:id/reject", { preHandler: requireOperator }, resolve(false));

  app.get("/api/drift", async () => ({ drift: store.listDrift() }));

  app.get("/api/policy", async () => ({
    policy: { ...deps.policy },
    yaml: deps.policyYaml,
  }));

  app.get<{ Querystring: { after?: string; limit?: string } }>("/api/audit", async (req) => ({
    entries: store.audit.entries({ after: Number(req.query.after ?? 0) || 0, limit: Math.min(Number(req.query.limit ?? 200) || 200, 1000) }),
  }));
  app.get("/api/audit/verify", async () => store.audit.verify());

  app.get("/api/scorecard", async (_req, reply) => {
    const card = deps.scorecard?.();
    return card ?? reply.code(404).send({ error: "no scorecard available" });
  });

  app.post("/api/webhooks/paypal", async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const out = await firewall.handleWebhook(headers, raw);
    return reply.code(out.status === "rejected" ? 400 : 200).send(out);
  });

  deps.extend?.(app);

  if (deps.staticDir && existsSync(deps.staticDir)) {
    void app.register(fastifyStatic, { root: deps.staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
