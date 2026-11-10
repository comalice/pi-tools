import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveBindAddress, validateBindAddress } from "../src/shared/bind.ts";

describe("bind address", () => {
  it("accepts IPv4 and IPv6 literals", () => {
    assert.equal(validateBindAddress("127.0.0.1"), "127.0.0.1");
    assert.equal(validateBindAddress("192.0.2.10"), "192.0.2.10");
    assert.equal(validateBindAddress("::1"), "::1");
    assert.equal(validateBindAddress("::"), "::");
  });

  it("uses the CLI value, then the environment, then loopback", () => {
    assert.equal(resolveBindAddress(), "127.0.0.1");
    assert.equal(resolveBindAddress(undefined, "192.0.2.20"), "192.0.2.20");
    assert.equal(resolveBindAddress("::1", "192.0.2.20"), "::1");
  });

  it("rejects malformed and non-IP addresses with a useful error", () => {
    assert.throws(() => validateBindAddress("not-an-address"), /Invalid bind address.*IPv4 or IPv6/);
    assert.throws(() => validateBindAddress("localhost"), /Invalid bind address.*IPv4 or IPv6/);
    assert.throws(() => validateBindAddress(""), /Invalid bind address.*IPv4 or IPv6/);
  });
});
