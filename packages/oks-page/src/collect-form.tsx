"use client";
// The form of /collect/<token>: a name, some text and files. It sends them as one form and tells the client, in words, what
// arrived or what was wrong.
import { useState } from "react";

export function CollectForm({
  token,
  filesLeft,
  megabytesLeft,
  textLeft,
}: {
  token: string;
  filesLeft: number;
  megabytesLeft: number;
  textLeft: number;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState("");

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setProblem("");
    setDone("");
    try {
      const response = await fetch(`/api/collect/${encodeURIComponent(token)}`, {
        method: "POST",
        body: new FormData(form),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        texts?: number;
        files?: number;
      } | null;
      if (!response.ok || !body?.ok) {
        setProblem(body?.message ?? "It could not be sent. Please try again.");
        return;
      }
      const parts = [
        body.texts ? "your text" : "",
        body.files ? `${body.files} file${body.files === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      setDone(`Thank you. ${parts.join(" and ")} arrived. You can send more with this link.`);
      form.reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void send(event)} style={{ display: "grid", gap: "1rem" }}>
      {problem ? <p role="alert">{problem}</p> : null}
      {done ? <p role="status">{done}</p> : null}
      <label>
        Your name (so we know who sent it)
        <br />
        <input
          name="sender"
          type="text"
          maxLength={80}
          autoComplete="name"
          style={{ inlineSize: "100%" }}
        />
      </label>
      {textLeft > 0 ? (
        <label>
          Text for the page
          <br />
          <textarea name="text" rows={8} maxLength={textLeft} style={{ inlineSize: "100%" }} />
        </label>
      ) : null}
      {filesLeft > 0 && megabytesLeft > 0 ? (
        <label>
          Pictures and files (up to {filesLeft}, {megabytesLeft} MB together)
          <br />
          <input name="files" type="file" multiple />
        </label>
      ) : null}
      <input
        name="_hp"
        type="text"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        style={{ position: "absolute", insetInlineStart: "-9999px" }}
      />
      <p>
        <button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send"}
        </button>
      </p>
    </form>
  );
}
