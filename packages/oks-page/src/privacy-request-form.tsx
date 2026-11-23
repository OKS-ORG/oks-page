"use client";
// The visitor's form: an address and what they would like. The answer is always the same: an email with a link is on its way.
import { useState } from "react";

export function PrivacyRequestForm() {
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<"export" | "delete">("export");
  const [trap, setTrap] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setProblem(null);
    setBusy(true);
    const response = await fetch("/api/privacy/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, kind, _hp: trap }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setProblem(body?.message ?? "The request could not be sent. Please try again later.");
      return;
    }
    setSentTo(email.trim());
  }

  if (sentTo)
    return (
      <div role="status">
        <h2>Check your email</h2>
        <p>
          We sent a message to {sentTo} with a link. Open the link to confirm that this request is
          yours. It works for 7 days, and nothing happens until you do.
        </p>
        <p>If nothing arrives, look in your spam folder, or ask again in an hour.</p>
      </div>
    );

  return (
    <form
      aria-label="Ask about your personal data"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {problem ? (
        <p role="alert">
          <strong>{problem}</strong>
        </p>
      ) : null}
      <p>
        <label>
          Your email address
          <br />
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={{ inlineSize: "100%", maxInlineSize: "24rem" }}
          />
        </label>
      </p>
      <fieldset style={{ border: 0, padding: 0, margin: "1rem 0" }}>
        <legend>What would you like?</legend>
        <p>
          <label>
            <input
              type="radio"
              name="kind"
              checked={kind === "export"}
              onChange={() => setKind("export")}
            />{" "}
            Send me a copy of my personal data
          </label>
        </p>
        <p>
          <label>
            <input
              type="radio"
              name="kind"
              checked={kind === "delete"}
              onChange={() => setKind("delete")}
            />{" "}
            Delete my personal data
          </label>
        </p>
      </fieldset>
      {/* A field no person sees or reaches; a program that fills in everything fills this in too. */}
      <div aria-hidden="true" style={{ position: "absolute", insetInlineStart: "-9999px" }}>
        <label>
          Leave this empty
          <input
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={trap}
            onChange={(event) => setTrap(event.target.value)}
          />
        </label>
      </div>
      <p>
        <button type="submit" disabled={busy || email.trim() === ""}>
          Send me the confirmation link
        </button>
      </p>
    </form>
  );
}
