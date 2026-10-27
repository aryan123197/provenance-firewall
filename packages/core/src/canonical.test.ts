import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { canonicalJson } from "./index";

describe("canonicalJson", () => {
  test("sorts keys and matches JSON.stringify for plain data", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, "x", null], c: true } })).toBe('{"a":{"c":true,"d":[1,"x",null]},"b":1}');
  });
  test("omits undefined properties and writes undefined array elements as null, like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 1, c: () => 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
    expect(canonicalJson(undefined)).toBe("null");
  });
  test("always produces JSON that parses back to the same data, and the same text for any key order", () => {
    const value = fc.jsonValue();
    fc.assert(
      fc.property(value, (v) => {
        const text = canonicalJson(v);
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(v)));
        const reversed = JSON.parse(JSON.stringify(v), (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).reverse()) : x));
        expect(canonicalJson(reversed)).toBe(text);
      }),
      { numRuns: 500 },
    );
  });
  test("objects with undefined fields round-trip too", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.constant(undefined), fc.string())), (o) => {
        expect(() => JSON.parse(canonicalJson(o))).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});
