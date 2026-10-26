// A network call made on behalf of a plugin (spec 04, PL-13, PL-29, PL-30).
// The name is looked up ONCE, the address is checked, and the connection goes to that checked address, so a name
// that answers differently the second time cannot lead inside. Redirects are not followed.
import { BlockList, isIP } from "node:net";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/** Private, loopback, link-local (the cloud metadata address included), reserved and multicast addresses. */
export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const a = mapped ? mapped[1]! : address;
  const family = isIP(a);
  if (family === 0) return true;
  return blocked.check(a, family === 4 ? "ipv4" : "ipv6");
}

export class FetchRefused extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface SafeFetchOptions {
  /** Tests only: allow `http` and private addresses (the test server is on this machine). */
  allowPrivateForTests?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  /** Tests only: replaces the DNS lookup, so a test can prove the connection uses the address
   * that was checked even when a second lookup of the same name would answer differently
   * (PL-30, a DNS-rebinding trick). */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

export async function safeFetch(
  url: URL,
  options: SafeFetchOptions = {},
): Promise<{ status: number; text: string }> {
  const allowPrivate = options.allowPrivateForTests === true;
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:"))
    throw new FetchRefused("Only https addresses are allowed", "scheme");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolve = options.resolve ?? ((h: string) => dns.lookup(h, { all: true }));
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolve(hostname);
  if (addresses.length === 0) throw new FetchRefused("The name has no address", "dns");
  if (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address)))
    throw new FetchRefused("The address is private or reserved", "ssrf");
  const chosen = addresses[0]!;
  const requester = url.protocol === "https:" ? https : http;
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxBytes = options.maxBytes ?? 100_000;
  return new Promise((resolve, reject) => {
    const req = requester.request(
      url,
      {
        method: "GET",
        timeout: timeoutMs,
        // The connection goes to the address checked above, whatever the name would say now.
        // Happy Eyeballs (on by default since Node 20) calls a custom `lookup` expecting an
        // array of addresses to race between; since exactly one address was already chosen and
        // checked, that behaviour is turned off so the old, simpler callback form is used.
        autoSelectFamily: false,
        lookup: (_name, _opts, callback) => callback(null, chosen.address, chosen.family),
      } as http.RequestOptions,
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return reject(new FetchRefused("Redirects are not followed", "redirect"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= maxBytes) chunks.push(c);
        });
        res.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new FetchRefused("The call took too long", "timeout")));
    req.on("error", reject);
    req.end();
  });
}
