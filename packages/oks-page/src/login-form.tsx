"use client";
// The sign-in screen of the admin. It talks to Better Auth's own route; a wrong password gets a plain sentence. When the
// account uses two-factor, a second step asks for the code from the authenticator app, in six boxes (or a backup code).
import { Alert, Button, PasswordField, TextField } from "oks-ui";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

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

/**
 * One real field, so that pasting and the phone's own code suggestion work, with six boxes drawn from what it holds.
 */
function CodeBoxes({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <div className="oks-code">
      <input
        ref={field}
        name="code"
        aria-label="Code from your authenticator app"
        autoComplete="one-time-code"
        inputMode="numeric"
        required
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
      />
      <div aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} data-next={i === Math.min(value.length, 5) ? "" : undefined}>
            {value[i] ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export function LoginScreen({
  before,
  after,
}: {
  /** What stands above and below the password form (a passkey, the email links); the code step shows neither. */
  before?: ReactNode;
  after?: ReactNode;
}) {
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
    const to = (next: () => void) => () => {
      next();
      setCode("");
      setProblem(null);
    };
    return (
      <>
        <h1>{backup ? "Use a backup code" : "Enter your code"}</h1>
        <p>
          {backup
            ? "Type one of your backup codes. Each one works once."
            : "Open your authenticator app and type the 6 digits it shows."}
        </p>
        <form method="post" onSubmit={submitCode} aria-label="Two-factor code">
          {problem ? <Alert color="danger" title="Not signed in" description={problem} /> : null}
          {backup ? (
            <TextField
              name="code"
              label="Backup code"
              required
              value={code}
              onChange={setCode}
              autoComplete="one-time-code"
            />
          ) : (
            <CodeBoxes value={code} onChange={setCode} />
          )}
          <Button type="submit" color="primary" isDisabled={busy}>
            Verify
          </Button>
          <div className="oks-entry-links">
            <button type="button" onClick={to(() => setBackup(!backup))}>
              {backup ? "Use the app instead" : "Lost your phone? Use a backup code"}
            </button>
            <button
              type="button"
              onClick={to(() => {
                setBackup(false);
                setPassword("");
                setStep("password");
              })}
            >
              Back to sign in
            </button>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <h1>Sign in</h1>
      <p>Welcome back. Sign in to look after your site.</p>
      {before}
      <form method="post" onSubmit={submit} aria-label="Sign in">
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
      {after}
    </>
  );
}
