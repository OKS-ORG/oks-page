"use client";
// Settings > Privacy (design batch 5; spec 18): the cookies the site sets, whether a consent notice is needed, and the
// privacy page (choose one, or have a draft written). Visitor counts come in a later release.
import type { KeepingRule, KeepingView, PrivacySettings, SiteCookie } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import type { ConsentNeeds } from "./consent-needs";
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
  needs,
  initial,
  pages,
  keeping,
  keepingRules,
}: {
  cookies: SiteCookie[];
  noVisitorCookies: boolean;
  consentNeeded: boolean;
  needs: ConsentNeeds;
  initial: PrivacySettings;
  pages: { id: string; title: string; status: string }[];
  keeping: KeepingView;
  keepingRules: KeepingRule[];
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
            {needs.plugins.flatMap((p) =>
              p.cookies.map((c) => (
                <tr key={`${p.plugin}-${c.name}`}>
                  <th scope="row">{c.name}</th>
                  <td>Visitors (plugin {p.plugin})</td>
                  <td>{c.why}</td>
                  <td>{c.purpose === "essential" ? "Not asked (needed)" : "Asked first"}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="privacy-outside">
        <h2 id="privacy-outside">Other companies</h2>
        {needs.plugins.some((p) => p.outsideHosts.length > 0) || needs.videos.length > 0 ? (
          <ul>
            {needs.plugins.flatMap((p) =>
              p.outsideHosts.map((h) => (
                <li key={`${p.plugin}-${h.host}`}>
                  {h.host} (plugin {p.plugin}): {h.why}{" "}
                  {h.purpose === "essential" ? "Not asked (needed)." : "Asked first."}
                </li>
              )),
            )}
            {needs.videos.map((v) => (
              <li key={v.entryId + v.company}>
                {v.company}: a video on{" "}
                <a href={`/admin/pages/${v.entryId}`}>{v.title || "a page"}</a> loads when the page
                opens. Asked first. Turn off “load at once” on the video to stop that.
              </li>
            ))}
          </ul>
        ) : (
          <p>Your site loads nothing from other companies.</p>
        )}
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
      <KeepingSection initial={keeping} rules={keepingRules} />
    </>
  );
}

/** How long personal data is kept (spec 18, section 6): the owner may make a time shorter, never longer. */
function KeepingSection({ initial, rules }: { initial: KeepingView; rules: KeepingRule[] }) {
  const [view, setView] = useState(initial);
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(rules.map((r) => [r.id, String(initial.days[r.id])])),
  );
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/settings/privacy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keeping: values }),
    });
    const body = (await response.json().catch(() => null)) as {
      keeping?: KeepingView;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.keeping) {
      setNote("");
      setProblem(body?.error?.message ?? "The times could not be saved.");
      return;
    }
    setView(body.keeping);
    setValues(Object.fromEntries(rules.map((r) => [r.id, String(body.keeping!.days[r.id])])));
    setNote("The keeping times are saved. Older data is deleted at the next daily clean-up.");
  }

  return (
    <form aria-labelledby="privacy-keeping" onSubmit={(event) => void save(event)}>
      <h2 id="privacy-keeping">How long data is kept</h2>
      <p>
        Personal data is deleted when it is older than these times, once a day. You may make a time
        shorter, never longer.
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <table>
        <caption className="oks-sr-only">How long each kind of data is kept</caption>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">Days</th>
            <th scope="col">The most</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                {r.label}
                <br />
                <small style={{ fontWeight: "normal" }}>{r.what}</small>
              </th>
              <td style={{ verticalAlign: "top" }}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={r.leastDays}
                  max={r.defaultDays}
                  step={1}
                  aria-label={`Days to keep: ${r.label}`}
                  value={values[r.id] ?? ""}
                  onChange={(e) => setValues({ ...values, [r.id]: e.target.value })}
                  style={{ inlineSize: "6rem", minBlockSize: "32px" }}
                />
              </td>
              <td style={{ verticalAlign: "top" }}>
                {r.defaultDays} days (from {r.leastDays})
                {view.shortened[r.id] ? " · shortened" : ""}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">
              Form messages
              <br />
              <small style={{ fontWeight: "normal" }}>Kept by the Forms plugin.</small>
            </th>
            <td colSpan={2}>
              12 months unless you set another time (1 to 36 months) in the settings of the Forms
              plugin, under Plugins.
            </td>
          </tr>
          <tr>
            <th scope="row">
              Posts in the trash
              <br />
              <small style={{ fontWeight: "normal" }}>Emptied by the site.</small>
            </th>
            <td colSpan={2}>30 days.</td>
          </tr>
          <tr>
            <th scope="row">
              Visitor counts and commenters&apos; addresses
              <br />
              <small style={{ fontWeight: "normal" }}>Not kept by this site.</small>
            </th>
            <td colSpan={2}>Nothing to delete: the site does not keep them.</td>
          </tr>
        </tbody>
      </table>
      <p>
        {view.lastRun
          ? `Last clean-up: ${new Date(view.lastRun.at).toISOString().slice(0, 16).replace("T", " ")} UTC. It deleted ${view.lastRun.deleted.email_log} email record(s), ${view.lastRun.deleted.audit_log} audit entr${view.lastRun.deleted.audit_log === 1 ? "y" : "ies"} and ${view.lastRun.deleted.search_terms} search count(s).`
          : "The first clean-up has not run yet. It runs once a day."}
      </p>
      <p>
        <Button type="submit" color="primary">
          Save keeping times
        </Button>
      </p>
      <p role="status">{note}</p>
    </form>
  );
}
