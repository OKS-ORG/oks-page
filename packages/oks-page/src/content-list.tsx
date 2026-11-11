"use client";
// The list of pages or posts, with a box to add a new one.
import { ListTable } from "@oks-page/admin";
import { Alert, Button, TextField } from "oks-ui";
import { useState, type FormEvent } from "react";
import type { ListedEntry } from "@oks-page/core";

export interface ContentListProps {
  /** The content type ("page", "post") and the word for its screen ("pages", "posts"). */
  type: string;
  segment: string;
  singular: string;
  entries: ListedEntry[];
  canAdd: boolean;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

export function ContentList({ type, segment, singular, entries, canAdd }: ContentListProps) {
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch("/api/admin/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, title }),
      });
      const body = (await response.json()) as { id?: string; error?: { message: string } };
      if (response.ok && body.id) {
        window.location.assign(`/admin/${segment}/${body.id}`);
        return;
      }
      setProblem(body.error?.message ?? "It could not be added. Try again.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <>
      {canAdd ? (
        <form onSubmit={add} aria-label={`Add a ${singular}`}>
          {problem ? <Alert color="danger" title="Not added" description={problem} /> : null}
          <TextField
            name="title"
            label={`Title of the new ${singular}`}
            required
            value={title}
            onChange={setTitle}
          />
          <Button type="submit" color="primary" isDisabled={busy}>
            Add new
          </Button>
        </form>
      ) : null}
      {entries.length === 0 ? (
        <p>Nothing here yet.</p>
      ) : (
        <ListTable
          label={segment}
          rows={entries.map((e) => ({ ...e, updated: when(e.updatedAt) }))}
          getRowKey={(row) => row.id}
          columns={[
            {
              key: "title",
              header: "Title",
              sortable: true,
              render: (row) => <a href={`/admin/${segment}/${row.id}`}>{row.title}</a>,
            },
            { key: "status", header: "Status", sortable: true },
            { key: "authorName", header: "Author", sortable: true },
            {
              key: "updated",
              header: "Updated",
              sortValue: (row) => row.updatedAt,
              sortable: true,
            },
          ]}
        />
      )}
    </>
  );
}
