"use client";
// Tools > Updates (spec 14, part 1): what the site runs, the newest versions, and the security warnings that name something
// the site uses. The list is checked on the site itself; nothing about the site is sent (UP-01).
import type { UpdateView } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/updates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: { message?: string };
    outcome?: { status: string; reason?: string };
  } | null;
  return {
    ok: response.ok && data?.ok === true,
    data,
    message: data?.error?.message ?? "That did not work.",
  };
}

const HEALTH = {
  off: "Update checks are off. This site does not learn about new versions or security problems.",
  no_server:
    "No list of updates has been received yet. Nothing about this site is sent when it looks; it only downloads our public list.",
  failing: "The last look at the list of updates did not work.",
  stale: "Update checks have not worked for 7 days. The list below may be out of date.",
  ok: "The list of updates is up to date.",
} as const;

const SEVERITY = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;

export function UpdatesScreen({ view, hasServer }: { view: UpdateView; hasServer: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const [on, setOn] = useState(view.on);
  const c = view.comparison;

  async function checkNow() {
    setBusy(true);
    setProblem("");
    setNote("");
    try {
      const r = await post({ action: "check" });
      if (!r.ok) return setProblem(r.message);
      const o = r.data?.outcome;
      if (o?.status === "new") setNote("A newer list was received.");
      else if (o?.status === "same") setNote("The list is the newest one.");
      else if (o?.status === "no_server")
        setNote("This site has no address to look at yet (OKS_UPDATE_URL).");
      else if (o?.status === "off") setNote("Update checks are off.");
      else setProblem(o?.reason ?? "The list could not be used.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        The site downloads one public list of the newest versions and of security warnings, checks
        that we signed it, and compares it with what it runs. It sends nothing about itself: no site
        name, no version and no list of plugins.
      </p>
      <Alert
        color={view.health === "ok" ? "success" : view.health === "off" ? "warning" : "default"}
        title={on ? HEALTH[view.health] : HEALTH.off}
        description={
          view.failure
            ? view.failure
            : view.checkedAt !== null
              ? `Last looked at ${when(view.checkedAt)}.`
              : hasServer
                ? "The first look comes soon."
                : undefined
        }
      />
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status">{note}</p>
      {view.urgentFailure ? (
        <p>The last look at the urgent list did not work: {view.urgentFailure}</p>
      ) : view.urgentCheckedAt !== null ? (
        <p>
          The urgent list (security warnings only) was last looked at {when(view.urgentCheckedAt)}.
        </p>
      ) : null}

      <p>
        <label style={{ display: "flex", gap: ".5rem", alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={on}
            disabled={busy}
            onChange={async (event) => {
              const next = event.target.checked;
              setOn(next);
              const r = await post({ action: "switch", on: next });
              if (!r.ok) {
                setOn(!next);
                setProblem(r.message);
              } else {
                setNote(next ? "Update checks are on." : "Update checks are off.");
                router.refresh();
              }
            }}
          />
          <span>Look for updates and security warnings once a day</span>
        </label>
      </p>
      <p>
        <button type="button" disabled={busy || !on} onClick={() => void checkNow()}>
          {busy ? "Looking…" : "Look now"}
        </button>
      </p>

      {c && c.warnings.length > 0 ? (
        <section aria-labelledby="updates-warnings">
          <h2 id="updates-warnings">Security warnings for this site</h2>
          {c.warnings.map((w) => (
            <Alert
              key={w.id}
              color={w.severity === "critical" || w.severity === "high" ? "danger" : "warning"}
              title={`${SEVERITY[w.severity]}: ${w.affects === "core" ? "the core" : w.affects}`}
              description={`${w.summary} Fixed in version ${w.fixed}.`}
            />
          ))}
          <ul>
            {c.warnings.map((w) => (
              <li key={w.id}>
                <a href={w.link} rel="noreferrer noopener" target="_blank">
                  Read about {w.id}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {c ? (
        <section aria-labelledby="updates-what">
          <h2 id="updates-what">What this site runs</h2>
          {!c.core.supported ? (
            <Alert
              color="danger"
              title="This version no longer gets security fixes"
              description="Update to a newer version of the core."
            />
          ) : null}
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">In use</th>
                <th scope="col">Newest</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">The core</th>
                <td>{c.core.current}</td>
                <td>{c.core.latest ?? "unknown"}</td>
                <td>{c.core.behind ? "A newer version is ready" : "Up to date"}</td>
              </tr>
              {c.items.map((item) => (
                <tr key={item.key}>
                  <th scope="row">{item.name}</th>
                  <td>{item.version}</td>
                  <td>{item.latest ?? "unknown"}</td>
                  <td>
                    {item.unsafe
                      ? "This version is marked unsafe"
                      : !item.tracked
                        ? "Updates are not checked for this plugin"
                        : item.behind
                          ? "A newer version is ready"
                          : "Up to date"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.core.behind ? (
            <p>
              To update the core: with Docker, pull the new image and restart; otherwise run{" "}
              <code>npx oks upgrade</code>, build, and restart the server.
            </p>
          ) : null}
          {view.seq !== null && view.issued ? (
            <p>
              List number {view.seq}, made {view.issued.slice(0, 10)}.
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
