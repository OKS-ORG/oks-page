"use client";
// Tools > Site health (spec 07, section 16): the checks grouped by how much they matter. Colour is never the only sign: every
// result says its level in words.
import type { HealthReport, HealthResult } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: { message?: string };
  } | null;
  return {
    ok: response.ok && data?.ok === true,
    message: data?.error?.message ?? "That did not work.",
  };
}

const LEVEL = {
  red: "Needs action now",
  amber: "Worth a look",
  grey: "Could not check",
  green: "Fine",
} as const;
const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 10);

export function HealthScreen({ report, line }: { report: HealthReport; line: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setProblem("");
    setNote("");
    try {
      const r = await post(body);
      if (!r.ok) return setProblem(r.message);
      setNote(done);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const row = (r: HealthResult) => (
    <li key={r.key} data-health={r.key} data-level={r.level} style={{ marginBottom: "1rem" }}>
      <h3 style={{ margin: 0 }}>
        <span>{LEVEL[r.level]}:</span> {r.title}
      </h3>
      <p style={{ margin: ".25rem 0" }}>{r.text}</p>
      <div style={{ display: "grid", gap: ".6rem", justifyItems: "start" }}>
        {r.fix ? <a href={r.fix.href}>{r.fix.label}</a> : null}
        {r.level === "amber" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act({ action: "hide", key: r.key }, "Hidden.")}
          >
            I know, hide this
          </button>
        ) : null}
      </div>
    </li>
  );

  const problems = report.results.filter((r) => r.level === "red" || r.level === "amber");
  const rest = report.results.filter((r) => r.level === "grey" || r.level === "green");

  return (
    <>
      <p>
        Plain checks of how the site is doing. A red result needs action now and cannot be hidden.
        An amber one is worth a look: you can hide it, and it comes back if it gets worse or after
        90 days.
      </p>
      <Alert
        color={report.summary.red > 0 ? "danger" : report.summary.amber > 0 ? "warning" : "success"}
        title={line}
        description={`${report.summary.red} red, ${report.summary.amber} amber, ${report.summary.grey} could not be checked, ${report.summary.green} fine.`}
      />
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status">{note}</p>
      <p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act({ action: "recheck" }, "Checked again.")}
        >
          {busy ? "Checking…" : "Check again"}
        </button>
      </p>

      {problems.length > 0 ? (
        <section aria-labelledby="health-problems">
          <h2 id="health-problems">Needs a look</h2>
          <ul style={{ listStyle: "none", padding: 0 }}>{problems.map(row)}</ul>
        </section>
      ) : null}

      <section aria-labelledby="health-rest">
        <h2 id="health-rest">Fine, or not checked</h2>
        <ul style={{ listStyle: "none", padding: 0 }}>{rest.map(row)}</ul>
      </section>

      {report.hidden.length > 0 ? (
        <section aria-labelledby="health-hidden">
          <h2 id="health-hidden">Hidden</h2>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {report.hidden.map((r) => (
              <li key={r.key} data-hidden={r.key} style={{ marginBottom: "1rem" }}>
                <h3 style={{ margin: 0 }}>{r.title}</h3>
                <p style={{ margin: ".25rem 0" }}>
                  Hidden by {r.hiddenBy || "someone"} on {when(r.hiddenAt)}. It comes back if it
                  gets worse or after 90 days.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ action: "show", key: r.key }, "Shown again.")}
                >
                  Show again
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
