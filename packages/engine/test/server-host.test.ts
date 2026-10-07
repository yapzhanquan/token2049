import { describe, expect, it } from "vitest";
import { engineHostname } from "../src/server";

describe("engine binds loopback by default", () => {
  it("localhost / no host → 127.0.0.1; ENGINE_HOST overrides; explicit hosts kept", () => {
    expect(engineHostname({}, new URL("http://localhost:4000"))).toBe("127.0.0.1");
    expect(engineHostname({ ENGINE_HOST: "0.0.0.0" }, new URL("http://localhost:4000"))).toBe("0.0.0.0");
    expect(engineHostname({}, new URL("http://127.0.0.1:4000"))).toBe("127.0.0.1");
    expect(engineHostname({}, new URL("http://[::1]:4000"))).toBe("::1");
  });
});
