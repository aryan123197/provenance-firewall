// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperatorSignIn } from "./App";
import { api, operatorToken, type Approval, type CompileResult, type PolicyView } from "./api";
import { Approvals } from "./screens/Approvals";
import { PolicyEditor } from "./screens/PolicyEditor";
import { RegistryScreen } from "./screens/Registry";

type Reply = { status?: number; body?: unknown };
type Route = Reply | ((init: RequestInit | undefined) => Reply);

/** Routes are "METHOD /path". Every call is recorded so a test can check exactly what was sent. */
function mockApi(routes: Record<string, Route>) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, path, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const route = routes[`${method} ${path}`];
      if (route === undefined) return new Response(JSON.stringify({ error: `no mock for ${method} ${path}` }), { status: 500 });
      const r = typeof route === "function" ? route(init) : route;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  operatorToken.set("");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("operator token", () => {
  test("is sent on writes only, and a 401 explains what to do", async () => {
    operatorToken.set("s3cret");
    const calls = mockApi({ "GET /api/registry": { body: { vendors: [], purchaseOrders: [] } }, "POST /api/registry/vendors": { status: 401, body: { error: "operator authentication required" } } });
    await api.registry();
    await expect(api.saveVendor({ id: "a1", name: "A", account: "a@x.example", category: "software" }, "dana")).rejects.toThrow(/Operator sign-in required/);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[1]!.headers.authorization).toBe("Bearer s3cret");
  });

  test("the sign-in control stores the token for this tab and can forget it", async () => {
    const user = userEvent.setup();
    render(<OperatorSignIn />);
    await user.click(screen.getByText("Operator sign-in"));
    await user.type(screen.getByLabelText("Operator token"), "tok-123");
    await user.click(screen.getByText("Use token"));
    expect(operatorToken.get()).toBe("tok-123");
    await user.click(screen.getByText(/Operator signed in/));
    expect(operatorToken.get()).toBe("");
    expect(screen.getByText("Operator sign-in")).toBeTruthy();
  });

  test("an empty token is not accepted", async () => {
    const user = userEvent.setup();
    render(<OperatorSignIn />);
    await user.click(screen.getByText("Operator sign-in"));
    await user.click(screen.getByText("Use token"));
    expect(operatorToken.get()).toBe("");
  });
});

describe("policy editor: nothing activates until it is safe and confirmed", () => {
  const view = (o: Partial<PolicyView> = {}): PolicyView => ({ compilerAvailable: true, versions: [], policy: {} as PolicyView["policy"], yaml: "", ...o });
  const pass = (n: string) => ({ id: n, group: "thresholds", description: `check ${n}`, expected: "allow", actual: "allow", passed: true });
  const result = (o: Partial<CompileResult> = {}): CompileResult => ({
    baseVersion: 1,
    english: "approve over $2k",
    summary: "Anything over $2,000 needs approval.",
    patch: { approvalThreshold: 200_000 },
    unsupported: [],
    examples: [],
    diff: [{ path: "approvalThreshold", label: "Approval needed above", before: "$500.00", after: "$2,000.00", direction: "looser" }],
    lint: [],
    tests: [pass("a"), pass("b")],
    canActivate: true,
    ...o,
  });

  async function compileWith(compile: CompileResult, onActivated = () => {}) {
    const calls = mockApi({
      "POST /api/policy/compile": { body: compile },
      "POST /api/policy/activate": { body: { ok: true, version: 2 } },
    });
    const user = userEvent.setup();
    render(<PolicyEditor view={view()} onActivated={onActivated} />);
    await user.type(screen.getByRole("textbox", { name: /what should the firewall do/i }), "approve over $2k");
    await user.click(screen.getByText("Compile to rules"));
    await screen.findByText("Review");
    return { user, calls, confirm: () => screen.getByRole("button", { name: /confirm and activate/i }) as HTMLButtonElement };
  }

  test("confirm needs a name, then sends exactly what was reviewed, as the named person", async () => {
    const activated = vi.fn();
    const { user, calls, confirm } = await compileWith(result(), activated);
    expect(screen.getByText("2 tests passed")).toBeTruthy();
    // Without a name, clicking confirm explains what is missing and sends nothing.
    await user.click(confirm());
    await screen.findByText(/Enter your name so this change is attributed to you/);
    expect(calls.some((c) => c.path === "/api/policy/activate")).toBe(false);
    await user.type(screen.getByPlaceholderText("you@company.example"), "dana@company.example");
    await user.click(confirm());
    await screen.findByText(/Policy version 2 is now active/);
    const sent = calls.find((c) => c.path === "/api/policy/activate")!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ baseVersion: 1, patch: { approvalThreshold: 200_000 }, confirmedBy: "dana@company.example", acknowledgeUnsupported: false, english: "approve over $2k" });
    expect(activated).toHaveBeenCalled();
  });

  test("clauses that could not be turned into rules must be acknowledged first", async () => {
    const { user, confirm } = await compileWith(result({ unsupported: [{ clause: "never pay after 6pm", reason: "Policies have no time-of-day rule." }] }));
    expect(screen.getByText(/could not be turned into rules and will not be enforced/)).toBeTruthy();
    expect(screen.getByText(/never pay after 6pm/)).toBeTruthy();
    await user.type(screen.getByPlaceholderText("you@company.example"), "dana");
    expect(confirm().disabled).toBe(true);
    await user.click(screen.getByRole("checkbox"));
    expect(confirm().disabled).toBe(false);
  });

  test("a failing test blocks activation however the other boxes are filled in, and says so", async () => {
    const failing = { ...pass("bad"), passed: false, description: "$500.00 is paid", expected: "allow", actual: "require approval" };
    const { user, confirm } = await compileWith(result({ tests: [pass("a"), failing], canActivate: false }));
    await user.type(screen.getByPlaceholderText("you@company.example"), "dana");
    expect(confirm().disabled).toBe(true);
    expect(screen.getByText("1 of 2 tests failed")).toBeTruthy();
    expect(screen.getByText(/1 test failed, so this policy cannot be activated/)).toBeTruthy();
    expect(screen.getByText(/expected allow, got require approval/)).toBeTruthy();
  });

  test("a compile that changes nothing cannot be activated", async () => {
    const { user, confirm } = await compileWith(result({ diff: [] }));
    await user.type(screen.getByPlaceholderText("you@company.example"), "dana");
    expect(screen.getByText(/Nothing in this policy would change/)).toBeTruthy();
    expect(confirm().disabled).toBe(true);
  });

  test("looser and stricter changes are labelled, and lint warnings are shown", async () => {
    await compileWith(
      result({
        diff: [
          { path: "approvalThreshold", label: "Approval needed above", before: "$500.00", after: "$2,000.00", direction: "looser" },
          { path: "newPayeeDenyDays", label: "New payees denied outright on", before: "never", after: "Sunday, Saturday", direction: "tighter" },
        ],
        lint: ["The approval threshold is above the per-payment cap."],
      }),
    );
    expect(screen.getByText("allows more")).toBeTruthy();
    expect(screen.getByText("stricter")).toBeTruthy();
    expect(screen.getByText(/above the per-payment cap/)).toBeTruthy();
  });

  test("a server refusal is shown and nothing is reported as active", async () => {
    mockApi({ "POST /api/policy/compile": { body: result() }, "POST /api/policy/activate": { status: 409, body: { error: "the active policy is now version 3" } } });
    const user = userEvent.setup();
    render(<PolicyEditor view={view()} onActivated={() => {}} />);
    await user.type(screen.getByRole("textbox"), "x");
    await user.click(screen.getByText("Compile to rules"));
    await screen.findByText("Review");
    await user.type(screen.getByPlaceholderText("you@company.example"), "dana");
    await user.click(screen.getByRole("button", { name: /confirm and activate/i }));
    await screen.findByText(/active policy is now version 3/);
    expect(screen.queryByText(/is now active/)).toBeNull();
  });

  test("without a Claude key the editor is disabled and says what is missing", () => {
    render(<PolicyEditor view={view({ compilerAvailable: false })} onActivated={() => {}} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByText("Compile to rules") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeTruthy();
  });
});

describe("registry: changing where a vendor is paid is a deliberate step", () => {
  const vendors = [{ id: "acme", name: "Acme Supplies", account: "acme@sandbox.example", category: "office_supplies" }];
  const routes = () => ({ "GET /api/registry": { body: { vendors, purchaseOrders: [] } } });

  test("editing the account shows a warning and the save button waits for confirmation", async () => {
    const calls = mockApi({
      ...routes(),
      "POST /api/registry/vendors": { body: { before: vendors[0], after: { ...vendors[0], account: "new@acme.example" }, accountChanged: true } },
    });
    const user = userEvent.setup();
    render(<RegistryScreen />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const save = () => screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save().disabled).toBe(false); // an edit that keeps the account needs no warning
    expect(screen.queryByText(/changes where/)).toBeNull();

    const account = screen.getByPlaceholderText("payments@acme.example");
    await user.clear(account);
    await user.type(account, "new@acme.example");
    expect(screen.getByText(/This changes where Acme Supplies is paid/)).toBeTruthy();
    await user.type(screen.getAllByPlaceholderText("you@company.example")[0]!, "dana@company.example");
    expect(save().disabled).toBe(true);
    await user.click(screen.getByLabelText(/I confirmed this change with the vendor directly/));
    expect(save().disabled).toBe(false);
    await user.click(save());

    await screen.findByText(/now pays into new@acme.example \(was acme@sandbox.example\)/);
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ id: "acme", account: "new@acme.example", changedBy: "dana@company.example" });
  });

  test("adding a brand-new vendor needs no warning", async () => {
    mockApi({ ...routes(), "POST /api/registry/vendors": { body: { before: null, after: { id: "beta", name: "Beta", account: "b@x.example", category: "software" }, accountChanged: false } } });
    const user = userEvent.setup();
    render(<RegistryScreen />);
    await screen.findByRole("cell", { name: "Acme Supplies" });
    await user.type(screen.getByPlaceholderText("acme"), "beta");
    await user.type(screen.getByPlaceholderText("Acme Supplies"), "Beta");
    await user.type(screen.getByPlaceholderText("payments@acme.example"), "b@x.example");
    await user.type(screen.getByPlaceholderText("office_supplies"), "software");
    await user.type(screen.getAllByPlaceholderText("you@company.example")[0]!, "dana");
    expect(screen.queryByText(/changes where/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add vendor" }));
    await screen.findByText("Beta saved.");
  });

  test("a rejected change shows the server's reason", async () => {
    mockApi({ ...routes(), "POST /api/registry/vendors": { status: 400, body: { error: "the account must be a PayPal email address or a 13-character PayPal ID" } } });
    const user = userEvent.setup();
    render(<RegistryScreen />);
    await screen.findByRole("cell", { name: "Acme Supplies" });
    await user.type(screen.getByPlaceholderText("acme"), "beta");
    await user.type(screen.getByPlaceholderText("Acme Supplies"), "Beta");
    await user.type(screen.getByPlaceholderText("payments@acme.example"), "nope");
    await user.type(screen.getByPlaceholderText("office_supplies"), "software");
    await user.type(screen.getAllByPlaceholderText("you@company.example")[0]!, "dana");
    await user.click(screen.getByRole("button", { name: "Add vendor" }));
    await screen.findByText(/must be a PayPal email address/);
  });

  test("saving without a name is refused before any request", async () => {
    const calls = mockApi(routes());
    const user = userEvent.setup();
    render(<RegistryScreen />);
    await screen.findByRole("cell", { name: "Acme Supplies" });
    await user.type(screen.getByPlaceholderText("acme"), "beta");
    await user.type(screen.getByPlaceholderText("Acme Supplies"), "Beta");
    await user.type(screen.getByPlaceholderText("payments@acme.example"), "b@x.example");
    await user.type(screen.getByPlaceholderText("office_supplies"), "software");
    await user.click(screen.getByRole("button", { name: "Add vendor" }));
    await screen.findByText(/Enter your name/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("approval inbox", () => {
  const tag = <T,>(value: T, trust: number, origin: { kind: string; ref: string }) => ({ value, trust, origins: [origin] });
  const fields = {
    payee: tag("Beta Software", 3, { kind: "invoice", ref: "invoice:inv_18#vendor" }),
    account: tag("beta@sandbox.example", 3, { kind: "invoice", ref: "invoice:inv_18#remitTo" }),
    amount: tag(80_000, 3, { kind: "invoice", ref: "invoice:inv_18#total" }),
    currency: tag("USD", 0, { kind: "user", ref: "user:req#currency" }),
    category: tag("software", 1, { kind: "vendor", ref: "vendor:beta#category" }),
  };
  const approval = {
    id: "apr_1",
    idempotencyKey: "k1",
    status: "pending",
    requestedAt: "2026-10-26T12:00:00.000Z",
    resolvedBy: null,
    resolvedAt: null,
    note: null,
    intent: { agentId: "procurement-agent", idempotencyKey: "k1", ...fields },
    decision: { verdict: "require_approval", rule: "approval_threshold", reason: "$800.00 is above the $500.00 approval threshold.", alert: false, findings: [], policy: { name: "default", version: 1, hash: "h" }, fields, evaluatedAt: "2026-10-26T12:00:00.000Z" },
  } as unknown as Approval;

  const inbox = (resolve: Route) => {
    let resolved = false;
    return mockApi({
      "GET /api/approvals": () => ({ body: { approvals: resolved ? [] : [approval] } }),
      "POST /api/approvals/apr_1/approve": (init) => {
        const r = typeof resolve === "function" ? resolve(init) : resolve;
        if ((r.status ?? 200) < 400 && (r.body as { status?: string }).status !== "blocked") resolved = true;
        return r;
      },
    });
  };

  test("shows what is being paid, why it was held and where each field came from", async () => {
    inbox({ body: {} });
    render(<Approvals open={() => {}} onChange={() => {}} />);
    await screen.findByText("Pay $800.00 to Beta Software");
    expect(screen.getByText(/above the \$500.00 approval threshold/)).toBeTruthy();
    expect(screen.getAllByText("Invoice text").length).toBeGreaterThan(0);
    expect(screen.getByText("Vendor registry")).toBeTruthy();
  });

  test("approving needs a name; it then pays, and the confirmation stays after the card leaves", async () => {
    const calls = inbox({ body: { status: "executed", receipt: { amount: 80_000, currency: "USD", receiver: "beta@sandbox.example", reference: "B1" } } });
    const user = userEvent.setup();
    render(<Approvals open={() => {}} onChange={() => {}} />);
    const approve = await screen.findByRole("button", { name: /Approve and pay \$800.00/ });

    await user.click(approve);
    await screen.findByText(/Enter your name/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await user.type(screen.getByPlaceholderText("you@company.example"), "dana@company.example");
    await user.type(screen.getByPlaceholderText(/confirmed with the vendor by phone/), "called them");
    await user.click(approve);

    const notice = await screen.findByText(/Approved and paid \$800.00 to Beta Software/);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ approver: "dana@company.example", note: "called them" });
    // The card disappears on the next refresh; the outcome must not.
    await waitFor(() => expect(screen.queryByText("Pay $800.00 to Beta Software")).toBeNull(), { timeout: 4000 });
    expect(notice.isConnected).toBe(true);
    const list = notice.closest("ul")!;
    await userEvent.setup().click(within(list).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Approved and paid/)).toBeNull();
  }, 10_000);

  test("when approval would break a hard limit the card stays and says why", async () => {
    inbox({ body: { status: "blocked", reason: "This would take Beta Software past the daily limit." } });
    const user = userEvent.setup();
    render(<Approvals open={() => {}} onChange={() => {}} />);
    await screen.findByText("Pay $800.00 to Beta Software");
    await user.type(screen.getByPlaceholderText("you@company.example"), "dana");
    await user.click(screen.getByRole("button", { name: /Approve and pay/ }));
    await screen.findByText(/Cannot approve: This would take Beta Software past the daily limit/);
    expect(screen.getByText("Pay $800.00 to Beta Software")).toBeTruthy();
  });

  test("an expired or missing token is explained in the card", async () => {
    inbox({ status: 401, body: { error: "operator authentication required" } });
    const user = userEvent.setup();
    render(<Approvals open={() => {}} onChange={() => {}} />);
    await screen.findByText("Pay $800.00 to Beta Software");
    await user.type(screen.getByPlaceholderText("you@company.example"), "dana");
    await user.click(screen.getByRole("button", { name: /Approve and pay/ }));
    await screen.findByText(/Operator sign-in required/);
    expect(screen.getByText("Pay $800.00 to Beta Software")).toBeTruthy();
  });

  test("an empty inbox says so", async () => {
    mockApi({ "GET /api/approvals": { body: { approvals: [] } } });
    render(<Approvals open={() => {}} onChange={() => {}} />);
    await screen.findByText("Nothing waiting for you");
  });
});
