"use client";
// The client report (spec 11, section 3), as a page that prints well and a form to send it by email. The numbers are drawn as bars
// with the same numbers in a table, so nothing depends on seeing the picture.
import type { ClientReport } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useState } from "react";

const n = (v: number) => v.toLocaleString("en");
const PERIODS = [7, 30, 90];

function Bars({ perDay }: { perDay: ClientReport["perDay"] }) {
  const max = Math.max(1, ...perDay.map((d) => d.views));
  const top = perDay.reduce((best, d) => (d.views > best.views ? d : best), perDay[0]!);
  const w = 600;
  const h = 120;
  const gap = perDay.length > 60 ? 0.5 : 2;
  const bar = (w - gap * (perDay.length - 1)) / perDay.length;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Page views for each day from ${perDay[0]!.day} to ${perDay[perDay.length - 1]!.day}. The most on one day was ${n(top.views)}, on ${top.day}.`}
      style={{ inlineSize: "100%", maxInlineSize: "40rem", blockSize: "auto" }}
    >
      {perDay.map((d, i) => {
        const bh = Math.max(d.views > 0 ? 2 : 0, (d.views / max) * (h - 4));
        return (
          <rect
            key={d.day}
            x={i * (bar + gap)}
            y={h - bh}
            width={bar}
            height={bh}
            fill="var(--oks-color-primary-700, #1a5fb4)"
          />
        );
      })}
    </svg>
  );
}

export function AgencyReportScreen({
  id,
  days,
  report,
  problem,
}: {
  id: string;
  days: number;
  report: ClientReport | null;
  problem: string;
}) {
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [trouble, setTrouble] = useState("");

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setDone("");
    setTrouble("");
    try {
      const response = await fetch("/api/admin/agency", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "email-report", id, days, to, note }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!response.ok || !body?.ok) {
        setTrouble(body?.error?.message ?? "The report could not be sent.");
        return;
      }
      setDone(`The report was handed to the mail queue for ${to}.`);
      setNote("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        maxInlineSize: "52rem",
        margin: "2rem auto",
        padding: "0 1rem",
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.5,
      }}
    >
      <style>{`@media print { .no-print { display: none !important; } main { margin: 0 !important; } }`}</style>
      <p className="no-print">
        <a href="/admin/tools/agency">Back to the agency dashboard</a>
      </p>
      {problem || !report ? (
        <Alert color="danger" title="The report could not be made" description={problem} />
      ) : (
        <>
          <h1>Report for {report.siteName}</h1>
          <p>
            {report.siteUrl}
            <br />
            From {report.from} to {report.to} ({report.days} days)
          </p>
          <nav aria-label="Period" className="no-print">
            {PERIODS.map((p) => (
              <span key={p}>
                {p === days ? (
                  <strong aria-current="true">{p} days</strong>
                ) : (
                  <a href={`/admin/tools/agency/report/${id}?days=${p}`}>{p} days</a>
                )}{" "}
              </span>
            ))}
          </nav>

          <h2>Visits</h2>
          <p>
            <strong>{n(report.views)}</strong> page views by <strong>{n(report.visitors)}</strong>{" "}
            visitors.
          </p>
          <p>
            <small>
              A person who came on two days counts twice, because nobody is followed from day to
              day. No cookies are used and no one can be picked out.
            </small>
          </p>
          {report.perDay.length > 0 ? (
            <>
              <Bars perDay={report.perDay} />
              <details className="no-print">
                <summary>The numbers for each day</summary>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col">Page views</th>
                      <th scope="col">Visitors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.perDay.map((d) => (
                      <tr key={d.day}>
                        <th scope="row">{d.day}</th>
                        <td>{n(d.views)}</td>
                        <td>{n(d.visitors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          ) : null}

          <h2>The most read pages</h2>
          {report.topPages.length === 0 ? (
            <p>No page was read in this time.</p>
          ) : (
            <ol>
              {report.topPages.map((p) => (
                <li key={p.key}>
                  {p.key || "/"}: {n(p.count)}
                </li>
              ))}
            </ol>
          )}

          <h2>The site</h2>
          <p>{n(report.publishedPages)} published pages.</p>
          {report.health ? (
            <ul>
              {report.health.version ? <li>Software version {report.health.version}</li> : null}
              {report.health.checks.map((c) => (
                <li key={c.label}>
                  {c.ok ? "Fine" : "Needs a look"}: {c.label}
                </li>
              ))}
            </ul>
          ) : (
            <p>The state of the site could not be read just now.</p>
          )}
          <p>
            <small>
              Made by {report.preparedBy || "your site team"} on{" "}
              {new Date(report.generatedAt).toISOString().slice(0, 10)}.
            </small>
          </p>

          <section
            aria-labelledby="report-send"
            className="no-print"
            style={{ marginBlockStart: "2rem" }}
          >
            <h2 id="report-send">Send it to the client</h2>
            <p>
              <button type="button" onClick={() => window.print()}>
                Print or save as PDF
              </button>
            </p>
            {trouble ? <Alert color="danger" title="Not sent" description={trouble} /> : null}
            {done ? <p role="status">{done}</p> : null}
            <form
              onSubmit={(e) => void send(e)}
              style={{ display: "grid", gap: ".8rem", maxInlineSize: "34rem" }}
            >
              <label>
                The client&apos;s email address
                <br />
                <input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  required
                  style={{ inlineSize: "100%" }}
                />
              </label>
              <label>
                A few words to go with it (optional)
                <br />
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={1000}
                  style={{ inlineSize: "100%" }}
                />
              </label>
              <p>
                <button type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Email the report"}
                </button>
              </p>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
