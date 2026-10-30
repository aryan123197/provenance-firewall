import { useState } from "react";
import { api, type PurchaseOrderRow, type Vendor } from "../api";
import { Card, Empty, ErrorNote } from "../components/ui";
import { usePoll } from "../hooks";
import { money } from "../labels";

const NAME_KEY = "pfw.approver";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};
const remember = (n: string) => {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* private mode */
  }
};

const blank: Vendor = { id: "", name: "", account: "", category: "" };

/**
 * The operator's trusted records. Everything the firewall trusts about who gets paid comes from here, so changing where an
 * existing vendor is paid is shown as the serious step it is, recorded in the signed audit log, and needs an explicit tick.
 */
export function RegistryScreen() {
  const { data, error, refresh } = usePoll(api.registry, 5000);

  return (
    <div className="stack">
      <p className="muted">
        These are the records the firewall trusts. A payee or account that does not match one of them cannot authorize a payment on its own, so changes here are operator-only and written to the signed audit log.
      </p>
      {error && <ErrorNote message={error} />}
      <VendorsCard vendors={data?.vendors ?? []} onSaved={refresh} />
      <OrdersCard vendors={data?.vendors ?? []} orders={data?.purchaseOrders ?? []} onSaved={refresh} />
    </div>
  );
}

function VendorsCard({ vendors, onSaved }: { vendors: Vendor[]; onSaved: () => void }) {
  const [form, setForm] = useState<Vendor>(blank);
  const [name, setName] = useState(readName);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | undefined>();

  const existing = vendors.find((v) => v.id === form.id);
  const accountChange = existing !== undefined && existing.account !== form.account;
  const set = (k: keyof Vendor) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!name.trim()) return setMsg({ ok: false, text: "Enter your name so this change is attributed to you." });
    remember(name.trim());
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await api.saveVendor({ ...form, name: form.name.trim(), account: form.account.trim() }, name.trim());
      setMsg({
        ok: true,
        text: r.accountChanged
          ? `${r.after.name} now pays into ${r.after.account} (was ${r.before?.account}). The change is in the audit log.`
          : `${r.after.name} saved.`,
      });
      setForm(blank);
      setAck(false);
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Vendors" aside={<span className="muted small">{vendors.length} registered</span>}>
      {vendors.length === 0 ? (
        <Empty title="No vendors yet">Add the vendors the agent may pay. Anything else needs a person's approval or is denied.</Empty>
      ) : (
        <table className="registry">
          <thead><tr><th>Id</th><th>Name</th><th>Pays into</th><th>Category</th><th /></tr></thead>
          <tbody>
            {vendors.map((v) => (
              <tr key={v.id}>
                <td data-label="Id"><code>{v.id}</code></td>
                <td data-label="Name">{v.name}</td>
                <td className="mono" data-label="Pays into">{v.account}</td>
                <td data-label="Category">{v.category}</td>
                <td data-label=""><button className="link" onClick={() => { setForm(v); setAck(false); setMsg(undefined); }}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="form-title">{existing ? `Edit ${existing.name}` : "Add a vendor"}</h3>
      <div className="form-grid">
        <label className="field"><span>Id</span><input value={form.id} onChange={set("id")} placeholder="acme" disabled={false} /></label>
        <label className="field"><span>Name (exactly as it appears on invoices)</span><input value={form.name} onChange={set("name")} placeholder="Acme Supplies" /></label>
        <label className="field"><span>PayPal email or PayPal ID</span><input value={form.account} onChange={set("account")} placeholder="payments@acme.example" /></label>
        <label className="field"><span>Category</span><input value={form.category} onChange={set("category")} placeholder="office_supplies" /></label>
      </div>
      {accountChange && (
        <div className="banner deny" role="alert">
          <strong>This changes where {existing.name} is paid.</strong> It is what a payee-swap attack tries to do, so only continue if you have confirmed the new account with the vendor yourself.
          <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I confirmed this change with the vendor directly</label>
        </div>
      )}
      <div className="actions">
        <label className="field"><span>Your name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="you@company.example" autoComplete="name" /></label>
        <div className="buttons">
          {existing && <button className="btn" onClick={() => { setForm(blank); setAck(false); }}>Cancel edit</button>}
          <button className="btn primary" onClick={save} disabled={busy || !form.id || !form.name || !form.account || !form.category || (accountChange && !ack)}>
            {busy ? "Saving…" : existing ? "Save changes" : "Add vendor"}
          </button>
        </div>
      </div>
      {msg && <p className={`result ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</p>}
    </Card>
  );
}

function OrdersCard({ vendors, orders, onSaved }: { vendors: Vendor[]; orders: PurchaseOrderRow[]; onSaved: () => void }) {
  const [form, setForm] = useState({ id: "", vendorId: "", amount: "", currency: "USD" });
  const [name, setName] = useState(readName);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | undefined>();
  const vendorName = (id: string) => vendors.find((v) => v.id === id)?.name ?? id;

  const save = async () => {
    const cents = Math.round(Number(form.amount) * 100);
    if (!name.trim()) return setMsg({ ok: false, text: "Enter your name so this change is attributed to you." });
    if (!Number.isFinite(cents) || cents < 0) return setMsg({ ok: false, text: "Enter the amount in dollars, for example 450.00." });
    remember(name.trim());
    setBusy(true);
    setMsg(undefined);
    try {
      await api.addPurchaseOrder({ id: form.id.trim(), vendorId: form.vendorId, amount: cents, currency: form.currency.trim().toUpperCase() }, name.trim());
      setMsg({ ok: true, text: `Purchase order ${form.id.trim()} added.` });
      setForm({ id: "", vendorId: form.vendorId, amount: "", currency: "USD" });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Purchase orders" aside={<span className="muted small">An order covers one payment, then closes</span>}>
      {orders.length === 0 ? (
        <Empty title="No purchase orders">An invoice amount that no order backs needs a person's approval.</Empty>
      ) : (
        <table className="registry">
          <thead><tr><th>Id</th><th>Vendor</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td data-label="Id"><code>{o.id}</code></td>
                <td data-label="Vendor">{vendorName(o.vendorId)}</td>
                <td data-label="Amount">{money(o.amount, o.currency)}</td>
                <td data-label="Status"><span className={`status-chip ${o.status === "open" ? "ok" : ""}`}>{o.status === "open" ? "Open" : "Paid and closed"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="form-title">Add a purchase order</h3>
      <div className="form-grid">
        <label className="field"><span>Id</span><input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="po-1042" /></label>
        <label className="field">
          <span>Vendor</span>
          <select value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })}>
            <option value="">Choose…</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Amount (dollars)</span><input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="450.00" /></label>
        <label className="field"><span>Currency</span><input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} maxLength={3} /></label>
      </div>
      <div className="actions">
        <label className="field"><span>Your name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="you@company.example" autoComplete="name" /></label>
        <div className="buttons">
          <button className="btn primary" onClick={save} disabled={busy || !form.id || !form.vendorId || !form.amount}>{busy ? "Adding…" : "Add purchase order"}</button>
        </div>
      </div>
      {msg && <p className={`result ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</p>}
    </Card>
  );
}
