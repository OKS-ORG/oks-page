"use client";
// Your account > Passkeys (spec 02, rule 4): add a passkey (a fingerprint, face or device PIN to sign in with), see the
// ones you have, and remove one. Adding and removing ask for your current password again (AU-41).
import { browserSupportsWebAuthn, startRegistration } from "@oks-page/auth/passkey-client";
import { Alert, Button } from "oks-ui";
import { useCallback, useEffect, useState, type FormEvent } from "react";

interface Passkey {
  id: string;
  name?: string | null;
  deviceType?: string | null;
  backedUp?: boolean | null;
  createdAt?: string | null;
}

const FIELD: React.CSSProperties = {
  minBlockSize: "32px",
  maxInlineSize: "28rem",
  inlineSize: "100%",
};
const day = (value?: string | null) => (value ? new Date(value).toISOString().slice(0, 10) : "");

export function AccountPasskeys() {
  const [supported, setSupported] = useState(true);
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/auth/passkey/list-user-passkeys");
    setKeys(response.ok ? ((await response.json()) as Passkey[]) : []);
  }, []);
  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
    void load();
  }, [load]);

  const post = (path: string, body: unknown) =>
    fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const messageOf = async (response: Response, fallback: string) =>
    ((await response.json().catch(() => null)) as { message?: string } | null)?.message ?? fallback;

  /** The password is checked first, so a wrong one is found before the device asks for a fingerprint. */
  async function passwordIsRight(): Promise<boolean> {
    const checked = await post("verify-password", { password });
    if (checked.ok) return true;
    setProblem("Your current password is not right.");
    return false;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("");
    setBusy(true);
    try {
      if (!(await passwordIsRight())) return;
      const asked = await fetch("/api/auth/passkey/generate-register-options");
      if (!asked.ok) {
        setProblem(
          asked.status === 403
            ? "For safety, sign out and sign in again first. Then you can add a passkey."
            : await messageOf(asked, "A passkey could not be started."),
        );
        return;
      }
      const response = await startRegistration({ optionsJSON: await asked.json() });
      const verified = await post("passkey/verify-registration", {
        response,
        name: name.trim() || "Passkey",
        password,
      });
      if (!verified.ok) {
        setProblem(await messageOf(verified, "The passkey could not be saved."));
        return;
      }
      setNote(`Passkey added: ${name.trim() || "Passkey"}. You can use it to sign in.`);
      setName("");
      setPassword("");
      await load();
    } catch (error) {
      const name = (error as { name?: string })?.name;
      setProblem(
        name === "NotAllowedError"
          ? "The passkey was not added. The window was closed or timed out."
          : name === "InvalidStateError"
            ? "This device already has a passkey for your account."
            : "A passkey could not be added on this device.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: Passkey) {
    setProblem(null);
    setNote("");
    if (!password) {
      setProblem("Type your current password above, then remove the passkey.");
      return;
    }
    setBusy(true);
    try {
      const done = await post("passkey/delete-passkey", { id: key.id, password });
      if (!done.ok) setProblem(await messageOf(done, "The passkey could not be removed."));
      else {
        setNote(`Passkey removed: ${key.name || "Passkey"}.`);
        setPassword("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="account-passkeys">
      <h2 id="account-passkeys">Passkeys</h2>
      <p>
        A passkey lets you sign in with the fingerprint, face or PIN of a device, without typing a
        password. You keep your password too.
      </p>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      {keys === null ? (
        <p role="status">Loading your passkeys…</p>
      ) : keys.length === 0 ? (
        <p>You have no passkeys yet.</p>
      ) : (
        <ul>
          {keys.map((key) => (
            <li key={key.id}>
              <strong>{key.name || "Passkey"}</strong> · added {day(key.createdAt)} ·{" "}
              {key.backedUp ? "kept in your account on your devices" : "stays on this device"}{" "}
              <Button isDisabled={busy} onPress={() => void remove(key)}>
                Remove {key.name || "passkey"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!supported ? (
        <p>This browser cannot use passkeys.</p>
      ) : (
        <form method="post" onSubmit={(event) => void add(event)} aria-label="Add a passkey">
          <p>
            <label htmlFor="passkey-name">Name for the new passkey (for example “Laptop”)</label>
            <br />
            <input
              id="passkey-name"
              type="text"
              maxLength={60}
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={FIELD}
            />
          </p>
          <p>
            <label htmlFor="passkey-password">Your current password</label>
            <br />
            <input
              id="passkey-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={FIELD}
            />
          </p>
          <p>The password is asked again to add or remove a passkey.</p>
          <p>
            <Button type="submit" isDisabled={busy || !password}>
              Add a passkey
            </Button>
          </p>
        </form>
      )}
      <p role="status">{note}</p>
    </section>
  );
}
