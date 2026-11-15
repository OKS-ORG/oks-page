"use client";
// "Email me a sign-in link" on the sign-in page (spec 13, section 5), shown only when email works. The answer is the
// same for any address, so nobody can learn which addresses have an account.
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

export function SignInLinkForm({ failed }: { failed: boolean }) {
  const [open, setOpen] = useState(failed);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("");
    setBusy(true);
    try {
      const response = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const answer = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) setProblem(answer?.message ?? "No link could be sent. Try again later.");
      else
        setNote(
          `If ${email.trim()} has an account here, an email is on its way. The link works for 15 minutes.`,
        );
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <section aria-labelledby="sign-in-link">
      {failed ? (
        <Alert
          color="warning"
          title="That sign-in link did not work"
          description="It was more than 15 minutes old or already used. Ask for a new one, or sign in with your password."
        />
      ) : null}
      {!open ? (
        <p>
          <Button onPress={() => setOpen(true)}>Email me a sign-in link</Button>
        </p>
      ) : (
        <form onSubmit={(event) => void send(event)} aria-labelledby="sign-in-link">
          <h2 id="sign-in-link">Sign in with a link by email</h2>
          {problem ? <Alert color="danger" title="Not sent" description={problem} /> : null}
          <p>
            <label htmlFor="sign-in-link-email">Email for the link</label>
            <br />
            <input
              id="sign-in-link-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ minBlockSize: "32px", maxInlineSize: "28rem", inlineSize: "100%" }}
            />
          </p>
          <p>
            Sign-in links work for a confirmed address of an account without two-factor sign-in.
            Otherwise the email says how to sign in.
          </p>
          <p>
            <Button type="submit" isDisabled={busy || !email.trim()}>
              Send the link
            </Button>
          </p>
          <p role="status">{note}</p>
        </form>
      )}
    </section>
  );
}
