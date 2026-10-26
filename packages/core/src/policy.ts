import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";

const Minor = z.number().int().nonnegative().safe();

/**
 * Tunable thresholds only. The provenance rules (untrusted payee, payee change,
 * new payee) are built into the engine and have no knobs, so a policy can never loosen them.
 */
export const PolicySchema = z
  .object({
    name: z.string().min(1),
    version: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    approvalThreshold: Minor,
    amountToleranceBps: z.number().int().min(0).max(10_000),
    limits: z.object({ perPayment: Minor, perVendorPerDay: Minor, totalPerDay: Minor }).strict(),
    allowedCategories: z.array(z.string().min(1)).min(1),
    velocity: z.object({ maxPerHour: z.number().int().positive() }).strict(),
  })
  .strict();

export type PolicyDoc = z.infer<typeof PolicySchema>;
export interface Policy extends PolicyDoc {
  /** sha256 of the canonical validated document; identifies the exact rules a decision used. */
  hash: string;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function hashPolicy(doc: PolicyDoc): string {
  return createHash("sha256").update(canonical(doc)).digest("hex");
}

/** Parses and validates policy YAML text. Throws with readable messages on invalid input. */
export function loadPolicy(yamlText: string): Policy {
  const parsed = PolicySchema.safeParse(parse(yamlText));
  if (!parsed.success) {
    throw new Error(`invalid policy: ${parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`).join("; ")}`);
  }
  return { ...parsed.data, hash: hashPolicy(parsed.data) };
}
