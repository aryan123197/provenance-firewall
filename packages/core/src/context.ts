import { formatHandle, parseHandle } from "./handles";
import { tag, type Tagged } from "./provenance";

/**
 * Harness-maintained label table. The harness registers every tool result and
 * trusted record here; the agent only ever refers to values by handle, so it
 * cannot claim a higher trust level than the source earned.
 */
export class ProvenanceContext {
  private readonly values = new Map<string, Tagged<unknown>>();

  register(handle: string, value: unknown): void {
    const h = parseHandle(handle);
    if (!h) throw new Error(`invalid handle: ${handle}`);
    const key = formatHandle(h);
    this.values.set(key, tag(value, { kind: h.kind, ref: key }));
  }

  resolve(handle: string): Tagged<unknown> | null {
    const h = parseHandle(handle);
    return h ? (this.values.get(formatHandle(h)) ?? null) : null;
  }
}
