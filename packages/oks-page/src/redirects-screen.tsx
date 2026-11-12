"use client";
// The redirects screen: the list (old address, new address, kind, uses), a box to add one and a Delete button.
// Redirects made by changing a published address appear here too.
import { ListTable } from "@oks-page/admin";
import type { RedirectView } from "@oks-page/core";
import { Alert, Button, Modal, TextField } from "oks-ui";
import { useState, type FormEvent } from "react";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

interface Row extends Record<string, unknown> {
  id: string;
  from: string;
  to: string;
  kind: string;
  hits: number;
  made: string;
  redirect: RedirectView;
}

const KINDS: Record<number, string> = {
  301: "301 permanent",
  302: "302 temporary",
  307: "307 temporary (keeps the method)",
  308: "308 permanent (keeps the method)",
};

export function RedirectsScreen({ redirects }: { redirects: RedirectView[] }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("301");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<RedirectView | null>(null);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);

  const rows: Row[] = redirects.map((r) => ({
    id: r.id,
    from: r.from,
    to: r.to,
    kind: KINDS[r.status] ?? String(r.status),
    hits: r.hits,
    made: new Date(r.createdAt).toISOString().slice(0, 10),
    redirect: r,
  }));

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch("/api/admin/redirects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from, to, status: Number(status) }),
      });
      if (response.ok) {
        window.location.assign(window.location.pathname);
        return;
      }
      setProblem(failure(await response.json().catch(() => null), "It could not be added."));
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  async function remove() {
    if (!deleting) return;
    setDeleteProblem(null);
    try {
      const response = await fetch(`/api/admin/redirects/${deleting.id}`, { method: "DELETE" });
      if (response.ok) {
        window.location.assign(window.location.pathname);
        return;
      }
      setDeleteProblem(
        failure(await response.json().catch(() => null), "It could not be deleted."),
      );
    } catch {
      setDeleteProblem("The site could not be reached. Check your connection and try again.");
    }
  }

  return (
    <>
      <p>
        When a published page or post gets a new address, a redirect from the old address is added
        by itself, so old links and search results keep working. You can add your own here.
      </p>
      <form onSubmit={(event) => void add(event)} aria-label="Add a redirect">
        {problem ? <Alert color="danger" title="Not added" description={problem} /> : null}
        <TextField
          name="from"
          label="Old address"
          description="For example /old-page"
          required
          value={from}
          onChange={setFrom}
        />
        <TextField
          name="to"
          label="New address"
          description="For example /new-page, or a full address starting with https://"
          required
          value={to}
          onChange={setTo}
        />
        <p>
          <label htmlFor="redirect-kind">Kind </label>
          <select id="redirect-kind" value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(KINDS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </p>
        <Button type="submit" color="primary" isDisabled={busy}>
          Add redirect
        </Button>
      </form>
      {rows.length === 0 ? (
        <p>There are no redirects yet.</p>
      ) : (
        <ListTable
          label="Redirects"
          rows={rows}
          getRowKey={(row) => row.id}
          columns={[
            { key: "from", header: "Old address", sortable: true },
            { key: "to", header: "New address", sortable: true },
            { key: "kind", header: "Kind", sortable: true },
            { key: "hits", header: "Uses", sortable: true, render: (row) => `${row.hits}` },
            { key: "made", header: "Added", sortable: true },
            {
              key: "actions",
              header: "Actions",
              render: (row) => (
                <Button
                  size="sm"
                  color="danger"
                  aria-label={`Delete the redirect from ${row.from}`}
                  onPress={() => {
                    setDeleteProblem(null);
                    setDeleting(row.redirect);
                  }}
                >
                  Delete
                </Button>
              ),
            },
          ]}
        />
      )}
      <Modal
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        role="alertdialog"
        title="Delete this redirect?"
        actions={
          <>
            <Button onPress={() => setDeleting(null)}>Cancel</Button>
            <Button color="danger" onPress={() => void remove()}>
              Delete
            </Button>
          </>
        }
      >
        {deleteProblem ? (
          <Alert color="danger" title="Not deleted" description={deleteProblem} />
        ) : null}
        <p>
          {deleting?.from} will no longer lead to {deleting?.to}. Visitors who use the old address
          get a “page not found”.
        </p>
      </Modal>
    </>
  );
}
