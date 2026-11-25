"use client";
// Tools > Client content (spec 11, section 8): make a guided link for a client, turn links off, and go through what clients sent
// (accept a file into the library or text into a new draft page, or throw it away). Nothing is published by anything here.
import type { CollectLinkView, InboxItem } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

const FIELD = { inlineSize: "100%", maxInlineSize: "30rem" } as const;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const STATE = { working: "Working", off: "Turned off", expired: "Expired" } as const;

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: { message?: string };
    link?: string;
    kind?: string;
    entryId?: string;
  } | null;
  return {
    ok: response.ok && data?.ok === true,
    data,
    message: data?.error?.message ?? "That did not work.",
  };
}

export function CollectScreen({ links, inbox }: { links: CollectLinkView[]; inbox: InboxItem[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState("14");
  const [files, setFiles] = useState("10");
  const [megabytes, setMegabytes] = useState("50");
  const [chars, setChars] = useState("20000");
  const [made, setMade] = useState("");
  const [problem, setProblem] = useState("");
  const [note2, setNote2] = useState("");

  async function make(event: React.FormEvent) {
    event.preventDefault();
    setProblem("");
    setMade("");
    const r = await post({
      action: "make",
      label,
      note,
      days,
      maxFiles: files,
      maxMegabytes: megabytes,
      maxText: chars,
    });
    if (!r.ok) return setProblem(r.message);
    setMade(r.data?.link ?? "");
    setLabel("");
    setNote("");
    router.refresh();
  }
  async function act(action: string, id: string) {
    setProblem("");
    setNote2("");
    const r = await post({ action, id });
    if (!r.ok) return setProblem(r.message);
    if (action === "accept")
      setNote2(
        r.data?.kind === "file"
          ? "The file is in the library."
          : "A draft page was made from the text. It is not published.",
      );
    router.refresh();
  }

  return (
    <>
      <p>
        Give a client a link where they can send you text and pictures for a page, with no account.
        What they send waits here until you accept it. Nothing is published by itself.
      </p>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <section aria-labelledby="collect-new" style={{ maxInlineSize: "46rem" }}>
        <h2 id="collect-new">Make a link</h2>
        <form onSubmit={(e) => void make(e)} style={{ display: "grid", gap: ".8rem" }}>
          <label>
            What is it for (the client sees this)
            <br />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
              style={FIELD}
              required
            />
          </label>
          <label>
            A note for the client (what to send)
            <br />
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              style={FIELD}
            />
          </label>
          <label>
            Days the link works
            <br />
            <input
              value={days}
              onChange={(e) => setDays(e.target.value)}
              inputMode="numeric"
              style={{ inlineSize: "6rem" }}
            />
          </label>
          <label>
            Most files
            <br />
            <input
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              inputMode="numeric"
              style={{ inlineSize: "6rem" }}
            />
          </label>
          <label>
            Most megabytes for all files together
            <br />
            <input
              value={megabytes}
              onChange={(e) => setMegabytes(e.target.value)}
              inputMode="numeric"
              style={{ inlineSize: "6rem" }}
            />
          </label>
          <label>
            Most characters of text
            <br />
            <input
              value={chars}
              onChange={(e) => setChars(e.target.value)}
              inputMode="numeric"
              style={{ inlineSize: "6rem" }}
            />
          </label>
          <p>
            <button type="submit">Make the link</button>
          </p>
        </form>
        {made ? (
          <div role="status">
            <p>
              <strong>Copy this address now. It is shown only once</strong>; the site keeps no copy
              of it.
            </p>
            <input
              readOnly
              value={made}
              aria-label="The client's link"
              style={{ ...FIELD, maxInlineSize: "100%" }}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="collect-links" style={{ marginBlockStart: "2rem" }}>
        <h2 id="collect-links">Links</h2>
        {links.length === 0 ? (
          <p>No links yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">For</th>
                <th scope="col">State</th>
                <th scope="col">Works until</th>
                <th scope="col">Used</th>
                <th scope="col">Waiting</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <th scope="row">{l.label}</th>
                  <td>{STATE[l.state]}</td>
                  <td>{day(l.expiresAt)}</td>
                  <td>
                    {l.usedFiles} of {l.maxFiles} files, {size(l.usedBytes)} of{" "}
                    {Math.round(l.maxBytes / (1024 * 1024))} MB, {l.usedText.toLocaleString("en")}{" "}
                    of {l.maxText.toLocaleString("en")} characters
                  </td>
                  <td>{l.waiting}</td>
                  <td>
                    {l.state === "off" ? (
                      <button type="button" onClick={() => void act("on", l.id)}>
                        Turn on {l.label}
                      </button>
                    ) : l.state === "working" ? (
                      <button type="button" onClick={() => void act("off", l.id)}>
                        Turn off {l.label}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="collect-inbox" style={{ marginBlockStart: "2rem" }}>
        <h2 id="collect-inbox">Inbox</h2>
        {note2 ? <p role="status">{note2}</p> : null}
        {inbox.length === 0 ? (
          <p>Nothing has been sent yet.</p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              display: "grid",
              gap: "1rem",
              maxInlineSize: "46rem",
            }}
          >
            {inbox.map((i) => (
              <li key={i.id} style={{ border: "1px solid currentColor", padding: ".8rem" }}>
                <p>
                  <strong>{i.kind === "file" ? i.fileName : "Text"}</strong> for {i.linkLabel}
                  {i.sender ? `, from ${i.sender}` : ""} on {day(i.createdAt)}
                  {i.status === "accepted" ? " (accepted)" : ""}
                </p>
                {i.kind === "text" && i.status === "pending" ? (
                  <p style={{ whiteSpace: "pre-wrap" }}>{i.text}</p>
                ) : null}
                {i.kind === "file" ? (
                  <p>
                    {i.mime}, {size(i.sizeBytes)}
                  </p>
                ) : null}
                <p>
                  {i.status === "pending" ? (
                    <button type="button" onClick={() => void act("accept", i.id)}>
                      {i.kind === "file"
                        ? `Accept ${i.fileName} into the library`
                        : "Accept the text as a draft page"}
                    </button>
                  ) : null}{" "}
                  <button type="button" onClick={() => void act("discard", i.id)}>
                    {i.kind === "file" ? `Throw away ${i.fileName}` : "Throw away this text"}
                  </button>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
