import { z } from "zod";
import type { ProvenanceContext } from "./context";
import { tag, type Tagged } from "./provenance";

/** What the agent submits: each field is a handle, or a raw literal (treated as untrusted). */
const FieldRef = z.union([z.object({ handle: z.string() }).strict(), z.object({ literal: z.unknown() }).strict()]);
export type FieldRef = z.infer<typeof FieldRef>;

export const ProposedIntentSchema = z
  .object({
    agentId: z.string().min(1),
    idempotencyKey: z.string().min(1),
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
  payee: z.string().min(1),
  account: z.string().min(1),
  amount: z.number().int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  category: z.string().min(1),
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
