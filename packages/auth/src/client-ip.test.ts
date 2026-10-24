// AU-39 (the address): forwarding headers are believed only from trusted proxies.
import { describe, expect, test } from "vitest";
import { clientAddress, normaliseAddress, UNKNOWN_CLIENT } from "./client-ip.js";

describe("AU-39 clientAddress", () => {
  test("with no trusted proxies, the connection's address is used and the header is ignored", () => {
    expect(clientAddress("1.2.3.4", "203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddress("1.2.3.4, 5.6.7.8", "203.0.113.7", [])).toBe("203.0.113.7");
  });

  test("a header from a connection that is not a trusted proxy is ignored", () => {
    expect(clientAddress("1.2.3.4", "203.0.113.7", ["10.0.0.0/8"])).toBe("203.0.113.7");
  });

  test("behind a trusted proxy, the first address from the right that is not a proxy is the client", () => {
    expect(clientAddress("198.51.100.4", "10.0.0.2", ["10.0.0.0/8"])).toBe("198.51.100.4");
    expect(clientAddress("198.51.100.4, 10.0.0.9", "10.0.0.2", ["10.0.0.0/8"])).toBe(
      "198.51.100.4",
    );
  });

  test("addresses the client wrote to the left of the real one are ignored", () => {
    expect(clientAddress("1.1.1.1, 2.2.2.2, 198.51.100.4", "10.0.0.2", ["10.0.0.0/8"])).toBe(
      "198.51.100.4",
    );
  });

  test("two proxies in a row, both listed", () => {
    expect(clientAddress("198.51.100.4, 10.0.1.1", "10.0.0.2", ["10.0.0.0/8"])).toBe(
      "198.51.100.4",
    );
  });

  test("a malformed entry falls back to the connection and does not guess", () => {
    expect(clientAddress("not-an-address", "10.0.0.2", ["10.0.0.0/8"])).toBe("10.0.0.2");
  });

  test("no header behind a trusted proxy gives the proxy's address", () => {
    expect(clientAddress(null, "10.0.0.2", ["10.0.0.0/8"])).toBe("10.0.0.2");
  });

  test("IPv6 and IPv4-mapped addresses are written one way", () => {
    expect(normaliseAddress("::ffff:10.0.0.2")).toBe("10.0.0.2");
    expect(clientAddress("2001:db8::5", "fd00::1", ["fd00::/8"])).toBe("2001:db8::5");
    expect(clientAddress("198.51.100.4", "::ffff:10.0.0.2", ["10.0.0.0/8"])).toBe("198.51.100.4");
  });

  test("an unknown connection is one shared bucket", () => {
    expect(clientAddress("1.2.3.4", undefined, ["10.0.0.0/8"])).toBe(UNKNOWN_CLIENT);
  });

  test("a wrong trusted-proxy entry is an error, not a silent hole", () => {
    expect(() => clientAddress("1.2.3.4", "10.0.0.2", ["not-an-ip"])).toThrow(/Not an IP address/);
  });
});
