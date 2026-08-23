import { expect, test } from "bun:test";
import { PEANUT_VERSION } from "./index.ts";

test("version is set", () => {
  expect(PEANUT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
