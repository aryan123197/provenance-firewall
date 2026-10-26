import { ORIGIN_KINDS, type OriginKind } from "./provenance";

export interface Handle {
  kind: OriginKind;
  id: string;
  field?: string;
}

const HANDLE_RE = /^([a-z]+):([A-Za-z0-9_.-]+)(?:#([A-Za-z0-9_.-]+))?$/;

/** Parses `kind:id` or `kind:id#field`, e.g. `vendor:acme` or `invoice:inv_204#total`. */
export function parseHandle(s: string): Handle | null {
  const m = HANDLE_RE.exec(s);
  if (!m) return null;
  const kind = m[1] as OriginKind;
  // `literal` is assigned by the firewall to raw strings; an agent cannot mint one as a handle.
  if (kind === "literal" || !ORIGIN_KINDS.includes(kind)) return null;
  const h: Handle = { kind, id: m[2]! };
  if (m[3] !== undefined) h.field = m[3];
  return h;
}

export function formatHandle(h: Handle): string {
  return `${h.kind}:${h.id}${h.field !== undefined ? `#${h.field}` : ""}`;
}
