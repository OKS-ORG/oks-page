"use client";
// Settings > Privacy (design batch 5; spec 18): the cookies the site sets, whether a consent notice is needed, and the
// privacy page (choose one, or have a draft written). Visitor counts come in a later release.
import type { PrivacySettings, SiteCookie } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

const FIELD: React.CSSProperties = {
  minBlockSize: "32px",
  maxInlineSize: "28rem",
  inlineSize: "100%",
};

export function PrivacySettingsScreen({
  cookies,
  noVisitorCookies,
  consentNeeded,
  initial,
  pages,
}: {
  cookies: SiteCookie[];
  noVisitorCookies: boolean;
  consentNeeded: boolean;
  initial: PrivacySettings;
  pages: { id: string; title: string; status: string }[];
}) {
  const [saved, setSaved] = useState(initial.pageId ?? "");
  const [pageId, setPageId] = useState(initial.pageId ?? "");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/settings/privacy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: pageId || null }),
    });
    const body = (await response.json().catch(() => null)) as {
      settings?: PrivacySettings;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.settings) {
      setNote("");
      setProblem(body?.error?.message ?? "The privacy page could not be saved.");
      return;
    }
    setSaved(body.settings.pageId ?? "");
    setNote(body.settings.pageId ? "Privacy page saved." : "The site has no privacy page now.");
  }

  async function writeDraft() {
    setProblem(null);
    setWriting(true);
    setNote("Writing a draft…");
    const response = await fetch("/api/admin/settings/privacy", { method: "POST" });
    const body = (await response.json().catch(() => null)) as {
      editUrl?: string;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.editUrl) {
      setWriting(false);
      setNote("");
      setProblem(body?.error?.message ?? "The draft could not be written.");
      return;
    }
    setNote("Draft written. Opening it…");
    window.location.assign(body.editUrl);
  }

  const chosen = pages.find((p) => p.id === saved);
  return (
    <>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      {noVisitorCookies && !consentNeeded ? (
        <Alert
          color="success"
          title="No cookie banner needed"
          description="Your site sets no cookies for visitors, so it does not need a cookie banner."
        />
      ) : null}
      <section aria-labelledby="privacy-cookies">
        <h2 id="privacy-cookies">Cookies</h2>
        <p>Every cookie your site sets. Plugins you add will show theirs here.</p>
        <table>
          <thead>
            <tr>
              <th scope="col">Cookie</th>
              <th scope="col">Who gets it</th>
              <th scope="col">What it is for</th>
              <th scope="col">Consent</th>
            </tr>
          </thead>
          <tbody>
            {cookies.map((c) => (
              <tr key={c.name}>
                <th scope="row">{c.name}</th>
                <td>{c.who === "visitors" ? "Visitors" : "People who sign in"}</td>
                <td>{c.purpose}</td>
                <td>{c.needed ? "Not asked (needed)" : "Asked first"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="privacy-consent">
        <h2 id="privacy-consent">Consent notice</h2>
        <p>
          {consentNeeded
            ? "Something on your site needs visitors to agree first, so a consent notice is shown."
            : "Off, because nothing on your site needs consent. It turns on by itself when a plugin or content from another company needs it."}
        </p>
      </section>
      <section aria-labelledby="privacy-counts">
        <h2 id="privacy-counts">Visitor counts</h2>
        <p>Your site does not count visitors. Counting without cookies comes in a later release.</p>
      </section>
      <form aria-labelledby="privacy-page" onSubmit={(event) => void save(event)}>
        <h2 id="privacy-page">Privacy page</h2>
        <p>
          {chosen ? (
            <>
              Your privacy page is <a href={`/admin/pages/${chosen.id}`}>{chosen.title}</a>
              {chosen.status === "published" ? "." : " (not published yet)."}
            </>
          ) : (
            "Your site has no privacy page yet."
          )}
        </p>
        <p>
          <label htmlFor="privacy-page-choice">Page</label>
          <br />
          <select
            id="privacy-page-choice"
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            style={FIELD}
          >
            <option value="">None</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.status === "published" ? p.title : `${p.title} (${p.status})`}
              </option>
            ))}
          </select>
        </p>
        <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          <Button type="submit" color="primary" isDisabled={pageId === saved}>
            Save privacy page
          </Button>
          <Button type="button" onPress={() => void writeDraft()} isDisabled={writing}>
            Write a draft for me
          </Button>
        </p>
        <p>
          The draft says what your site really uses: its cookies, content from other companies,
          visitor counts and the email service. It is not published: read it, add who runs the site,
          then publish it.
        </p>
        <p role="status">{note}</p>
      </form>
    </>
  );
}
