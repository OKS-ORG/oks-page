"use client";
// Tools > Handoff (spec 11, section 9): the checklist for giving a site to a client. Each item has a plain explanation, a link
// to the place where it is done, a note when the site can already tell, and a tick that is saved at once.
import type { HandoffView } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useState } from "react";

export function HandoffScreen({ initial, bundle }: { initial: HandoffView; bundle: boolean }) {
  const [done, setDone] = useState<string[]>(initial.items.filter((i) => i.done).map((i) => i.id));
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function toggle(id: string, on: boolean) {
    const next = on ? [...done, id] : done.filter((x) => x !== id);
    const before = done;
    setDone(next);
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/handoff", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: next }),
    });
    if (!response.ok) {
      setDone(before);
      setNote("");
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setProblem(body?.error?.message ?? "The checklist could not be saved.");
      return;
    }
    setNote(`Saved. ${next.length} of ${initial.total} done.`);
  }

  return (
    <>
      <p>
        Go through this list before you give the site to its owner. Giving a site away never needs a
        licence. Tick an item when it is really done; the site only tells you what it can see.
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p>
        <strong>
          {done.length} of {initial.total} done
        </strong>
        {done.length === initial.total ? " — ready to hand over." : "."}
      </p>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          display: "grid",
          gap: "1rem",
          maxInlineSize: "46rem",
        }}
      >
        {initial.items.map((item) => (
          <li key={item.id}>
            <label style={{ display: "flex", gap: ".6rem", alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={done.includes(item.id)}
                onChange={(event) => void toggle(item.id, event.target.checked)}
                style={{ inlineSize: "1.25rem", blockSize: "1.25rem", marginBlockStart: ".2rem" }}
              />
              <span>
                <strong>{item.title}</strong>
                <br />
                {item.why}
                {item.hint ? (
                  <>
                    <br />
                    <em>{item.hint}</em>
                  </>
                ) : null}
                {item.href ? (
                  <>
                    <br />
                    <a href={item.href}>Open the place to do it</a>
                  </>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p role="status">{note}</p>
      {bundle ? <BundleSection /> : null}
    </>
  );
}

/** The site bundle: the whole site in one file, to give away or to start a copy. */
function BundleSection() {
  const [file, setFile] = useState<File | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function send() {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    setDone("");
    try {
      const response = await fetch("/api/admin/bundle?confirm=replace", {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: file,
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
        counts?: { entries: number; media: number; menus: number; settings: number };
        skippedThemes?: string[];
      } | null;
      if (!response.ok || !body?.ok || !body.counts) {
        setProblem(body?.error?.message ?? "The bundle could not be imported.");
        return;
      }
      const c = body.counts;
      const skipped = body.skippedThemes ?? [];
      setDone(
        `Imported: ${c.entries} pages and posts, ${c.media} media files, ${c.menus} menus and ${c.settings} settings.` +
          (skipped.length > 0
            ? ` The look of ${skipped.join(", ")} was not taken, because this site does not have that theme.`
            : ""),
      );
      setFile(null);
      setSure(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="bundle-title"
      style={{ maxInlineSize: "46rem", marginBlockStart: "2rem" }}
    >
      <h2 id="bundle-title">Site bundle</h2>
      <p>
        A bundle is the whole site in one file: its pages and posts, pictures and other files,
        menus, redirects, saved sections and look. Use it to give the site to its owner, or to start
        a copy on another site.
      </p>
      <p>
        <strong>Left out on purpose:</strong> people and their sign-in details, comments, the
        history of changes, plugins, email and publishing settings, the licence, privacy records and
        statistics, and every secret and password. The site that takes the bundle keeps its own.
      </p>
      <p>
        <a href="/api/admin/bundle" download>
          Download the site bundle
        </a>
      </p>
      <h3>Import a bundle</h3>
      <p>
        <strong>This replaces</strong> the pages, posts, media, menus, redirects, saved sections and
        look of this site with what is in the bundle. Download this site&apos;s own bundle first if
        you may want it back.
      </p>
      {problem ? <Alert color="danger" title="Not imported" description={problem} /> : null}
      <p>
        <label>
          Bundle file (.tgz)
          <br />
          <input
            type="file"
            accept=".tgz,.gz,application/gzip"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
      </p>
      <p>
        <label style={{ display: "flex", gap: ".5rem", alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={sure}
            onChange={(event) => setSure(event.target.checked)}
          />
          <span>I understand this replaces what is on this site now.</span>
        </label>
      </p>
      <p>
        <button type="button" disabled={!file || !sure || busy} onClick={() => void send()}>
          {busy ? "Importing…" : "Import the bundle"}
        </button>
      </p>
      <p role="status">{done}</p>
    </section>
  );
}
