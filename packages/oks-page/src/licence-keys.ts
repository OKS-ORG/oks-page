// The public keys a site checks licence keys against: the ones built into the core (ADR 0039), and, for tests and for a
// fork with its own signing key, the ones in the environment variable OKS_LICENCE_PUBLIC_KEYS (comma-separated, each the
// base64 of the SPKI form). The admin never adds a public key.
import { LICENCE_PUBLIC_KEYS } from "@oks-page/core";

export function licencePublicKeys(): string[] {
  const extra = (process.env["OKS_LICENCE_PUBLIC_KEYS"] ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  return [...LICENCE_PUBLIC_KEYS, ...extra];
}
