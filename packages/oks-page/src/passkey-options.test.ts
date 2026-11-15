import { describe, expect, test } from "vitest";
import { passkeyOptions } from "./passkey-options";

describe("which sites can have passkeys", () => {
  test("a site with a host name can; the host name and the full origin are what the passkey is bound to", () => {
    expect(passkeyOptions("https://example.com")).toEqual({
      rpID: "example.com",
      rpName: "example.com",
      origin: "https://example.com",
    });
    expect(passkeyOptions("https://www.example.com/blog")).toMatchObject({
      rpID: "www.example.com",
      origin: "https://www.example.com",
    });
    expect(passkeyOptions("http://localhost:3000")).toMatchObject({
      rpID: "localhost",
      origin: "http://localhost:3000",
    });
  });
  test("an address with numbers, or something that is not an address, cannot", () => {
    expect(passkeyOptions("http://127.0.0.1:3000")).toBeNull();
    expect(passkeyOptions("http://192.168.1.20")).toBeNull();
    expect(passkeyOptions("http://[::1]:3000")).toBeNull();
    expect(passkeyOptions("not an address")).toBeNull();
    expect(passkeyOptions("")).toBeNull();
  });
});
