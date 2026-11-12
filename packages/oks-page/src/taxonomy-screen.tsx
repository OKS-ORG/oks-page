"use client";
// Categories or Tags: the list, a box to add one, and a window to change or delete one.
import { ListTable } from "@oks-page/admin";
import type { TaxonomyView, TermView } from "@oks-page/core";
import { Alert, Button, Modal, TextField } from "oks-ui";
import { useMemo, useState, type FormEvent } from "react";

const DEFAULT_SLUG = "uncategorised";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

interface Row extends Record<string, unknown> {
  id: string;
  label: string;
  slug: string;
  description: string;
  count: number;
  term: TermView;
}

/** The terms in tree order (a child right after its parent), each with how deep it sits. */
function inTreeOrder(terms: TermView[]): { term: TermView; depth: number }[] {
  const byParent = new Map<string | null, TermView[]>();
  for (const t of terms) {
    const parent = t.parentId && terms.some((p) => p.id === t.parentId) ? t.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), t]);
  }
  const out: { term: TermView; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const t of byParent.get(parent) ?? []) {
      out.push({ term: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The ids of a term and everything under it: none of these can become its parent. */
function branchOf(terms: TermView[], id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of terms)
      if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
  }
  return ids;
}

function ParentSelect({
  id,
  terms,
  value,
  onChange,
  exclude,
  disabled,
}: {
  id: string;
  terms: TermView[];
  value: string;
  onChange: (value: string) => void;
  exclude?: Set<string>;
  disabled?: boolean;
}) {
  return (
    <p>
      <label htmlFor={id}>Parent category </label>
      <select
        id={id}
        value={value}
        disabled={disabled === true}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">None (top level)</option>
        {inTreeOrder(terms)
          .filter(({ term }) => !exclude?.has(term.id))
          .map(({ term, depth }) => (
            <option key={term.id} value={term.id}>
              {"– ".repeat(depth)}
              {term.name}
            </option>
          ))}
      </select>
    </p>
  );
}

export function TaxonomyScreen({ taxonomy }: { taxonomy: TaxonomyView }) {
  const { key, hierarchical, terms } = taxonomy;
  const single = key === "category" ? "category" : "tag";
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<TermView | null>(null);
  const [editName, setEditName] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editParent, setEditParent] = useState("");
  const [deleting, setDeleting] = useState<TermView | null>(null);
  const [dialogProblem, setDialogProblem] = useState<string | null>(null);

  const rows: Row[] = useMemo(() => {
    const ordered = hierarchical ? inTreeOrder(terms) : terms.map((term) => ({ term, depth: 0 }));
    return ordered.map(({ term, depth }) => ({
      id: term.id,
      label: `${"– ".repeat(depth)}${term.name}`,
      slug: term.slug,
      description: term.description,
      count: term.count,
      term,
    }));
  }, [terms, hierarchical]);

  const reload = () => window.location.assign(window.location.pathname);

  async function send(
    url: string,
    method: string,
    body: unknown,
    fallback: string,
  ): Promise<string | null> {
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.ok) return null;
      return failure(await response.json().catch(() => null), fallback);
    } catch {
      return "The site could not be reached. Check your connection and try again.";
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    const error = await send(
      `/api/admin/taxonomies/${key}`,
      "POST",
      { name, ...(hierarchical && parent ? { parentId: parent } : {}) },
      "It could not be added. Try again.",
    );
    if (!error) return reload();
    setProblem(error);
    setBusy(false);
  }

  function openEdit(term: TermView) {
    setDialogProblem(null);
    setEditName(term.name);
    setEditSlug(term.slug);
    setEditDescription(term.description);
    setEditParent(term.parentId ?? "");
    setEditing(term);
  }

  async function saveEdit() {
    if (!editing) return;
    setDialogProblem(null);
    const error = await send(
      `/api/admin/terms/${editing.id}`,
      "PATCH",
      {
        name: editName,
        slug: editSlug,
        description: editDescription,
        ...(hierarchical ? { parentId: editParent || null } : {}),
      },
      "It could not be saved. Try again.",
    );
    if (!error) return reload();
    setDialogProblem(error);
  }

  async function remove() {
    if (!deleting) return;
    setDialogProblem(null);
    const error = await send(
      `/api/admin/terms/${deleting.id}`,
      "DELETE",
      undefined,
      "It could not be deleted. Try again.",
    );
    if (!error) return reload();
    setDialogProblem(error);
  }

  const isDefault = (term: TermView) => key === "category" && term.slug === DEFAULT_SLUG;

  return (
    <>
      <nav aria-label="Posts grouping">
        <a
          href="/admin/categories"
          {...(key === "category" ? { "aria-current": "page" as const } : {})}
        >
          Categories
        </a>
        {" | "}
        <a href="/admin/tags" {...(key === "tag" ? { "aria-current": "page" as const } : {})}>
          Tags
        </a>
      </nav>
      <form onSubmit={(event) => void add(event)} aria-label={`Add a ${single}`}>
        {problem ? <Alert color="danger" title="Not added" description={problem} /> : null}
        <TextField
          name="name"
          label={`Name of the new ${single}`}
          required
          value={name}
          onChange={setName}
        />
        {hierarchical ? (
          <ParentSelect id="new-parent" terms={terms} value={parent} onChange={setParent} />
        ) : null}
        <Button type="submit" color="primary" isDisabled={busy}>
          Add new {single}
        </Button>
      </form>
      {rows.length === 0 ? (
        <p>No {taxonomy.label.toLowerCase()} yet.</p>
      ) : (
        <ListTable
          label={taxonomy.label}
          rows={rows}
          getRowKey={(row) => row.id}
          columns={[
            { key: "label", header: "Name", sortable: true },
            { key: "slug", header: "Address", sortable: true },
            { key: "description", header: "Description" },
            { key: "count", header: "Posts", sortable: true, render: (row) => `${row.count}` },
            {
              key: "actions",
              header: "Actions",
              render: (row) => (
                <>
                  <Button size="sm" onPress={() => openEdit(row.term)}>
                    Edit
                  </Button>{" "}
                  {isDefault(row.term) ? null : (
                    <Button
                      size="sm"
                      color="danger"
                      onPress={() => {
                        setDialogProblem(null);
                        setDeleting(row.term);
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      <Modal
        isOpen={editing !== null}
        onClose={() => setEditing(null)}
        title={`Change ${single}`}
        actions={
          <>
            <Button onPress={() => setEditing(null)}>Cancel</Button>
            <Button color="primary" onPress={() => void saveEdit()}>
              Save
            </Button>
          </>
        }
      >
        {dialogProblem ? (
          <Alert color="danger" title="Not saved" description={dialogProblem} />
        ) : null}
        <TextField name="edit-name" label="Name" value={editName} onChange={setEditName} />
        <TextField
          name="edit-slug"
          label="Address"
          value={editSlug}
          onChange={setEditSlug}
          disabled={editing !== null && isDefault(editing)}
        />
        <TextField
          name="edit-description"
          label="Description"
          value={editDescription}
          onChange={setEditDescription}
        />
        {hierarchical && editing ? (
          <ParentSelect
            id="edit-parent"
            terms={terms}
            value={editParent}
            onChange={setEditParent}
            exclude={branchOf(terms, editing.id)}
            disabled={isDefault(editing)}
          />
        ) : null}
      </Modal>
      <Modal
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        role="alertdialog"
        title={`Delete this ${single}?`}
        actions={
          <>
            <Button onPress={() => setDeleting(null)}>Cancel</Button>
            <Button color="danger" onPress={() => void remove()}>
              Delete
            </Button>
          </>
        }
      >
        {dialogProblem ? (
          <Alert color="danger" title="Not deleted" description={dialogProblem} />
        ) : null}
        <p>
          {deleting?.name} will be removed.{" "}
          {key === "category"
            ? "Posts that have only this category move to Uncategorised. Categories under it move up one level."
            : "It is taken off the posts that use it. The posts stay."}
        </p>
      </Modal>
    </>
  );
}
