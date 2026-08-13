import { describe, expect, it } from "vitest";
import { RETURNS_ANNUAL } from "../src/data/returnsAnnual.js";

describe("vendored return series", () => {
  it("is contiguous 1928..>=2023 ascending", () => {
    expect(RETURNS_ANNUAL[0]!.year).toBe(1928);
    expect(RETURNS_ANNUAL.at(-1)!.year).toBeGreaterThanOrEqual(2023);
    for (let i = 1; i < RETURNS_ANNUAL.length; i++)
      expect(RETURNS_ANNUAL[i]!.year).toBe(RETURNS_ANNUAL[i - 1]!.year + 1);
  });
  it("spot-checks match published values (transcription tripwire)", () => {
    const y = (n: number) => RETURNS_ANNUAL.find(r => r.year === n)!;
    expect(y(1928).sp500).toBeCloseTo(0.4381, 2);   // Damodaran: 43.81%
    expect(y(1931).sp500).toBeCloseTo(-0.4384, 2);  // -43.84%
    expect(y(2008).sp500).toBeCloseTo(-0.3655, 2);  // -36.55%
    expect(y(1980).inflation).toBeCloseTo(0.1252, 2); // CPI-U 1980 ~12.5%
  });
  it("values are sane", () => {
    for (const r of RETURNS_ANNUAL) {
      expect(r.sp500).toBeGreaterThan(-0.9); expect(r.sp500).toBeLessThan(1.0);
      expect(r.inflation).toBeGreaterThan(-0.15); expect(r.inflation).toBeLessThan(0.25);
    }
  });
  it("tbill spot-checks match published values (transcription tripwire)", () => {
    const y = (n: number) => RETURNS_ANNUAL.find(r => r.year === n)!;
    // 1981: Damodaran histretSP.xls "Returns by year" and the published histretSP.html table both
    // give 14.04%, confirmed against two independently-fetched sources on 2026-08-13.
    expect(y(1981).tbill).toBeCloseTo(0.1404, 2);
    expect(y(2021).tbill).toBeCloseTo(0.0004, 2);
    expect(y(1940).tbill).toBeCloseTo(0.0004, 2);
    expect(y(2007).tbill).toBeCloseTo(0.0448, 2);
  });
  it("tbill values are in a sane range", () => {
    for (const r of RETURNS_ANNUAL) {
      expect(r.tbill).toBeGreaterThan(-0.01);
      expect(r.tbill).toBeLessThan(0.2);
    }
  });
  it("mean tbill 1928-2025 is in a sane historical range", () => {
    const mean = RETURNS_ANNUAL.reduce((sum, r) => sum + r.tbill, 0) / RETURNS_ANNUAL.length;
    expect(mean).toBeGreaterThan(0.032);
    expect(mean).toBeLessThan(0.038);
  });
});
