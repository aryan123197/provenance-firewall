import { expect, test } from "vitest";
import { PACKAGE } from "./index";

test("package loads", () => {
  expect(PACKAGE).toBe("@pfw/firewall");
});
