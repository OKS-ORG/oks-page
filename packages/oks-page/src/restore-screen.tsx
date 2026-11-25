"use client";
// The restore screen (decision D60): the page, what the client's change was (the earlier text against the text now), and the button
// that puts the earlier version back. The page stays live.
import type { ClientEditView } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useState } from "react";

export function RestoreScreen({ token, view }: { token: string; view: ClientEditView }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState("");

  async function restore() {
    setBusy(true);
    setProblem("");
    try {
      const response = await fetch("/api/admin/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!response.ok || !body?.ok) {
        setProblem(body?.error?.message ?? "It could not be put back.");
        return;
      }
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>{view.title}</h2>
      <p>
        A client changed this live page. Below is what the client did to the text: a line marked{" "}
        <strong>Removed</strong> was taken out, and a line marked <strong>Added</strong> was put in.
        Putting the earlier version back undoes all of it.
      </p>
      {view.savedSince ? (
        <Alert
          color="warning"
          title="The page was saved again after the client's change"
          description="Putting the earlier version back replaces those later changes too. Look at the page first if you are not sure."
        />
      ) : null}
      {view.compare.title.before !== view.compare.title.now ? (
        <p>
          Title: it was “{view.compare.title.before}”, it is now “{view.compare.title.now}”.
        </p>
      ) : null}
      {view.compare.lines.length === 0 ? (
        <p>The text is the same; the change was in the layout or the pictures.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, maxInlineSize: "46rem" }}>
          {view.compare.lines.map((line, i) => (
            <li key={i} style={{ padding: ".2rem 0" }}>
              <strong>
                {line.kind === "removed" ? "Removed" : line.kind === "added" ? "Added" : "Same"}:
              </strong>{" "}
              {line.text}
            </li>
          ))}
        </ul>
      )}
      {problem ? <Alert color="danger" title="Not put back" description={problem} /> : null}
      {done ? (
        <p role="status">
          The earlier version is back, and the page is still live.{" "}
          <a href={`/admin/pages/${view.entryId}`}>Open the page</a>
        </p>
      ) : (
        <p>
          <button type="button" disabled={busy} onClick={() => void restore()}>
            {busy ? "Putting it back…" : "Put the earlier version back"}
          </button>
        </p>
      )}
    </>
  );
}
