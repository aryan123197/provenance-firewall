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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
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
  resetDemo: () => post<{ ok: true }>("/api/demo/reset", {}),
};
