"use client";
// The form on the invitation page: the invited person's name (they may change it) and the password they choose.
import { Alert, Button, PasswordField, TextField } from "oks-ui";
import { useState, type FormEvent } from "react";
import { PasswordStrength } from "./password-strength";

const MIN = 10;

export function InviteForm({
  token,
  name: invited,
  email,
}: {
  token: string;
  name: string;
  email: string;
}) {
  const [name, setName] = useState(invited);
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (password.length < MIN) return setProblem(`The password needs at least ${MIN} characters.`);
    setBusy(true);
    try {
      const response = await fetch("/api/invite/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });
      if (response.ok) {
        window.location.assign("/admin");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setProblem(body?.error?.message ?? "It did not work. Try again.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <form method="post" onSubmit={(event) => void submit(event)} aria-label="Join the site">
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <TextField name="name" label="Your name" required value={name} onChange={setName} />
      <TextField name="email" label="Email" type="email" readOnly value={email} />
      <div>
        <PasswordField
          name="password"
          label="Choose a password"
          description={`At least ${MIN} characters.`}
          required
          value={password}
          onChange={setPassword}
        />
        <PasswordStrength password={password} />
      </div>
      <Button type="submit" color="primary" isDisabled={busy}>
        Create my account
      </Button>
      <p className="oks-entry-note">
        This link works once. Ask for a new one if it stopped working.
      </p>
    </form>
  );
}
