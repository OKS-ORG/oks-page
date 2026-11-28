"use client";
// The saved copies of an entry: who saved when, what changed, a compare with the page as it is now, and a restore.
import { Alert, Button } from "oks-ui";
import { Modal } from "@oks-page/admin";
import { useCallback, useEffect, useState } from "react";
import { useWhen } from "./time-format";

interface Copy {
  id: string;
  summary: string;
  authorName: string;
  createdAt: string;
}

interface Compare {
  title: { before: string; now: string };
  lines: { kind: "same" | "added" | "removed"; text: string }[];
}

export interface EntryRevisionsProps {
  id: string;
  /** The entry's current revision number; the list is loaded again when it changes. */
  revision: number;
  /** The site time zone, or null for the browser own. */
  timeZone?: string | null;
}

export function EntryRevisions({ id, revision, timeZone = null }: EntryRevisionsProps) {
  const when = useWhen(timeZone);
  const [copies, setCopies] = useState<Copy[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<{ copy: Copy; compare: Compare } | null>(null);
  const [restoring, setRestoring] = useState<Copy | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/entries/${id}/revisions`);
      const body = (await response.json()) as { revisions?: Copy[]; error?: { message: string } };
      if (response.ok) setCopies(body.revisions ?? []);
      else setProblem(body.error?.message ?? "The earlier copies could not be loaded.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function compare(copy: Copy) {
    setProblem(null);
    const response = await fetch(`/api/admin/entries/${id}/revisions?compare=${copy.id}`);
    const body = (await response.json()) as Compare & { error?: { message: string } };
    if (!response.ok) {
      setProblem(body.error?.message ?? "The copy could not be compared.");
      return;
    }
    setOpen({ copy, compare: body });
  }

  async function restore(copy: Copy) {
    setProblem(null);
    const response = await fetch(`/api/admin/entries/${id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisionId: copy.id, revision }),
    });
    if (response.ok) {
      window.location.reload();
      return;
    }
    const body = (await response.json()) as { error?: { message: string } };
    setProblem(body.error?.message ?? "The copy could not be restored.");
    setRestoring(null);
  }

  return (
    <section aria-labelledby="revisions-heading">
      <h2 id="revisions-heading">Earlier copies</h2>
      {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
      {copies === null ? (
        <p role="status">Loading…</p>
      ) : copies.length === 0 ? (
        <p>Every time you save, a copy is kept here. Nothing has been saved yet.</p>
      ) : (
        <ul>
          {copies.map((copy) => (
            <li key={copy.id}>
              {when(copy.createdAt)} by {copy.authorName || "someone"}: {copy.summary}{" "}
              <Button size="sm" onPress={() => void compare(copy)}>
                Compare
              </Button>{" "}
              <Button size="sm" onPress={() => setRestoring(copy)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <div role="region" aria-label="Compare with this copy">
          <h3>The copy from {when(open.copy.createdAt)}, compared with now</h3>
          {open.compare.title.before !== open.compare.title.now ? (
            <p>
              Title: “{open.compare.title.before}” then, “{open.compare.title.now}” now.
            </p>
          ) : null}
          {open.compare.lines.every((l) => l.kind === "same") ? (
            <p>The text is the same as now.</p>
          ) : (
            <ul>
              {open.compare.lines.map((line, i) => (
                <li key={i}>
                  {line.kind === "removed"
                    ? "Only in the copy: "
                    : line.kind === "added"
                      ? "Only in the page now: "
                      : ""}
                  {line.text}
                </li>
              ))}
            </ul>
          )}
          <Button size="sm" onPress={() => setOpen(null)}>
            Close the compare
          </Button>
        </div>
      ) : null}
      <Modal
        isOpen={restoring !== null}
        onClose={() => setRestoring(null)}
        role="alertdialog"
        title="Restore this copy?"
        actions={
          <>
            <Button onPress={() => setRestoring(null)}>Cancel</Button>
            <Button color="primary" onPress={() => restoring && void restore(restoring)}>
              Restore this copy
            </Button>
          </>
        }
      >
        <p>
          The title and content of the copy from {restoring ? when(restoring.createdAt) : ""} are
          saved as the newest version. Changes in the editor that are not saved will be lost. The
          address and the status stay as they are, and you can restore a later copy to undo this.
        </p>
      </Modal>
    </section>
  );
}
