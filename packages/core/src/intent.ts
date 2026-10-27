import { z } from "zod";
import type { ProvenanceContext } from "./context";
import { tag, type Tagged } from "./provenance";

/** What the agent submits: each field is a handle, or a raw literal (treated as untrusted). */
// Everything here comes from the agent, so it is bounded: nothing it sends can bloat the database or the audit log, and
// names cannot carry control characters (newlines, NUL) into logs, notes or the dashboard.
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const text = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL, "must not contain control characters");

const FieldRef = z.union([
  z.object({ handle: text(200) }).strict(),
  // A literal is a number (an amount) or a short string. Objects, arrays and huge strings are never legitimate.
  z.object({ literal: z.union([z.number(), z.string().max(1000)]) }).strict(),
]);
export type FieldRef = z.infer<typeof FieldRef>;

export const ProposedIntentSchema = z
  .object({
    agentId: text(100),
    idempotencyKey: text(200),
    payee: FieldRef,
    account: FieldRef,
    /** Integer minor units (e.g. cents). */
    amount: FieldRef,
    currency: FieldRef,
    category: FieldRef,
  })
  .strict();
export type ProposedIntent = z.infer<typeof ProposedIntentSchema>;

const FIELD_VALUES = {
  payee: text(200),
  account: text(254),
  // At least one cent: a zero-amount payout is never what anyone meant, and approving one would only waste the approver's time.
  amount: z.number().int().positive("an amount must be at least one cent").safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  category: text(64),
} as const;

export interface ResolvedIntent {
  agentId: string;
  idempotencyKey: string;
  payee: Tagged<string>;
  account: Tagged<string>;
  amount: Tagged<number>;
  currency: Tagged<string>;
  category: Tagged<string>;
}

export type ResolveResult = { ok: true; intent: ResolvedIntent } | { ok: false; errors: string[] };

export function resolveIntent(input: unknown, ctx: ProvenanceContext): ResolveResult {
  const parsed = ProposedIntentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "intent"}: ${i.message}`) };
  }
  const p = parsed.data;
  const errors: string[] = [];
  const out: Partial<ResolvedIntent> = {};

  for (const name of Object.keys(FIELD_VALUES) as (keyof typeof FIELD_VALUES)[]) {
    const ref = p[name];
    let tagged: Tagged<unknown> | null;
    if ("handle" in ref) {
      tagged = ctx.resolve(ref.handle);
      if (!tagged) {
        errors.push(`${name}: unknown handle ${ref.handle}`);
        continue;
      }
    } else {
      tagged = tag(ref.literal, { kind: "literal", ref: `literal:${name}` });
    }
    const v = FIELD_VALUES[name].safeParse(tagged.value);
    if (!v.success) {
      errors.push(`${name}: ${v.error.issues[0]?.message ?? "invalid value"}`);
      continue;
    }
    (out as Record<string, unknown>)[name] = { ...tagged, value: v.data };
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, intent: { agentId: p.agentId, idempotencyKey: p.idempotencyKey, ...out } as ResolvedIntent };
}
