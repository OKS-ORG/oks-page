"use client";
// "Sign in with a passkey" on the sign-in page (spec 02): a fingerprint, face or device PIN instead of a password. Shown
// only when the site has a real host name (passkeys do not work on an IP address) and the browser can do passkeys.
import { browserSupportsWebAuthn, startAuthentication } from "@oks-page/auth/passkey-client";
import { Alert, Button } from "oks-ui";
import { useEffect, useState } from "react";

export function PasskeySignIn() {
  const [supported, setSupported] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  if (!supported) return null;

  async function signIn() {
    setProblem(null);
    setBusy(true);
    try {
      const asked = await fetch("/api/auth/passkey/generate-authenticate-options");
      if (!asked.ok) throw new Error("options");
      const response = await startAuthentication({ optionsJSON: await asked.json() });
      const verified = await fetch("/api/auth/passkey/verify-authentication", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
      if (!verified.ok) {
        setProblem("That passkey was not accepted. Try again, or sign in with your password.");
        setBusy(false);
        return;
      }
      window.location.assign("/admin");
    } catch (error) {
      // The person closed the browser's own window: nothing went wrong.
      const cancelled = (error as { name?: string })?.name === "NotAllowedError";
      setProblem(
        cancelled
          ? "The passkey was not used. Try again, or sign in with your password."
          : "The passkey could not be used here. Sign in with your password.",
      );
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="passkey-sign-in">
      <h2 id="passkey-sign-in">Sign in with a passkey</h2>
      {problem ? <Alert color="danger" title="Not signed in" description={problem} /> : null}
      <p>Use the fingerprint, face or PIN of this device instead of a password.</p>
      <p>
        <Button isDisabled={busy} onPress={() => void signIn()}>
          Sign in with a passkey
        </Button>
      </p>
    </section>
  );
}
