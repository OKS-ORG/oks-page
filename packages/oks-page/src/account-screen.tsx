"use client";
// Your account: two-factor sign-in with an authenticator app. Turning it on shows a QR code, the key as text and 10
// backup codes, and is only finished when the person types a right code. Turning it off or making new backup codes asks
// for the password again.
import { Alert, Button, PasswordField, TextField } from "oks-ui";
import qrcode from "qrcode-generator";
import { useState, type FormEvent } from "react";

const failure = (body: unknown, fallback: string): string =>
  (body as { message?: string } | null)?.message ?? fallback;

async function call(path: string, data: Record<string, unknown>) {
  const response = await fetch(`/api/auth/two-factor/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const body: unknown = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

const WRONG_PASSWORD = "The password is not right.";

function qrOf(uri: string): string {
  const code = qrcode(0, "M");
  code.addData(uri);
  code.make();
  return code.createDataURL(5, 8);
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <>
      <p>
        <strong>Save these 10 backup codes now.</strong> Each one works once, if you lose your
        phone. They are not shown again.
      </p>
      <ul aria-label="Backup codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

export function AccountScreen({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const secretOf = (uri: string) => new URL(uri).searchParams.get("secret") ?? "";

  async function run(work: () => Promise<void>) {
    setProblem(null);
    setNote("");
    setBusy(true);
    try {
      await work();
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  const start = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const r = await call("enable", { password });
      if (!r.ok) {
        setProblem(
          r.status === 400 || r.status === 401
            ? WRONG_PASSWORD
            : failure(r.body, "It did not work."),
        );
        return;
      }
      const data = r.body as { totpURI: string; backupCodes: string[] };
      setSetup({ uri: data.totpURI, backupCodes: data.backupCodes });
      setPassword("");
    });
  };

  const finish = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const r = await call("verify-totp", { code: code.replace(/\s+/g, "") });
      if (!r.ok) {
        setProblem("That code is not right. Type the newest code from the app.");
        return;
      }
      setEnabled(true);
      setSetup(null);
      setCode("");
      setNote("Two-factor sign-in is on.");
    });
  };

  const turnOff = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const r = await call("disable", { password });
      if (!r.ok) {
        setProblem(
          r.status === 400 || r.status === 401
            ? WRONG_PASSWORD
            : failure(r.body, "It did not work."),
        );
        return;
      }
      setEnabled(false);
      setNewCodes(null);
      setPassword("");
      setNote("Two-factor sign-in is off.");
    });
  };

  const makeCodes = () =>
    void run(async () => {
      const r = await call("generate-backup-codes", { password });
      if (!r.ok) {
        setProblem(
          r.status === 400 || r.status === 401
            ? WRONG_PASSWORD
            : failure(r.body, "It did not work."),
        );
        return;
      }
      setNewCodes((r.body as { backupCodes: string[] }).backupCodes);
      setPassword("");
    });

  return (
    <section aria-label="Two-factor sign-in">
      <h2>Two-factor sign-in</h2>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status">{note}</p>

      {setup ? (
        <form onSubmit={finish} aria-label="Finish two-factor set-up">
          <p>1. Open an authenticator app on your phone and scan this picture.</p>
          <img
            src={qrOf(setup.uri)}
            width={200}
            height={200}
            alt="QR code for your authenticator app"
          />
          <p>
            Cannot scan it? Type this key into the app: <code>{secretOf(setup.uri)}</code>
          </p>
          <p>2. Save your backup codes.</p>
          <BackupCodes codes={setup.backupCodes} />
          <p>3. Type the 6 numbers the app shows now, to finish.</p>
          <TextField
            name="code"
            label="Code from the app"
            required
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            inputMode="numeric"
          />
          <Button type="submit" color="primary" isDisabled={busy}>
            Finish
          </Button>
        </form>
      ) : enabled ? (
        <form onSubmit={turnOff} aria-label="Two-factor is on">
          <p>
            Two-factor sign-in is <strong>on</strong>. Signing in asks for a code from your app.
          </p>
          <PasswordField
            name="password"
            label="Your password"
            description="Needed to turn it off or to make new backup codes."
            required
            value={password}
            onChange={setPassword}
          />
          <Button type="submit" color="danger" isDisabled={busy}>
            Turn off
          </Button>{" "}
          <Button onPress={makeCodes} isDisabled={busy || password === ""}>
            Make new backup codes
          </Button>
          {newCodes ? <BackupCodes codes={newCodes} /> : null}
        </form>
      ) : (
        <form onSubmit={start} aria-label="Turn on two-factor">
          <p>
            Two-factor sign-in asks for a code from an app on your phone, as well as your password.
            It is strongly advised for administrators.
          </p>
          <PasswordField
            name="password"
            label="Your password"
            description="Needed to turn it on."
            required
            value={password}
            onChange={setPassword}
          />
          <Button type="submit" color="primary" isDisabled={busy}>
            Turn on
          </Button>
        </form>
      )}
    </section>
  );
}
