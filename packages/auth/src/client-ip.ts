// The real client address, for rate limits (spec 02, section 5, rule 4; AU-39).
//
// Forwarding headers can be written by anyone. They are believed only when the connection comes from a
// proxy the owner listed. Then the address is the first one, counting from the right of `X-Forwarded-For`,
// that is not a trusted proxy itself. Entries further left are what the client claimed, and are ignored.
import { BlockList, isIP } from "node:net";

export type TrustedProxies = readonly string[];

function blockList(trusted: TrustedProxies): BlockList {
  const list = new BlockList();
  for (const entry of trusted) {
    const [address, prefix] = entry.split("/") as [string, string | undefined];
    const family = isIP(address);
    if (!family) throw new Error(`Not an IP address or range: "${entry}"`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

/** Turn "::ffff:10.0.0.1" into "10.0.0.1" so one address has one spelling. */
export function normaliseAddress(address: string): string {
  const a = address.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return mapped ? mapped[1]! : a.toLowerCase();
}

export const UNKNOWN_CLIENT = "unknown";

export function clientAddress(
  forwardedFor: string | null,
  remoteAddress: string | undefined,
  trusted: TrustedProxies = [],
): string {
  const remote = remoteAddress ? normaliseAddress(remoteAddress) : undefined;
  if (!remote) return UNKNOWN_CLIENT;
  if (trusted.length === 0) return remote;
  const list = blockList(trusted);
  const isTrusted = (a: string) => {
    const family = isIP(a);
    return family !== 0 && list.check(a, family === 4 ? "ipv4" : "ipv6");
  };
  // The connection must come from a trusted proxy, or the header is just what the sender wrote.
  if (!isTrusted(remote)) return remote;
  const chain = (forwardedFor ?? "")
    .split(",")
    .map((s) => normaliseAddress(s))
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i]!;
    if (isIP(a) === 0) return remote; // a malformed entry: do not guess
    if (!isTrusted(a)) return a;
  }
  return remote;
}
