"use client";
// The two forms of a password reset: ask for the link, then choose the new password. They talk to Better Auth's own
// routes. The first answer is the same whether or not the address has an account, so nobody can find out who does.
import { Alert, Button, PasswordField, TextField } from "oks-ui";
import { useState, type FormEvent, type ReactNode } from "react";

/** A finished step drawn as the design shows: a round icon tile, then the words. */
function Done({ d, children }: { d: string; children: ReactNode }) {
  return (
    <div className="oks-done">
      <span className="oks-done-icon" aria-hidden="true">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={d} />
        </svg>
      </span>
      {children}
    </div>
  );
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, redirectTo: "/admin/reset-password" }),
      });
      if (response.status === 429) setProblem("Too many tries. Wait a minute and try again.");
      else if (!response.ok) setProblem("It did not work. Try again in a moment.");
      else setDone(true);
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  if (done)
    return (
      <Done d="M3 6h18v12H3z M3 7l9 7 9-7">
        <p role="status">
          If an account uses {email}, an email with a link is on its way. The link works for 1 hour.
          Look in your spam folder too.
        </p>
      </Done>
    );
  return (
    <form onSubmit={submit} aria-label="Ask for a new password">
      <p>Give the email address of your account. We send you a link to choose a new password.</p>
      {problem ? <Alert color="danger" title="Not sent" description={problem} /> : null}
      <TextField
        name="email"
        label="Email"
        type="email"
        required
        value={email}
        onChange={setEmail}
      />
      <Button type="submit" color="primary" isDisabled={busy}>
        Send me a link
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (password !== again) {
      setProblem("The two passwords are not the same.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: password, token }),
      });
      const body = (await response.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      if (response.ok) setDone(true);
      else if (body?.code === "PASSWORD_TOO_SHORT")
        setProblem("The password is too short: use at least 10 characters.");
      else if (body?.code === "INVALID_TOKEN" || response.status === 400)
        setProblem(
          "This link no longer works (it was used, or 1 hour has passed). Ask for a new one.",
        );
      else setProblem("It did not work. Try again in a moment.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  if (done)
    return (
      <Done d="M5 12l5 5 9-10">
        <p role="status">
          Your password is changed, and you are signed out everywhere.{" "}
          <a href="/admin/login">Sign in</a> with the new password.
        </p>
      </Done>
    );
  return (
    <form onSubmit={submit} aria-label="Choose a new password">
      {problem ? <Alert color="danger" title="Not changed" description={problem} /> : null}
      {problem?.includes("Ask for a new one") ? (
        <p>
          <a href="/admin/forgot-password">Ask for a new link</a>
        </p>
      ) : null}
      <PasswordField
        name="password"
        label="New password"
        required
        value={password}
        onChange={setPassword}
      />
      <PasswordField
        name="again"
        label="The new password again"
        required
        value={again}
        onChange={setAgain}
      />
      <Button type="submit" color="primary" isDisabled={busy}>
        Change my password
      </Button>
    </form>
  );
}
