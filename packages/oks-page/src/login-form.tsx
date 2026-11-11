"use client";
// The sign-in form of the admin. It talks to Better Auth's own route; a wrong password gets a plain sentence.
import { Alert, Button, PasswordField, TextField } from "oks-ui";
import { useState, type FormEvent } from "react";

const MESSAGES: Record<number, string> = {
  401: "The email or the password is wrong.",
  403: "The email or the password is wrong.",
  429: "Too many tries. Wait a minute and try again.",
};

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (response.ok) {
        window.location.assign("/admin");
        return;
      }
      setProblem(MESSAGES[response.status] ?? "Sign-in did not work. Try again.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} aria-label="Sign in">
      {problem ? <Alert color="danger" title="Not signed in" description={problem} /> : null}
      <TextField
        name="email"
        label="Email"
        type="email"
        required
        value={email}
        onChange={setEmail}
      />
      <PasswordField
        name="password"
        label="Password"
        required
        value={password}
        onChange={setPassword}
      />
      <Button type="submit" color="primary" isDisabled={busy}>
        Sign in
      </Button>
    </form>
  );
}
