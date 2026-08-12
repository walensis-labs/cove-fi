import { describe, expect, it } from "vitest";
import { IRS_LIMITS_2026, RMD_TABLE } from "../../src/model.js";

describe("primary-source pins", () => {
  it("RMD divisors match IRS Pub 590-B Uniform Lifetime Table", () => {
    // IRS Publication 590-B (2024 rev.), Appendix B, Table III (Uniform Lifetime)
    expect(RMD_TABLE[73]).toBe(26.5);
    expect(RMD_TABLE[80]).toBe(20.2);
    expect(RMD_TABLE[90]).toBe(12.2);
    expect(RMD_TABLE[100]).toBe(6.4);
  });
  it("2026 contribution limits match IRS announcements", () => {
    // IRS Notice 2025-67 (401(k)/IRA COLA) and Rev. Proc. 2025-19 (HSA)
    expect(IRS_LIMITS_2026["401k"]).toBe(24_500);
    expect(IRS_LIMITS_2026["ira"]).toBe(7_500);
    expect(IRS_LIMITS_2026["hsa_family"]).toBe(8_750);
  });
});
