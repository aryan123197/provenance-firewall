import { describe, expect, test } from "vitest";
import { AdapterError, PAYOUT_EVENTS, PayPalWebhooks, parsePayPalEvent } from "./index";
import { createFakePayPal } from "./testing/fake-paypal";

const setup = () => {
  const fake = createFakePayPal();
  return { fake, hooks: new PayPalWebhooks({ clientId: "test-id", clientSecret: "test-secret", baseUrl: "http://localhost:9999", fetch: fake.fetch }) };
};

describe("PayPalWebhooks", () => {
  test("registers the payout events at an https url and returns the id to use as PAYPAL_WEBHOOK_ID", async () => {
    const { fake, hooks } = setup();
    const r = await hooks.register("https://firewall.example.com/api/webhooks/paypal");
    expect(r).toMatchObject({ id: "FAKEHOOK1", url: "https://firewall.example.com/api/webhooks/paypal" });
    expect(r.events).toEqual([...PAYOUT_EVENTS]);
    const sent = fake.calls.find((c) => c.path === "/v1/notifications/webhooks")?.body as { url: string; event_types: { name: string }[] };
    expect(sent.url).toBe("https://firewall.example.com/api/webhooks/paypal");
    expect(sent.event_types.map((e) => e.name)).toEqual([...PAYOUT_EVENTS]);
  });
  test("every event it subscribes to is one reconciliation can read", () => {
    for (const name of PAYOUT_EVENTS) {
      const kind = name.startsWith("PAYMENT.PAYOUTSBATCH.") ? { batch_header: { payout_batch_id: "B" } } : { payout_batch_id: "B" };
      expect(parsePayPalEvent({ id: "E", event_type: name, resource: kind }), name).not.toBeNull();
    }
  });
  test("refuses urls PayPal cannot deliver to, before any request", async () => {
    const { fake, hooks } = setup();
    for (const bad of ["http://firewall.example.com/hook", "https://localhost/hook", "https://127.0.0.1/hook", "not a url", ""]) {
      await expect(hooks.register(bad)).rejects.toBeInstanceOf(AdapterError);
    }
    expect(fake.calls).toHaveLength(0);
  });
  test("lists and removes registrations, and refuses malformed ids", async () => {
    const { hooks } = setup();
    const a = await hooks.register("https://a.example.com/h");
    await hooks.register("https://b.example.com/h");
    expect((await hooks.list()).map((w) => w.url)).toEqual(["https://a.example.com/h", "https://b.example.com/h"]);
    await hooks.remove(a.id);
    expect(await hooks.list()).toHaveLength(1);
    await expect(hooks.remove("../x")).rejects.toBeInstanceOf(AdapterError);
    await expect(hooks.remove("NOSUCHHOOK1")).rejects.toMatchObject({ httpStatus: 404 });
  });
});
