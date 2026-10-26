import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { loadPolicy, type PurchaseOrder, type VendorRecord } from "@pfw/core";
import { Authority, PayPalAdapter, type PaymentAdapter, type WebhookVerifier } from "@pfw/adapter";
import { createFakePayPal } from "@pfw/adapter/testing";
import { Firewall } from "@pfw/firewall";
import { createSigner, Store } from "@pfw/store";
import { VENDORS, type Agent } from "@pfw/harness";
import { AnthropicPolicyCompiler, LlmAgent, createClient, type MessagesClient, type PolicyCompiler } from "@pfw/llm";
import { createApp, type Runtime } from "./app";
import { registerDemo } from "./demo";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface ServerConfig {
  databasePath: string;
  policyPath: string;
  staticDir: string;
  scorecardPath: string;
  port: number;
  host: string;
  paypal?: { clientId: string; clientSecret: string; webhookId?: string };
  authorityKey: string;
  auditKey?: string;
  operatorToken?: string;
  openOperator: boolean;
  /** Seeds the demo registry, exposes the scenario runner, and allows resets. */
  demo: boolean;
  /** JSON file of `{ vendors, purchaseOrders }`. The registry is operator-maintained, never agent-writable. */
  registryPath?: string;
  /** A live Claude client for the demo agent and the policy compiler. Defaults to one built from the environment, if any. */
  llm?: MessagesClient | null;
  /** Test seams. */
  compiler?: PolicyCompiler;
  llmAgent?: Agent;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const demo = env.DEMO_MODE === "1";
  const paypal =
    env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, ...(env.PAYPAL_WEBHOOK_ID ? { webhookId: env.PAYPAL_WEBHOOK_ID } : {}) }
      : undefined;
  return {
    databasePath: env.DATABASE_PATH ?? resolve(root, "data/pfw.db"),
    policyPath: env.POLICY_PATH ?? resolve(root, "policies/default.policy.yaml"),
    staticDir: env.STATIC_DIR ?? resolve(root, "packages/dashboard/dist"),
    scorecardPath: env.SCORECARD_PATH ?? resolve(root, "reports/scorecard.json"),
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    ...(paypal ? { paypal } : {}),
    authorityKey: env.AUTHORITY_KEY ?? randomBytes(32).toString("hex"),
    ...(env.AUDIT_SIGNING_KEY ? { auditKey: env.AUDIT_SIGNING_KEY } : {}),
    ...(env.OPERATOR_TOKEN ? { operatorToken: env.OPERATOR_TOKEN } : {}),
    openOperator: env.OPEN_OPERATOR === "1",
    demo,
    ...(env.REGISTRY_PATH ? { registryPath: env.REGISTRY_PATH } : {}),
  };
}

export interface Server {
  app: FastifyInstance;
  config: ServerConfig;
  mode: "sandbox" | "simulated";
  close(): Promise<void>;
}

export function buildServer(cfg: ServerConfig): Server {
  const policyYaml = readFileSync(cfg.policyPath, "utf8");
  const filePolicy = loadPolicy(policyYaml);
  const authority = new Authority(cfg.authorityKey);
  const mode = cfg.paypal ? "sandbox" : "simulated";

  const createRuntime = (): Runtime => {
    if (cfg.databasePath !== ":memory:") mkdirSync(dirname(cfg.databasePath), { recursive: true });
    const store = new Store({ path: cfg.databasePath, signer: createSigner(cfg.auditKey) });

    if (cfg.demo) {
      for (const v of VENDORS) store.upsertVendor(v);
    }
    if (cfg.registryPath && existsSync(cfg.registryPath)) {
      const reg = JSON.parse(readFileSync(cfg.registryPath, "utf8")) as { vendors?: VendorRecord[]; purchaseOrders?: PurchaseOrder[] };
      for (const v of reg.vendors ?? []) store.upsertVendor(v);
      for (const p of reg.purchaseOrders ?? []) {
        try {
          store.addPurchaseOrder(p);
        } catch {
          /* already loaded on a previous start */
        }
      }
    }

    let adapter: PaymentAdapter;
    let webhooks: WebhookVerifier | undefined;
    if (cfg.paypal) {
      const real = new PayPalAdapter({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret, authority, ...(cfg.paypal.webhookId ? { webhookId: cfg.paypal.webhookId } : {}) });
      adapter = real;
      if (cfg.paypal.webhookId) webhooks = real;
    } else {
      // No credentials: money moves only inside this process. The dashboard says "simulated".
      const fake = createFakePayPal();
      const sim = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch, webhookId: "WH-TEST" });
      adapter = sim;
      webhooks = sim;
    }
    const policyNow = () => store.activePolicy() ?? filePolicy;
    return { store, policy: policyNow, firewall: new Firewall({ store, adapter, authority, policy: policyNow, ...(webhooks ? { webhooks } : {}) }) };
  };

  let runtime = createRuntime();
  const readCard = () => (existsSync(cfg.scorecardPath) ? JSON.parse(readFileSync(cfg.scorecardPath, "utf8")) : undefined);

  const llm = cfg.llm === undefined ? createClient() : cfg.llm;
  const compiler = cfg.compiler ?? (llm ? new AnthropicPolicyCompiler(llm) : undefined);
  const llmAgent = cfg.llmAgent ?? (llm ? new LlmAgent({ client: llm }) : undefined);

  const app = createApp({
    runtime: () => runtime,
    policyYaml,
    ...(compiler ? { compiler } : {}),
    llmAgent: Boolean(llmAgent),
    mode,
    demo: cfg.demo,
    ...(cfg.operatorToken ? { operatorToken: cfg.operatorToken } : {}),
    openOperator: cfg.openOperator,
    scorecard: readCard,
    staticDir: cfg.staticDir,
    extend: (a, guard) => {
      if (!cfg.demo) return;
      registerDemo(a, {
        runtime: () => runtime,
        ...(llmAgent ? { llmAgent } : {}),
        reset: () => {
          runtime.store.close();
          if (cfg.databasePath !== ":memory:") for (const suffix of ["", "-wal", "-shm"]) rmSync(cfg.databasePath + suffix, { force: true });
          runtime = createRuntime();
        },
      }, guard);
    },
  });

  return {
    app,
    config: cfg,
    mode,
    close: async () => {
      await app.close();
      runtime.store.close();
    },
  };
}
