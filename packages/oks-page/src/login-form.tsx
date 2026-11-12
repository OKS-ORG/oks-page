"use client";
// The sign-in form of the admin. It talks to Better Auth's own route; a wrong password gets a plain sentence. When the
// account uses two-factor, a second step asks for the code from the authenticator app (or a backup code).
import { Alert, Button, PasswordField, TextField } from "oks-ui";
import { useState, type FormEvent } from "react";

const MESSAGES: Record<number, string> = {
  401: "The email or the password is wrong.",
  403: "The email or the password is wrong.",
  429: "Too many tries. Wait a minute and try again.",
};

const CODE_MESSAGES: Record<number, string> = {
  401: "That code is not right. Try the newest code, or use a backup code.",
  403: "Your sign-in took too long. Start again with your password.",
  429: "Too many tries. Wait a minute and try again.",
};

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"password" | "code">("password");
  const [backup, setBackup] = useState(false);
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
        const body = (await response.json().catch(() => null)) as {
          twoFactorRedirect?: boolean;
        } | null;
        if (body?.twoFactorRedirect) {
          setStep("code");
          setBusy(false);
          return;
        }
        window.location.assign("/admin");
        return;
      }
      setProblem(MESSAGES[response.status] ?? "Sign-in did not work. Try again.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch(
        backup ? "/api/auth/two-factor/verify-backup-code" : "/api/auth/two-factor/verify-totp",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: code.replace(/\s+/g, "") }),
        },
      );
      if (response.ok) {
        window.location.assign("/admin");
        return;
      }
      setProblem(CODE_MESSAGES[response.status] ?? "Sign-in did not work. Try again.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  if (step === "code") {
    return (
      <form onSubmit={submitCode} aria-label="Two-factor code">
        {problem ? <Alert color="danger" title="Not signed in" description={problem} /> : null}
        <TextField
          name="code"
          label={backup ? "Backup code" : "Code from your authenticator app"}
          description={
            backup
              ? "Each backup code works once."
              : "Open the app on your phone and type the 6 numbers."
          }
          required
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
          inputMode={backup ? "text" : "numeric"}
        />
        <Button type="submit" color="primary" isDisabled={busy}>
          Sign in
        </Button>{" "}
        <Button
          onPress={() => {
            setBackup(!backup);
            setCode("");
            setProblem(null);
          }}
        >
          {backup ? "Use the app instead" : "Use a backup code instead"}
        </Button>
      </form>
    );
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
