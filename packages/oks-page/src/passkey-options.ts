// Which sites can have passkeys (spec 02).
/**
 * Passkeys belong to a domain name (WebAuthn): they need a site address with a real host name such as example.com or
 * localhost, never an IP address. Returns the settings for the sign-in library, or null when passkeys cannot work here.
 */
export function passkeyOptions(
  baseUrl: string,
): { rpID: string; rpName: string; origin: string } | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname;
  // An IPv4 or IPv6 address is not a domain name.
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[") || host.includes(":")) return null;
  return { rpID: host, rpName: host, origin: url.origin };
}
