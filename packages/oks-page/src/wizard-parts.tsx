"use client";
// The parts of the setup wizard that come once the site and the owner's account exist: the frame every step is drawn in,
// two-factor sign-in (which can be skipped) and its backup codes. The owner is signed in by then, so these use the same
// routes as "Your account".
import { Alert } from "oks-ui";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CodeBoxes } from "./code-boxes";
import { qrOf } from "./qr";

export function WizardFrame({
  step,
  total,
  title,
  line,
  children,
}: {
  /** Counted from 1. */
  step: number;
  total: number;
  title: string;
  line: string;
  children: ReactNode;
}) {
  const place = `Step ${step} of ${total}`;
  return (
    <div className="oks-wizard">
      <div className="oks-wizard-bar" role="img" aria-label={place}>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} data-on={i < step} />
        ))}
      </div>
      <p className="oks-wizard-kicker">{place}</p>
      <h1>{title}</h1>
      <p className="oks-wizard-line">{line}</p>
      {children}
    </div>
  );
}

async function twoFactor(path: string, data: Record<string, unknown>) {
  const response = await fetch(`/api/auth/two-factor/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  return { ok: response.ok, body: (await response.json().catch(() => null)) as unknown };
}

const UNREACHABLE = "The site could not be reached. Check your connection and try again.";

export function TwoFactorStep({
  password,
  onDone,
  onSkip,
}: {
  /** The password just chosen: turning two-factor on asks for it. */
  password: string;
  onDone: (backupCodes: string[]) => void;
  onSkip: () => void;
}) {
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);

  const prepare = useCallback(async () => {
    try {
      const r = await twoFactor("enable", { password });
      if (!r.ok) {
        setProblem("Two-factor sign-in could not be started. Try again, or skip it for now.");
        return;
      }
      const data = r.body as { totpURI: string; backupCodes: string[] };
      setProblem(null);
      setSetup({ uri: data.totpURI, backupCodes: data.backupCodes });
    } catch {
      setProblem(UNREACHABLE);
    }
  }, [password]);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void prepare();
  }, [prepare]);

  async function finish(event: FormEvent) {
    event.preventDefault();
    if (!setup) return;
    setProblem(null);
    setBusy(true);
    try {
      const r = await twoFactor("verify-totp", { code });
      if (r.ok) {
        onDone(setup.backupCodes);
        return;
      }
      setProblem("That code is not right. Type the newest code from the app.");
    } catch {
      setProblem(UNREACHABLE);
    }
    setBusy(false);
  }

  return (
    <>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <form method="post" aria-label="Set up two-factor sign-in" onSubmit={finish}>
        {setup ? (
          <div className="oks-tfa">
            <div className="oks-tfa-scan">
              <img
                src={qrOf(setup.uri)}
                width={160}
                height={160}
                alt="QR code for your authenticator app"
              />
              <span>Cannot scan? Type this key:</span>
              <code>{new URL(setup.uri).searchParams.get("secret") ?? ""}</code>
            </div>
            <div className="oks-tfa-do">
              <ol>
                <li>
                  <strong>Install an authenticator app</strong>
                  <span>Any app that makes one-time codes works.</span>
                </li>
                <li>
                  <strong>Scan the picture</strong>
                  <span>Or type the key under it into the app.</span>
                </li>
                <li>
                  <strong>Type the code the app shows</strong>
                  <span>It changes every half minute.</span>
                </li>
              </ol>
              <CodeBoxes label="Code from your app" value={code} onChange={setCode} />
            </div>
          </div>
        ) : (
          <p role="status">{problem ? "" : "Getting your picture ready…"}</p>
        )}
        <div className="oks-wizard-foot">
          <button type="button" className="oks-text-button" onClick={onSkip}>
            Skip for now
          </button>
          {setup ? (
            <button type="submit" className="oks-main-button" disabled={busy}>
              Verify and continue
            </button>
          ) : (
            <button
              type="button"
              className="oks-main-button"
              disabled={!problem}
              onClick={() => {
                setProblem(null);
                void prepare();
              }}
            >
              Try again
            </button>
          )}
        </div>
      </form>
    </>
  );
}

export function BackupStep({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState("");
  const text = `${codes.join("\n")}\n`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setNote("Copied.");
    } catch {
      setNote("They could not be copied. Download them, or write them down.");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "backup-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <ul aria-label="Backup codes" className="oks-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="oks-codes-actions">
        <button type="button" className="oks-link-button" onClick={() => void copy()}>
          Copy all
        </button>
        <button type="button" className="oks-link-button" onClick={download}>
          Download
        </button>
        <p role="status">{note}</p>
      </div>
      <label className="oks-codes-saved">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I have saved these codes in a safe place</span>
      </label>
      <div className="oks-wizard-foot">
        <span />
        <button type="button" className="oks-main-button" disabled={!saved} onClick={onDone}>
          I saved them
        </button>
      </div>
    </>
  );
}
