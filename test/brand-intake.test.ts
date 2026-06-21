/**
 * Brand-intake routing (VIB-1878).
 *
 * Locks the acceptance contract: each "Bring your brand" channel produces a
 * `:root` block that the design checkpoint can render. Covers the deterministic
 * channels (colors, code) plus the brandvoice + styleguide seeding; the
 * disk/network channels (theme path, site URL) are exercised via their token
 * extractors elsewhere and are best-effort.
 */

import { describe, it, expect } from "vitest";
import { routeBrandIntake } from "../src/server/agent/brand-intake.js";

describe("routeBrandIntake", () => {
  it("parses labeled colors into semantic :root variables", async () => {
    const r = await routeBrandIntake({
      colors: "Primary: #e8613a\nInk #0f1115\nSurface #ffffff",
    });
    expect(r.channels).toContain("colors");
    expect(r.rootCss).toContain(":root");
    expect(r.cssVariables["--color-primary"]).toBe("#e8613a");
    expect(r.cssVariables["--color-ink"]).toBe("#0f1115");
    expect(r.styleguide).toMatch(/Brand colors/);
  });

  it("assigns positional slots to unlabeled colors", async () => {
    const r = await routeBrandIntake({ colors: "#112233, #445566, #778899" });
    expect(r.cssVariables["--color-primary"]).toBe("#112233");
    expect(r.cssVariables["--color-secondary"]).toBe("#445566");
    expect(r.cssVariables["--color-accent-1"]).toBe("#778899");
    expect(r.rootCss).toContain(":root");
  });

  it("extracts :root vars and fonts from pasted CSS code", async () => {
    const css = `:root { --brand: #e8613a; --bg: #0f1115; }
      h1 { font-family: "Space Grotesk", sans-serif; }
      body { font-family: "DM Sans", system-ui; }`;
    const r = await routeBrandIntake({ code: css });
    expect(r.channels).toContain("code");
    expect(r.cssVariables["--brand"]).toBe("#e8613a");
    expect(r.cssVariables["--bg"]).toBe("#0f1115");
    expect(r.cssVariables["--font-heading"]).toBe("Space Grotesk");
    expect(r.rootCss).toContain(":root");
  });

  it("captures the last :root declaration even without a trailing semicolon", async () => {
    const r = await routeBrandIntake({ code: ":root{--bg:#0f1115}" });
    expect(r.cssVariables["--bg"]).toBe("#0f1115");
    expect(r.rootCss).toContain("--bg: #0f1115");
  });

  it("stores tone of voice as the brandvoice asset", async () => {
    const r = await routeBrandIntake({ voice: "Direct, specific, no buzzword soup" });
    expect(r.channels).toContain("voice");
    expect(r.brandvoice).toBe("Direct, specific, no buzzword soup");
    expect(r.styleguide).toMatch(/Tone of voice/);
  });

  it("merges multiple channels and includes voice in the styleguide", async () => {
    const r = await routeBrandIntake({
      colors: "Brand #e8613a",
      voice: "Confident and concrete",
    });
    expect(r.channels).toEqual(expect.arrayContaining(["colors", "voice"]));
    expect(r.cssVariables["--color-brand"]).toBe("#e8613a");
    expect(r.styleguide).toMatch(/Confident and concrete/);
  });

  it("returns no channels for empty input (caller falls back to surprise-me)", async () => {
    const r = await routeBrandIntake({});
    expect(r.channels).toHaveLength(0);
    expect(r.rootCss).toBe("");
    expect(r.styleguide).toBeUndefined();
  });
});
