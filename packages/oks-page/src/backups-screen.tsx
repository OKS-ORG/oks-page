"use client";
// Tools > Backups (spec 14, part 2): make a backup, download it, put the whole site back as it was at one, or delete one.
import type { BackupInfo } from "@oks-page/core";
import { Alert } from "oks-ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const size = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    : bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const KIND = {
  manual: "Made by a person",
  daily: "Daily",
  safety: "Safety copy before a restore",
  remote: "Asked for by the agency",
} as const;

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/backups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: { message?: string };
    safetyBackup?: string;
    rows?: number;
    files?: number;
  } | null;
  return {
    ok: response.ok && data?.ok === true,
    data,
    message: data?.error?.message ?? "That did not work.",
  };
}

export function BackupsScreen({ backups }: { backups: BackupInfo[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [sure, setSure] = useState(false);

  async function run(
    body: Record<string, unknown>,
    done: (r: Awaited<ReturnType<typeof post>>) => string,
  ) {
    setBusy(true);
    setProblem("");
    setNote("");
    try {
      const r = await post(body);
      if (!r.ok) return setProblem(r.message);
      setNote(done(r));
      setAsking(null);
      setSure(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        A backup is the whole site in one file: its pages, settings, users, plugins and themes, and
        every picture and file in the library. Each one is checked right after it is made, by
        reading it again and trying it in a copy. Backups are kept on the server, in the folder{" "}
        <code>backups</code>.
      </p>
      <Alert
        color="warning"
        title="Keep two things safe"
        description="A backup holds all of the site's data, including the people who have accounts, so keep a downloaded file private. It does not hold the site's secret key (OKS_SECRET in the .env file): keep a copy of that key somewhere safe too, or saved passwords such as the email password cannot be read after a restore on another server."
      />
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      <p role="status">{note}</p>
      <p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run({ action: "make" }, () => "The backup was made and checked.")}
        >
          {busy && !asking ? "Working…" : "Make a backup now"}
        </button>
      </p>

      <h2>Backups</h2>
      {backups.length === 0 ? (
        <p>There is no backup yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Made on</th>
              <th scope="col">Kind</th>
              <th scope="col">Size</th>
              <th scope="col">Holds</th>
              <th scope="col">Check</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.name}>
                <th scope="row">{when(b.createdAt)}</th>
                <td>{KIND[b.kind]}</td>
                <td>{size(b.size)}</td>
                <td>
                  {b.rows.toLocaleString("en")} records, {b.files.toLocaleString("en")} files
                </td>
                <td>
                  {b.checkedAt === null
                    ? "Not checked"
                    : b.compatible
                      ? "Checked: every file matches and it opens in a copy"
                      : "Checked, but made by another version of the software"}
                </td>
                <td>
                  <div style={{ display: "grid", gap: ".6rem", justifyItems: "start" }}>
                    <a href={`/api/admin/backups/${b.name}`} download>
                      Download {b.name}
                    </a>
                    {b.compatible ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setAsking(b.name);
                          setSure(false);
                        }}
                      >
                        Restore {b.name}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          { action: "delete", name: b.name },
                          () => "The backup was deleted.",
                        )
                      }
                    >
                      Delete {b.name}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {asking ? (
        <section
          aria-labelledby="restore-title"
          style={{ marginBlockStart: "2rem", maxInlineSize: "46rem" }}
        >
          <h2 id="restore-title">Put the whole site back</h2>
          <p>
            This puts the site back as it was at{" "}
            <strong>{when(backups.find((b) => b.name === asking)?.createdAt ?? 0)}</strong>: its
            pages, settings, users, plugins and themes. What was changed since then is replaced.
            Before it starts, the site makes a safety backup of how it is now, so a restore can be
            undone by restoring that one. People who are still in the backup stay signed in. If you
            use plugins, restart the site afterwards so they start from the restored state.
          </p>
          <p>
            <label style={{ display: "flex", gap: ".5rem", alignItems: "flex-start" }}>
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
              <span>I understand this replaces the site as it is now.</span>
            </label>
          </p>
          <p>
            <button
              type="button"
              disabled={!sure || busy}
              onClick={() =>
                void run(
                  { action: "restore", name: asking, confirm: true },
                  (r) =>
                    `The site was put back. The site as it was before is kept as ${r.data?.safetyBackup ?? "a safety backup"}.`,
                )
              }
            >
              {busy ? "Putting it back…" : "Put the site back"}
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </button>
          </p>
        </section>
      ) : null}
    </>
  );
}
