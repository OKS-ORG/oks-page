"use client";
// Settings > Privacy (design batch 5; spec 18): the cookies the site sets, whether a consent notice is needed, and the
// privacy page (choose one, or have a draft written), whether visitors are counted, and how long data is kept.
import type {
  ConsentTextField,
  ConsentTexts,
  ImprintInput,
  KeepingRule,
  KeepingView,
  PrivacySettings,
  SiteCookie,
} from "@oks-page/core";
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
  consentTexts,
  consentFields,
  imprintFields,
  defaultEmail,
  statisticsOn,
}: {
  cookies: SiteCookie[];
  noVisitorCookies: boolean;
  consentNeeded: boolean;
  needs: ConsentNeeds;
  initial: PrivacySettings;
  pages: { id: string; title: string; status: string }[];
  keeping: KeepingView;
  keepingRules: KeepingRule[];
  consentTexts: ConsentTexts;
  consentFields: ConsentTextField[];
  imprintFields: { id: keyof ImprintInput; label: string; max: number; required: boolean }[];
  defaultEmail: string;
  statisticsOn: boolean;
}) {
  const [counting, setCounting] = useState(statisticsOn);
  const [countNote, setCountNote] = useState("");
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
        <p>
          The site counts page views and visitors without cookies and without keeping anyone&apos;s
          address: each visitor is a code made with a secret that changes every day, used to count
          them once that day and deleted the next day. Only daily totals are kept. Browsers that
          send &ldquo;do not track&rdquo; are not counted. See the totals in{" "}
          <a href="/admin/tools/statistics">Tools &gt; Statistics</a>.
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={counting}
              onChange={(event) => {
                const enabled = event.target.checked;
                setCounting(enabled);
                setCountNote("Saving…");
                void fetch("/api/admin/settings/privacy", {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ statistics: { enabled } }),
                }).then(async (response) => {
                  if (!response.ok) {
                    // Back to what is really saved.
                    setCounting(!enabled);
                    setCountNote("The choice could not be saved.");
                    return;
                  }
                  setCountNote(enabled ? "Visitors are counted." : "Visitors are not counted.");
                });
              }}
            />{" "}
            Count visitors
          </label>
        </p>
        <p role="status">{countNote}</p>
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
      <ConsentTextsSection initial={consentTexts} fields={consentFields} />
      <ImprintSection fields={imprintFields} />
      <AccessibilitySection defaultEmail={defaultEmail} />
      <KeepingSection initial={keeping} rules={keepingRules} />
    </>
  );
}

/** Asks the site to write a draft page and opens it in the editor. */
async function writeLegalDraft(
  body: unknown,
  set: { note: (t: string) => void; problem: (t: string | null) => void },
) {
  set.problem(null);
  set.note("Writing a draft…");
  const response = await fetch("/api/admin/settings/privacy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => null)) as {
    editUrl?: string;
    error?: { message?: string };
  } | null;
  if (!response.ok || !answer?.editUrl) {
    set.note("");
    set.problem(answer?.error?.message ?? "The draft could not be written.");
    return;
  }
  set.note("Draft written. Opening it…");
  window.location.assign(answer.editUrl);
}

/** The imprint (spec 18, section 4): a draft page from what the owner enters. */
function ImprintSection({
  fields,
}: {
  fields: { id: keyof ImprintInput; label: string; max: number; required: boolean }[];
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      aria-labelledby="privacy-imprint"
      onSubmit={(event) => {
        event.preventDefault();
        void writeLegalDraft(
          { draft: "imprint", imprint: values },
          { note: setNote, problem: setProblem },
        );
      }}
    >
      <h2 id="privacy-imprint">Imprint</h2>
      <p>
        Some countries (for example Germany and Austria) ask a website to say who runs it. Enter the
        details and the site writes a draft page. It is not published: read it, check it against the
        law of your country, then publish it.
      </p>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      {fields.map((f) => (
        <p key={f.id}>
          <label>
            {f.label}
            {f.required ? " (needed)" : ""}
            <br />
            {f.id === "address" ? (
              <textarea
                value={values[f.id] ?? ""}
                maxLength={f.max}
                rows={3}
                onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                style={{ ...FIELD, minBlockSize: "5rem" }}
              />
            ) : (
              <input
                type={f.id === "email" ? "email" : "text"}
                value={values[f.id] ?? ""}
                maxLength={f.max}
                onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                style={FIELD}
              />
            )}
          </label>
        </p>
      ))}
      <p>
        <Button type="submit" color="primary">
          Write an imprint draft
        </Button>
      </p>
      <p role="status">{note}</p>
    </form>
  );
}

/** The accessibility statement (spec 18, section 4): a draft built from what the site's checker finds. */
function AccessibilitySection({ defaultEmail }: { defaultEmail: string }) {
  const [email, setEmail] = useState(defaultEmail);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      aria-labelledby="privacy-a11y"
      onSubmit={(event) => {
        event.preventDefault();
        void writeLegalDraft(
          { draft: "accessibility", contactEmail: email },
          { note: setNote, problem: setProblem },
        );
      }}
    >
      <h2 id="privacy-a11y">Accessibility statement</h2>
      <p>
        The European Accessibility Act asks many websites for an accessibility statement. The site
        reads all your published pages and posts with its accessibility checker and writes a draft
        that says what it found. The draft claims nothing more than that: an automatic check cannot
        prove that a site is accessible. It is not published.
      </p>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p>
        <label>
          Where visitors can report a problem (email address)
          <br />
          <input
            type="email"
            value={email}
            maxLength={120}
            onChange={(e) => setEmail(e.target.value)}
            style={FIELD}
          />
        </label>
      </p>
      <p>
        <Button type="submit" color="primary">
          Write an accessibility statement draft
        </Button>
      </p>
      <p role="status">{note}</p>
    </form>
  );
}

/** The words of the consent notice (spec 18, section 2). The rules stay fixed: both answers look and weigh the same. */
function ConsentTextsSection({
  initial,
  fields,
}: {
  initial: ConsentTexts;
  fields: ConsentTextField[];
}) {
  const [values, setValues] = useState<Record<string, string>>({ ...initial });
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/settings/privacy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consentTexts: values }),
    });
    const body = (await response.json().catch(() => null)) as {
      texts?: ConsentTexts;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.texts) {
      setNote("");
      setProblem(body?.error?.message ?? "The texts could not be saved.");
      return;
    }
    setValues({ ...body.texts });
    setNote("The notice texts are saved.");
  }

  return (
    <form aria-labelledby="privacy-texts" onSubmit={(event) => void save(event)}>
      <h2 id="privacy-texts">Words of the consent notice</h2>
      <p>
        Change what the notice says. Accept and refuse always look the same and nothing is ticked
        for the visitor, whatever the words. Leave a field empty to use the standard words.
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      {fields.map((f) => (
        <p key={f.id}>
          <label>
            {f.label}
            <br />
            {f.long ? (
              <textarea
                value={values[f.id] ?? ""}
                maxLength={f.max}
                rows={4}
                onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                style={{ ...FIELD, minBlockSize: "6rem" }}
              />
            ) : (
              <input
                type="text"
                value={values[f.id] ?? ""}
                maxLength={f.max}
                onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                style={FIELD}
              />
            )}
          </label>
        </p>
      ))}
      <p>
        <Button type="submit" color="primary">
          Save notice texts
        </Button>
      </p>
      <p role="status">{note}</p>
    </form>
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
              Commenters&apos; addresses
              <br />
              <small style={{ fontWeight: "normal" }}>Not kept by this site.</small>
            </th>
            <td colSpan={2}>Nothing to delete: the site does not keep them.</td>
          </tr>
        </tbody>
      </table>
      <p>
        {view.lastRun
          ? `Last clean-up: ${new Date(view.lastRun.at).toISOString().slice(0, 16).replace("T", " ")} UTC. It deleted ${view.lastRun.deleted.email_log} email record(s), ${view.lastRun.deleted.audit_log} audit entr${view.lastRun.deleted.audit_log === 1 ? "y" : "ies"} and ${view.lastRun.deleted.search_terms} search count(s) , ${view.lastRun.deleted.consent_records} consent record(s) and ${view.lastRun.deleted.statistics} daily total(s) of visitor counts.`
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
