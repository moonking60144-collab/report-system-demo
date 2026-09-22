import test from "node:test";
import assert from "node:assert/strict";
import { resolveRequestClientIdentity } from "../../src/infra/requestClientIdentity";

test("resolveRequestClientIdentity：不把 untrusted X-Forwarded-For 當 effectiveIp", () => {
  const identity = resolveRequestClientIdentity({
    ip: "10.0.0.5",
    header(name: string) {
      const headers: Record<string, string> = {
        "x-forwarded-for": "203.0.113.10, 10.0.0.5",
        "x-real-ip": "10.0.0.6",
        "user-agent": "test-agent",
      };
      return headers[name.toLowerCase()];
    },
  });

  assert.equal(identity.ip, "10.0.0.5");
  assert.equal(identity.effectiveIp, "10.0.0.5");
  assert.equal(identity.forwardedFor, "203.0.113.10, 10.0.0.5");
});
