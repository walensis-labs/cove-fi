import { describe, expect, it } from "vitest";
import { ENGINE } from "../src/index.js";

describe("workspace", () => {
  it("builds and imports", () => {
    expect(ENGINE).toBe("cove-fi");
  });
});
