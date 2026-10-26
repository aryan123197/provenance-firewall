import type { Decision } from "@pfw/core";
import type { Approval, AuditEntry, DecisionRecord, DecisionSummary, Drift } from "@pfw/store";
import type { Scorecard, SideScore } from "@pfw/harness";

export type ScenarioResultView = Scorecard["scenarios"][number];

export type { Approval, AuditEntry, Decision, DecisionRecord, DecisionSummary, Drift, Scorecard, SideScore };

export interface Status {
  mode: "sandbox" | "simulated";
  demo: boolean;
  compilerAvailable: boolean;
  llmAgentAvailable: boolean;
  openOperator: boolean;
  policy: { name: string; version: number; hash: string };
  audit: { ok: true; count: number; head: { seq: number; hash: string } | null } | { ok: false; seq: number; reason: string };
  driftOpen: number;
  pendingApprovals: number;
}

export interface Vendor {
  id: string;
  name: string;
  account: string;
  category: string;
}

export interface PurchaseOrderRow {
  id: string;
  vendorId: string;
  amount: number;
  currency: string;
  status: "open" | "closed";
}

export interface VendorChange {
  before: Vendor | null;
  after: Vendor;
  accountChanged: boolean;
}

export interface PolicyTestResult {
  id: string;
  group: string;
  description: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface PolicyChange {
  path: string;
  label: string;
  before: string;
  after: string;
  direction: "looser" | "tighter" | "changed";
}

export interface CompileResult {
  baseVersion: number;
  english: string;
  summary: string;
  patch: unknown;
  unsupported: { clause: string; reason: string }[];
  examples: unknown[];
  diff: PolicyChange[];
  lint: string[];
  tests: PolicyTestResult[];
  canActivate: boolean;
}

export interface PolicyVersion {
  version: number;
  hash: string;
  sourceText: string | null;
  confirmedBy: string;
  createdAt: string;
  active: boolean;
}

export interface PolicyView {
  versions: PolicyVersion[];
  compilerAvailable: boolean;
  policy: {
    name: string;
    version: number;
    hash: string;
    currency: string;
    approvalThreshold: number;
    amountToleranceBps: number;
    limits: { perPayment: number; perVendorPerDay: number; totalPerDay: number };
    allowedCategories: string[];
    velocity: { maxPerHour: number };
    categoryApprovalThresholds: Record<string, number>;
    newPayeeDenyDays: number[];
  };
  yaml: string;
}

export interface DemoScenario {
  id: string;
  category: string;
  kind: "attack" | "legit";
  title: string;
  description: string;
  request: string;
}

export interface PayCallView {
  key: string;
  status: string;
  rule?: string;
  message: string;
}

export interface DemoRun {
  agent: string;
  agentKind: "scripted" | "llm";
  scenario: DemoScenario;
  baseline: { score: SideScore; calls: PayCallView[]; payouts: { receiver: string; amount: number; currency: string }[] };
  firewalled: { score: SideScore; calls: PayCallView[]; payouts: { receiver: string; amount: number; currency: string }[]; pendingApprovals: number };
}

export type ApprovalResult =
  | { status: "executed"; receipt: { amount: number; currency: string; receiver: string; reference: string } }
  | { status: "rejected" | "needs_approval" | "denied" | "execution_failed" | "invalid" }
  | { status: "blocked"; reason: string };

const TOKEN_KEY = "pfw.operatorToken";

/** The operator token lives in this tab's session storage only: it is not persisted and not sent anywhere but our API. */
export const operatorToken = {
  get(): string {
    try {
      return sessionStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
      return "";
    }
  },
  set(value: string) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: the token lasts until reload via the in-memory fallback below */
    }
    memory = value;
  },
};
let memory = "";
const currentToken = () => operatorToken.get() || memory;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = init?.method === "POST" ? currentToken() : "";
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (res.status === 401) throw new Error("Operator sign-in required: enter the operator token in the header, then try again.");
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  status: () => request<Status>("/api/status"),
  decisions: () => request<{ decisions: DecisionSummary[] }>("/api/decisions").then((r) => r.decisions),
  decision: (key: string) => request<DecisionRecord>(`/api/decisions/${encodeURIComponent(key)}`),
  approvals: () => request<{ approvals: Approval[] }>("/api/approvals").then((r) => r.approvals),
  resolve: (id: string, approve: boolean, approver: string, note: string) =>
    post<ApprovalResult>(`/api/approvals/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`, { approver, note: note || undefined }),
  registry: () => request<{ vendors: Vendor[]; purchaseOrders: PurchaseOrderRow[] }>("/api/registry"),
  saveVendor: (v: Vendor, changedBy: string) => post<VendorChange>("/api/registry/vendors", { ...v, changedBy }),
  addPurchaseOrder: (po: { id: string; vendorId: string; amount: number; currency: string }, changedBy: string) =>
    post<{ ok: true }>("/api/registry/purchase-orders", { ...po, changedBy }),
  drift: () => request<{ drift: Drift[] }>("/api/drift").then((r) => r.drift),
  policy: () => request<PolicyView>("/api/policy"),
  compilePolicy: (english: string) => post<CompileResult>("/api/policy/compile", { english }),
  activatePolicy: (c: CompileResult, confirmedBy: string, acknowledgeUnsupported: boolean) =>
    post<{ ok: true; version: number }>("/api/policy/activate", {
      baseVersion: c.baseVersion,
      patch: c.patch,
      english: c.english,
      examples: c.examples,
      unsupported: c.unsupported,
      confirmedBy,
      acknowledgeUnsupported,
    }),
  scorecard: () => request<Scorecard>("/api/scorecard"),
  auditVerify: () => request<{ ok: boolean; count?: number; reason?: string; seq?: number }>("/api/audit/verify"),
  scenarios: () => request<{ scenarios: DemoScenario[] }>("/api/demo/scenarios").then((r) => r.scenarios),
  runScenario: (scenarioId: string, agent: "scripted" | "llm", request?: string) => post<DemoRun>("/api/demo/run", { scenarioId, agent, ...(request ? { request } : {}) }),
  simulateDrift: (kind: "unauthorized" | "mismatch") => post<{ result: string }>("/api/demo/simulate-drift", { kind }),
  resetDemo: () => post<{ ok: true }>("/api/demo/reset", {}),
};
