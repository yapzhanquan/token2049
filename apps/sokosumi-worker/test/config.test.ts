import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const base = { SOKOSUMI_COWORKER_ID: "cw", ENGINE_TOKEN: "t" } as NodeJS.ProcessEnv;

describe("config", () => {
  it("reads the org slug and accepts MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX as an alias", () => {
    const c = loadConfig({ ...base, SOKOSUMI_ORGANIZATION_ID: "org", SOKOSUMI_ORGANIZATION_SLUG: "bulkhead-3qb9jz", MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX: "0" });
    expect(c.organizationId).toBe("org");
    expect(c.organizationSlug).toBe("bulkhead-3qb9jz");
    expect(c.gate.seller.supportedPaymentSourceIndex).toBe(0);
  });
  it("MASUMI_PAYMENT_SOURCE_INDEX wins and must be an integer", () => {
    expect(loadConfig({ ...base, MASUMI_PAYMENT_SOURCE_INDEX: "1", MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX: "0" }).gate.seller.supportedPaymentSourceIndex).toBe(1);
    expect(() => loadConfig({ ...base, MASUMI_PAYMENT_SOURCE_INDEX: "x" })).toThrow(/integer/);
    expect(() => loadConfig({ ...base, SOKOSUMI_ORGANIZATION_SLUG: "Bad Slug" })).toThrow(/slug/);
  });
});
