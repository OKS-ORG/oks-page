"use client";
// Your account > Email address (spec 13, section 5): whether the address is confirmed, a link to confirm it, and a change
// of address. A change asks the old address first, then the new one, and the account uses the new address only once
// both links were opened. All of it needs email to work on the site (EM-02).
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

const FIELD: React.CSSProperties = {
  minBlockSize: "32px",
  maxInlineSize: "28rem",
  inlineSize: "100%",
};

/** What the link of an email did, from the address it came back to (`?email=` and, when it failed, `&error=`). */
const RESULT: Record<string, { color: "success" | "warning"; title: string; text: string }> = {
  confirmed: {
    color: "success",
    title: "Address confirmed",
    text: "Thank you: your email address is confirmed.",
  },
  "check-new": {
    color: "success",
    title: "One more step",
    text: "Your old address said yes. Now open the link we sent to your new address; your account uses it after that.",
  },
  changed: {
    color: "success",
    title: "Address changed",
    text: "Your account uses the new email address now. A notice went to the old one and to the new one.",
  },
};

export function AccountEmail({
  email,
  verified,
  emailWorks,
  result,
  error,
}: {
  email: string;
  verified: boolean;
  emailWorks: boolean;
  /** `email=` from the address (what the link did), or null. */
  result: string | null;
  /** `error=` from the address: the link was too old or not right. */
  error: string | null;
}) {
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(path: string, body: Record<string, unknown>, done: string) {
    setProblem(null);
    setNote("");
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok)
        setProblem(answer?.message ?? "The link could not be sent. Try again later.");
      else setNote(done);
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  const change = (event: FormEvent) => {
    event.preventDefault();
    const next = newEmail.trim();
    if (next.toLowerCase() === email.toLowerCase()) {
      setProblem("That is already your email address.");
      return;
    }
    void send(
      "change-email",
      { newEmail: next, password },
      `We sent a link to your current address, ${email}. Open it to say yes; a second link then goes to ${next}.`,
    );
  };

  const shown = result ? RESULT[result] : undefined;
  return (
    <section aria-labelledby="account-email">
      <h2 id="account-email">Email address</h2>
      {error ? (
        <Alert
          color="warning"
          title="That link did not work"
          description={
            error === "TOKEN_EXPIRED"
              ? "The link was more than an hour old. Ask for a new one below."
              : "The link was not right, or it was already used. Ask for a new one below."
          }
        />
      ) : shown ? (
        <Alert color={shown.color} title={shown.title} description={shown.text} />
      ) : null}
      {problem ? <Alert color="danger" title="Not sent" description={problem} /> : null}
      <p>
        <strong>{email}</strong> · {verified ? "Confirmed" : "Not confirmed yet"}
      </p>
      {!emailWorks ? (
        <p>
          Email is not set up on this site yet, so no link can be sent. To change your address, ask
          an administrator to set up email first.
        </p>
      ) : !verified ? (
        <>
          <p>
            Confirm your address, so the site knows its emails reach you. You can change it after
            that.
          </p>
          <p>
            <Button
              isDisabled={busy}
              onPress={() =>
                void send(
                  "send-verification-email",
                  { email },
                  `We sent a link to ${email}. Open it within an hour.`,
                )
              }
            >
              Send me a confirmation link
            </Button>
          </p>
        </>
      ) : (
        <form onSubmit={change} aria-label="Change your email address">
          <p>
            <label htmlFor="account-new-email">New email address</label>
            <br />
            <input
              id="account-new-email"
              type="email"
              required
              autoComplete="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              style={FIELD}
            />
          </p>
          <p>
            <label htmlFor="account-email-password">Your current password</label>
            <br />
            <input
              id="account-email-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={FIELD}
            />
          </p>
          <p>
            We first ask your current address to say yes, then the new one. Until both links are
            opened, nothing changes.
          </p>
          <p>
            <Button type="submit" isDisabled={busy || !newEmail.trim() || !password}>
              Change my email address
            </Button>
          </p>
        </form>
      )}
      <p role="status">{note}</p>
    </section>
  );
}
