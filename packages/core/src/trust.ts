/** Lower number = more trusted. A field takes the least trusted level of anything that contributed to it. */
export const TRUST = { T0: 0, T1: 1, T2: 2, T3: 3 } as const;
export type Trust = (typeof TRUST)[keyof typeof TRUST];

/** T0 stated by the user, T1 operator-maintained record, T2 derived from T0/T1 only, T3 untrusted or mixed. */
export function leastTrusted(levels: readonly Trust[]): Trust {
  if (levels.length === 0) throw new Error("leastTrusted: no inputs");
  return Math.max(...levels) as Trust;
}

/** True when the level may authorize a payment field without out-of-band confirmation. */
export function isTrusted(t: Trust): boolean {
  return t <= TRUST.T2;
}
