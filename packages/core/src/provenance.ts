import { TRUST, leastTrusted, type Trust } from "./trust";

export const ORIGIN_KINDS = ["user", "vendor", "po", "invoice", "email", "web", "tool", "literal"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/** Trust is fixed by where a value came from. Callers never choose it. */
const KIND_TRUST: Record<OriginKind, Trust> = {
  user: TRUST.T0,
  vendor: TRUST.T1,
  po: TRUST.T1,
  invoice: TRUST.T3,
  email: TRUST.T3,
  web: TRUST.T3,
  tool: TRUST.T3,
  literal: TRUST.T3, // a raw string typed by the model may have been copied from injected text
};

export interface Origin {
  kind: OriginKind;
  /** Handle (or description for literals) identifying the exact source, e.g. `invoice:inv_204#total`. */
  ref: string;
}

export interface Tagged<T> {
  readonly value: T;
  readonly trust: Trust;
  readonly origins: readonly Origin[];
}

export function trustOfOrigin(o: Origin): Trust {
  return KIND_TRUST[o.kind];
}

export function tag<T>(value: T, origin: Origin): Tagged<T> {
  return { value, trust: trustOfOrigin(origin), origins: [origin] };
}

/**
 * Combine inputs into a new value. Trust is the least trusted input, and a value
 * computed from T0/T1 inputs is T2 (derived), never better than its inputs.
 */
export function derive<T>(value: T, inputs: readonly Tagged<unknown>[]): Tagged<T> {
  const worst = leastTrusted(inputs.map((i) => i.trust));
  const trust = Math.max(worst, TRUST.T2) as Trust;
  const seen = new Set<string>();
  const origins: Origin[] = [];
  for (const i of inputs)
    for (const o of i.origins) {
      const key = `${o.kind}|${o.ref}`;
      if (!seen.has(key)) {
        seen.add(key);
        origins.push(o);
      }
    }
  return { value, trust, origins };
}
