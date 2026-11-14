"use client";
// The email settings (spec 13, section 3): choose a provider (or type every value), the sender, and send a test. The
// settings are saved only when the test email was accepted, so email never seems to work when it does not. The
// password is never shown again; leaving it empty keeps the saved one. Below: the email record of the last 30 days.
import type { EmailLogRow, EmailSettingsView } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";
import { formatWhen } from "./time-format";

interface Preset {
  key: string;
  label: string;
  host: string;
  port: number;
  security: "starttls" | "tls";
}

const ROW: React.CSSProperties = { margin: "0.75rem 0" };
const FIELD: React.CSSProperties = {
  minBlockSize: "32px",
  inlineSize: "100%",
  maxInlineSize: "28rem",
};
const STATUS_WORDS: Record<EmailLogRow["status"], string> = {
  queued: "Waiting to be sent",
  sent: "Sent",
  retrying: "Trying again",
  failed: "Not sent",
  dropped: "Dropped (its link had expired)",
};
const KIND_WORDS: Record<string, string> = {
  test: "Test email",
  invitation: "Invitation",
  "password-reset": "Password reset",
};

export function EmailSettingsScreen({
  initial,
  presets,
  initialLog,
  adminEmail,
}: {
  initial: EmailSettingsView | null;
  presets: Preset[];
  initialLog: EmailLogRow[];
  adminEmail: string;
}) {
  const [settings, setSettings] = useState(initial);
  const [log, setLog] = useState(initialLog);
  const [provider, setProvider] = useState(initial?.provider ?? presets[0]!.key);
  const [host, setHost] = useState(initial?.host ?? presets[0]!.host);
  const [port, setPort] = useState(String(initial?.port ?? presets[0]!.port));
  const [security, setSecurity] = useState<"starttls" | "tls">(
    initial?.security ?? presets[0]!.security,
  );
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState(initial?.fromName ?? "");
  const [fromAddress, setFromAddress] = useState(initial?.fromAddress ?? "");
  const [testTo, setTestTo] = useState(adminEmail);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = (key: string) => {
    setProvider(key);
    const preset = presets.find((p) => p.key === key);
    if (preset) {
      setHost(preset.host);
      setPort(String(preset.port));
      setSecurity(preset.security);
    }
  };

  const reload = async () => {
    const response = await fetch("/api/admin/settings/email");
    const body = (await response.json().catch(() => null)) as {
      settings?: EmailSettingsView | null;
      log?: EmailLogRow[];
    } | null;
    if (response.ok && body) {
      setSettings(body.settings ?? null);
      setLog(body.log ?? []);
    }
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setNote("Sending the test email…");
    try {
      const response = await fetch("/api/admin/settings/email", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          host,
          port: Number(port),
          security,
          username,
          password,
          fromName,
          fromAddress,
          testTo,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? "The settings could not be saved.");
      setPassword("");
      setNote(`The test email was accepted. Email works now. Look for it at ${testTo}.`);
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
      await reload();
    }
  }

  async function turnOff() {
    setProblem(null);
    const response = await fetch("/api/admin/settings/email", { method: "DELETE" });
    if (!response.ok) {
      setProblem("Email could not be turned off.");
      return;
    }
    setNote("Email is off. Password reset and invitations by email are off too.");
    await reload();
  }

  return (
    <div>
      {settings?.working ? (
        <p role="note">
          <strong>Email works.</strong>{" "}
          {`It was last tested ${formatWhen(new Date(settings.testedAt ?? 0).toISOString(), null)}, sending as ${settings.fromName ? `${settings.fromName} <${settings.fromAddress}>` : settings.fromAddress}.`}
        </p>
      ) : (
        <Alert
          color="warning"
          title="Email is not set up"
          description="Password reset and invitations by email are off. Fill in the settings below and send a test email to turn it on."
        />
      )}
      <form aria-labelledby="email-heading" onSubmit={(event) => void save(event)}>
        <h2 id="email-heading">How the site sends email</h2>
        <div style={ROW}>
          <label htmlFor="email-provider">Email provider</label>
          <br />
          <select
            id="email-provider"
            value={provider}
            onChange={(e) => choose(e.target.value)}
            style={FIELD}
          >
            {presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value="other">Other (type every value)</option>
          </select>
        </div>
        <div style={ROW}>
          <label htmlFor="email-host">Mail server (SMTP)</label>
          <br />
          <input
            id="email-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            style={FIELD}
          />
        </div>
        <div style={ROW}>
          <label htmlFor="email-port">Port</label>
          <br />
          <input
            id="email-port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            style={{ ...FIELD, maxInlineSize: "8rem" }}
          />
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: "0.75rem 0" }}>
          <legend>Encryption</legend>
          <label style={{ marginInlineEnd: "1rem" }}>
            <input
              type="radio"
              name="email-security"
              checked={security === "starttls"}
              onChange={() => setSecurity("starttls")}
            />{" "}
            STARTTLS (usually port 587)
          </label>
          <label>
            <input
              type="radio"
              name="email-security"
              checked={security === "tls"}
              onChange={() => setSecurity("tls")}
            />{" "}
            TLS from the start (usually port 465)
          </label>
          <p>A connection without encryption is never used.</p>
        </fieldset>
        <div style={ROW}>
          <label htmlFor="email-username">User name</label>
          <br />
          <input
            id="email-username"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={FIELD}
          />
        </div>
        <div style={ROW}>
          <label htmlFor="email-password">Password or API key</label>
          <br />
          <input
            id="email-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby="email-password-hint"
            style={FIELD}
          />
          <p id="email-password-hint">
            {settings?.passwordSet
              ? "A password is saved. Leave this empty to keep it. It is kept encrypted and never shown again."
              : "It is kept encrypted and never shown again."}
          </p>
        </div>
        <div style={ROW}>
          <label htmlFor="email-from-name">Sender name</label>
          <br />
          <input
            id="email-from-name"
            value={fromName}
            maxLength={80}
            onChange={(e) => setFromName(e.target.value)}
            style={FIELD}
          />
        </div>
        <div style={ROW}>
          <label htmlFor="email-from-address">Sender address</label>
          <br />
          <input
            id="email-from-address"
            type="email"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            style={FIELD}
          />
        </div>
        <div style={ROW}>
          <label htmlFor="email-test-to">Send the test email to</label>
          <br />
          <input
            id="email-test-to"
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            style={FIELD}
          />
        </div>
        {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
        <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <Button type="submit" color="primary" isDisabled={busy}>
            Send a test email and save
          </Button>
          {settings ? (
            <Button type="button" onPress={() => void turnOff()}>
              Turn email off
            </Button>
          ) : null}
        </p>
        <p role="status">{note}</p>
      </form>

      <section aria-labelledby="email-log-heading">
        <h2 id="email-log-heading">Emails of the last 30 days</h2>
        <p>The text of an email is never kept, only who it went to, what it was and how it went.</p>
        {log.length === 0 ? (
          <p>No emails yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Email</th>
                  <th scope="col">To</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {log.map((row) => (
                  <tr key={row.id}>
                    <td>{formatWhen(new Date(row.createdAt).toISOString(), null)}</td>
                    <td>{KIND_WORDS[row.emailKey] ?? row.emailKey}</td>
                    <td>{row.to}</td>
                    <td>{row.subject}</td>
                    <td>
                      {STATUS_WORDS[row.status]}
                      {row.error ? `: ${row.error}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
