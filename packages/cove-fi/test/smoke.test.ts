import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";

describe("workspace", () => {
  it("builds and imports", () => {
    expect(typeof run).toBe("function");
  });
});
