"use client";
// The words of the site's emails (spec 13, section 6): pick an email, change its subject and text, see it with sample
// values, send yourself a test, or go back to the original. Placeholders such as {name} are filled in when it is sent;
// the ones an email cannot do without are listed, and a text without them is not saved.
import type { EmailTextView } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useEffect, useRef, useState } from "react";

interface Preview {
  subject: string;
  text: string;
  html: string;
  problems: string[];
}

const failure = (body: unknown, fallback: string) =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function EmailTextsScreen({
  initial,
  emailWorks,
  you,
}: {
  initial: EmailTextView[];
  emailWorks: boolean;
  you: string;
}) {
  const [texts, setTexts] = useState(initial);
  const [key, setKey] = useState(initial[0]?.key ?? "");
  const open = texts.find((t) => t.key === key) ?? texts[0]!;
  const [subject, setSubject] = useState(open.currentSubject);
  const [body, setBody] = useState(open.currentBody);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const choose = (next: EmailTextView) => {
    setKey(next.key);
    setSubject(next.currentSubject);
    setBody(next.currentBody);
    setNote("");
    setProblem(null);
  };

  // The preview follows the text a moment after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetch("/api/admin/settings/email-texts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", key, subject, body }),
      })
        .then((r) => r.json())
        .then((answer: { preview?: Preview }) => answer.preview && setPreview(answer.preview))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [key, subject, body]);

  const reload = async () => {
    const response = await fetch("/api/admin/settings/email-texts");
    const answer = (await response.json().catch(() => null)) as { texts?: EmailTextView[] } | null;
    if (response.ok && answer?.texts) setTexts(answer.texts);
  };

  async function call(
    method: string,
    url: string,
    payload: unknown,
    done: string,
    fallback: string,
  ) {
    setProblem(null);
    setNote("");
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const answer: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setProblem(failure(answer, fallback));
      return false;
    }
    // The message shows once the screen has the new words, so the two always agree.
    await reload();
    setNote(done);
    return true;
  }

  const insert = (name: string) => {
    const el = area.current;
    const token = `{${name}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
  };

  return (
    <div className="oks-email-texts">
      <style>{`
.oks-email-texts-grid{display:grid;grid-template-columns:minmax(13rem,16rem) minmax(0,1fr);gap:1.5rem;align-items:start}
.oks-email-texts-list button{display:block;inline-size:100%;text-align:start;min-block-size:28px;padding:.25rem .4rem;background:none;border:1px solid transparent;color:inherit;font:inherit;cursor:pointer}
.oks-email-texts-list button[aria-current="true"]{border-color:currentColor;font-weight:600}
.oks-email-texts-preview iframe{inline-size:100%;block-size:28rem;border:1px solid currentColor;background:#fff}
@media (max-width:767px){.oks-email-texts-grid{grid-template-columns:1fr}}
`}</style>
      <p>
        <a href="/admin/settings/email">Back to the email settings</a>
      </p>
      <div className="oks-email-texts-grid">
        <nav aria-label="Emails" className="oks-email-texts-list">
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {texts.map((t) => (
              <li key={t.key}>
                <button type="button" aria-current={t.key === key} onClick={() => choose(t)}>
                  {t.title}
                  <br />
                  <small>
                    {t.security ? "Security email" : "Email"}
                    {t.edited ? " · changed by you" : " · original"}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <section aria-label={open.title}>
          <h2 style={{ fontSize: "1.1rem" }}>{open.title}</h2>
          {open.security ? (
            <Alert
              color="warning"
              title="A security email"
              description="People use this email to get into their account. Keep the link and say clearly what it is for."
            />
          ) : null}
          {open.key !== "footer" ? (
            <p>
              <label htmlFor="email-text-subject">Subject</label>
              <br />
              <input
                id="email-text-subject"
                value={subject}
                maxLength={200}
                onChange={(e) => setSubject(e.target.value)}
                style={{ minBlockSize: "32px", inlineSize: "100%" }}
              />
            </p>
          ) : (
            <p>
              The footer is added at the end of every email, for example your address or a link to
              your imprint.
            </p>
          )}
          <p>
            <label htmlFor="email-text-body">Text</label>
            <br />
            <textarea
              id="email-text-body"
              ref={area}
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-describedby="email-text-help"
              style={{ inlineSize: "100%", fontFamily: "inherit" }}
            />
          </p>
          <p id="email-text-help">
            A blank line starts a new paragraph. Write **bold**, *italic*, a list with &quot;-
            &quot; at the start of each line, and a link as [what it says](https://…).
            {open.required.length > 0
              ? ` This email cannot work without ${open.required.map((r) => `{${r}}`).join(", ")}.`
              : ""}
          </p>
          <p style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
            <span>Put in:</span>
            {open.placeholders.map((name) => (
              <Button key={name} size="sm" onPress={() => insert(name)}>
                {`{${name}}`}
              </Button>
            ))}
          </p>
          {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
          {preview && preview.problems.length > 0 && !problem ? (
            <Alert
              color="warning"
              title="This cannot be saved yet"
              description={preview.problems.join(" ")}
            />
          ) : null}
          <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            <Button
              color="primary"
              onPress={() =>
                void call(
                  "PUT",
                  "/api/admin/settings/email-texts",
                  { key, subject, body },
                  "Saved. Emails use your words from now on.",
                  "It could not be saved.",
                )
              }
            >
              Save
            </Button>
            {open.edited ? (
              <Button
                onPress={() =>
                  void call(
                    "DELETE",
                    `/api/admin/settings/email-texts?key=${encodeURIComponent(key)}`,
                    null,
                    "Back to the original words.",
                    "It could not be reset.",
                  ).then((ok) => {
                    if (ok) {
                      setSubject(open.subject);
                      setBody(open.body);
                    }
                  })
                }
              >
                Reset to the original
              </Button>
            ) : null}
            {emailWorks && open.key !== "footer" ? (
              <Button
                onPress={() =>
                  void call(
                    "POST",
                    "/api/admin/settings/email-texts",
                    { action: "test", key, subject, body },
                    `A test is on its way to ${you}, with sample values.`,
                    "The test could not be sent.",
                  )
                }
              >
                Send me a test
              </Button>
            ) : null}
          </p>
          <p role="status">{note}</p>
          {preview ? (
            <section aria-label="Preview" className="oks-email-texts-preview">
              <h3 style={{ fontSize: "1rem" }}>Preview with sample values</h3>
              <p>
                <strong>Subject:</strong> {preview.subject}
              </p>
              <iframe title="Preview of the email" sandbox="" srcDoc={preview.html} />
              <details>
                <summary style={{ minBlockSize: "24px", lineHeight: "24px" }}>
                  The plain text version
                </summary>
                <pre style={{ whiteSpace: "pre-wrap" }}>{preview.text}</pre>
              </details>
            </section>
          ) : null}
        </section>
      </div>
    </div>
  );
}
