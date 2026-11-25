"use client";
// Tools > Agency dashboard (spec 11, section 6): connect client sites with the code each site made, see their state at a glance,
// check them all at once, and read a site's page and visit counts.
import type { AgencySiteView } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const gb = (bytes: number | null) =>
  bytes === null ? "not known" : `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB free`;

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/agency", {
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
    data,
    message: data?.error?.message ?? "That did not work.",
  };
}

function State({ site }: { site: AgencySiteView }) {
  const last = site.last;
  if (!last) return <>Not checked yet</>;
  if (!last.ok) return <>Problem: {last.error}</>;
  const s = last.status!;
  const bad = s.checks.filter((c) => !c.ok);
  return (
    <>
      Reachable. Version {s.version || "unknown"}.{" "}
      {bad.length === 0
        ? "All checks are fine."
        : `Needs a look: ${bad.map((c) => c.label).join("; ")}.`}
    </>
  );
}

export function AgencyScreen({
  sites,
  active,
  limit,
}: {
  sites: AgencySiteView[];
  active: boolean;
  limit: number;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(body: Record<string, unknown>, done?: string) {
    setProblem("");
    setNote("");
    setBusy(true);
    try {
      const r = await post(body);
      if (!r.ok) {
        setProblem(r.message);
        return null;
      }
      if (done) setNote(done);
      router.refresh();
      return r;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        The client sites you look after, with what each one reports: its version, whether email and
        two-factor are set up, the free disk space and its page and visit counts. A site can never
        be read beyond that, and each one is connected with a code its own owner makes under Tools
        &gt; Connection.
      </p>
      {active ? (
        <p>
          Your Agency key covers {limit} site{limit === 1 ? "" : "s"}; {sites.length} connected.
        </p>
      ) : (
        <Alert
          color="warning"
          title="The dashboard needs an Agency key"
          description="Without a valid Agency key you can see the last known state of the sites below and disconnect them. Add an Agency key under Tools > Licences to connect or check sites."
        />
      )}
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status">{note}</p>

      <section aria-labelledby="agency-sites">
        <h2 id="agency-sites">Sites</h2>
        {sites.length === 0 ? (
          <p>No site is connected yet.</p>
        ) : (
          <>
            <p>
              <button
                type="button"
                disabled={!active || busy}
                onClick={() => void run({ action: "check" }, "All sites were asked.")}
              >
                {busy ? "Checking…" : "Check all sites"}
              </button>
            </p>
            <table>
              <thead>
                <tr>
                  <th scope="col">Site</th>
                  <th scope="col">State</th>
                  <th scope="col">Updates</th>
                  <th scope="col">Last backup</th>
                  <th scope="col">Disk</th>
                  <th scope="col">Checked</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">
                      {s.name}
                      <br />
                      <small>{s.url}</small>
                    </th>
                    <td>
                      <State site={s} />
                    </td>
                    <td>
                      {s.last?.status
                        ? s.last.status.pendingUpdates === null
                          ? "Not known yet"
                          : `${s.last.status.pendingUpdates} waiting`
                        : "-"}
                    </td>
                    <td>
                      {s.last?.status
                        ? s.last.status.lastBackupAt === null
                          ? "None yet"
                          : when(s.last.status.lastBackupAt)
                        : "-"}
                    </td>
                    <td>{s.last?.status ? gb(s.last.status.diskFreeBytes) : "-"}</td>
                    <td>{s.last ? when(s.last.at) : "-"}</td>
                    <td>
                      {active ? (
                        <>
                          <a href={`/admin/tools/agency/report/${s.id}`}>
                            Report for {s.name}
                          </a>{" "}
                        </>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run({ action: "remove", id: s.id }, `${s.name} was disconnected.`)
                        }
                      >
                        Disconnect {s.name}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section
        aria-labelledby="agency-add"
        style={{ marginBlockStart: "2rem", maxInlineSize: "46rem" }}
      >
        <h2 id="agency-add">Connect a site</h2>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const r = await run({ action: "add", code, name }, "The site is connected.");
            if (r) {
              setCode("");
              setName("");
            }
          }}
          style={{ display: "grid", gap: ".8rem" }}
        >
          <label>
            The connection code (from Tools &gt; Connection on the client&apos;s site)
            <br />
            <textarea
              rows={3}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={!active}
              style={{ inlineSize: "100%" }}
              required
            />
          </label>
          <label>
            A name for it (optional)
            <br />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!active}
              maxLength={80}
              style={{ inlineSize: "100%", maxInlineSize: "30rem" }}
            />
          </label>
          <p>
            <button type="submit" disabled={!active || busy}>
              Connect the site
            </button>
          </p>
        </form>
      </section>
    </>
  );
}
