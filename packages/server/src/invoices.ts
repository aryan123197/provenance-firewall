import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GullibleAgent, scenarioFromInvoiceDocs, type Agent, type InvoiceDoc } from "@pfw/harness";
import { LlmBudgetError, LlmRefusalError, ScanInputError, type InvoiceScanner, type ScannedInvoice } from "@pfw/llm";
import type { DemoRunner } from "./demo";
import type { Runtime } from "./app";

export interface InvoiceDeps {
  runtime: () => Runtime;
  runner: DemoRunner;
  /** Reads uploads with Claude. Absent without an API key, and the scan route says so. */
  scanner?: InvoiceScanner;
  llmAgent?: Agent;
}

const KEEP = 25;
/** Base64 of the largest accepted file, plus JSON overhead. */
const BODY_LIMIT = 8 * 1024 * 1024;

/** The scanned fields enter the agent as third-party text. Only a person-readable, bounded record of the scan is returned. */
const docOf = (s: ScannedInvoice): InvoiceDoc => ({
  kind: "invoice",
  id: s.id,
  vendor: s.vendor,
  ...(s.remitTo ? { remitTo: s.remitTo } : {}),
  total: s.total!,
  currency: s.currency,
  lineItems: s.lineItems,
  ...(s.note ? { note: s.note } : {}),
});

/**
 * Scan an uploaded invoice, then run it through the unprotected agent and the live firewall side by side. Reading a file moves no money;
 * running it does (simulated or sandbox), so running needs the operator guard like every demo run. Scans are kept in memory only.
 */
export function registerInvoices(app: FastifyInstance, deps: InvoiceDeps, guard: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const scans = new Map<string, ScannedInvoice>();

  app.get("/api/invoices", async () => ({ scanner: Boolean(deps.scanner), scans: [...scans.values()].reverse() }));

  app.post<{ Body: { mediaType?: string; data?: string } }>("/api/invoices/scan", { preHandler: guard, bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!deps.scanner) return reply.code(503).send({ error: "Scanning an invoice needs a Claude API key (ANTHROPIC_API_KEY) on the server." });
    try {
      const scanned = await deps.scanner.scan({ mediaType: String(req.body?.mediaType ?? ""), data: String(req.body?.data ?? "") });
      scans.delete(scanned.id);
      scans.set(scanned.id, scanned);
      while (scans.size > KEEP) scans.delete(scans.keys().next().value!);
      return scanned;
    } catch (e) {
      if (e instanceof ScanInputError) return reply.code(400).send({ error: e.message });
      if (e instanceof LlmBudgetError) return reply.code(429).send({ error: e.message });
      if (e instanceof LlmRefusalError) return reply.code(422).send({ error: e.message });
      return reply.code(502).send({ error: `The scan failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  app.post<{ Params: { id: string }; Body: { agent?: "scripted" | "llm"; request?: string } }>("/api/invoices/:id/run", { preHandler: guard }, async (req, reply) => {
    const scanned = scans.get(req.params.id);
    if (!scanned) return reply.code(404).send({ error: "unknown scan" });
    if (!scanned.usable) return reply.code(409).send({ error: "This scan could not be read reliably enough to run. Check the warnings." });
    if (req.body?.agent === "llm" && !deps.llmAgent) return reply.code(503).send({ error: "A live Claude agent needs a Claude API key (ANTHROPIC_API_KEY) on the server." });
    const agent = req.body?.agent === "llm" ? deps.llmAgent! : new GullibleAgent();

    // The registry and purchase orders are the operator's, read as they are now. What the user wants paid is decided from them,
    // not from the invoice: a registered vendor, a matching open purchase order. Anything else counts as lost.
    const { store } = deps.runtime();
    const request = typeof req.body?.request === "string" && req.body.request.trim() ? req.body.request.trim().slice(0, 500) : `Pay the invoice ${scanned.id}.`;
    const scenario = scenarioFromInvoiceDocs(
      [docOf(scanned)],
      {
        vendors: store.listVendors(),
        purchaseOrders: store.listPurchaseOrders().filter((p) => p.status === "open").map(({ id, vendorId, amount, currency }) => ({ id, vendorId, amount, currency })),
        request,
      },
      { id: "scan", title: "Scanned invoice", source: "read from an uploaded file" },
    );
    // The purchase orders already live in the store. Adding them again would open a second one for the same invoice.
    scenario.purchaseOrders = [];

    try {
      return await deps.runner.run(scenario, agent);
    } catch (e) {
      if (e instanceof LlmBudgetError) return reply.code(429).send({ error: e.message });
      if (e instanceof LlmRefusalError) return reply.code(422).send({ error: e.message });
      if (req.body?.agent === "llm") return reply.code(502).send({ error: `The Claude agent failed: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    }
  });
}
