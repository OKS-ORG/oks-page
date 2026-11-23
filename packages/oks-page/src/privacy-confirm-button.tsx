"use client";
// The button that confirms a request. Opening the link only shows this page; the request is confirmed when the person
// presses the button, so a program that fetches the link (an email scanner) confirms nothing.
import { useState } from "react";

export function PrivacyConfirmButton({ token }: { token: string }) {
  const [state, setState] = useState<
    { kind: "ready" } | { kind: "done"; text: string } | { kind: "problem"; text: string }
  >({
    kind: "ready",
  });
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    const response = await fetch("/api/privacy/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setBusy(false);
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      kind?: string;
      already?: boolean;
    } | null;
    if (!response.ok) {
      setState({
        kind: "problem",
        text: body?.message ?? "This could not be confirmed. Please try again later.",
      });
      return;
    }
    setState({
      kind: "done",
      text: body?.already
        ? "Your request was confirmed already. The site owner will answer it."
        : "Thank you. Your request is confirmed. The site owner will answer it within 30 days.",
    });
  }

  if (state.kind === "done")
    return (
      <p role="status">
        <strong>{state.text}</strong>
      </p>
    );
  return (
    <>
      {state.kind === "problem" ? (
        <p role="alert">
          <strong>{state.text}</strong>
        </p>
      ) : null}
      <p>
        <button type="button" disabled={busy} onClick={() => void confirm()}>
          Yes, this request is mine
        </button>
      </p>
    </>
  );
}
