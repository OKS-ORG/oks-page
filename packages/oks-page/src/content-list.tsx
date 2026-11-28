"use client";
// The list of pages or posts, with a box to add a new one.
import { ListTable, type ListSort, Modal } from "@oks-page/admin";
import { Alert, Button, TextField } from "oks-ui";
import { useMemo, useState, type FormEvent } from "react";
import { useWhen } from "./time-format";
import type { ListedEntry, TrashedEntry } from "@oks-page/core";

export interface ContentListProps {
  /** The content type ("page", "post") and the word for its screen ("pages", "posts"). */
  type: string;
  segment: string;
  singular: string;
  entries: ListedEntry[];
  /** What is in the trash, for the Trash view. */
  trashed: TrashedEntry[];
  view: "all" | "trash";
  canAdd: boolean;
  /** The site time zone, or null for the browser own. */
  timeZone?: string | null;
}

interface ImportReply {
  created: number;
  published: number;
  keptAsDrafts: number;
  skipped: number;
  items: {
    row: number;
    name?: string;
    title: string;
    outcome: string;
    status?: string;
    note?: string;
  }[];
}

/** The words for a status, and the tab each one counts in. */
const STATUS_WORDS: Record<string, string> = {
  published: "Published",
  draft: "Draft",
  scheduled: "Scheduled",
  pending: "Waiting for review",
};
const FILTERS: { key: string; label: string }[] = [
  { key: "published", label: "Published" },
  { key: "draft", label: "Drafts" },
  { key: "scheduled", label: "Scheduled" },
  { key: "pending", label: "Waiting for review" },
];
const SORTS: { key: string; label: string; sort: ListSort }[] = [
  {
    key: "changed-desc",
    label: "Newest changes",
    sort: { column: "updated", direction: "descending" },
  },
  {
    key: "changed-asc",
    label: "Oldest changes",
    sort: { column: "updated", direction: "ascending" },
  },
  { key: "title-asc", label: "Title A to Z", sort: { column: "title", direction: "ascending" } },
  { key: "title-desc", label: "Title Z to A", sort: { column: "title", direction: "descending" } },
];

/** What an import did: the counts, and a line for each one that needs a word. */
function ImportOutcome({
  problem,
  report,
  segment,
}: {
  problem: string | null;
  report: ImportReply | null;
  segment: string;
}) {
  return (
    <>
      {problem ? <Alert color="danger" title="Not imported" description={problem} /> : null}
      {report ? (
        <section aria-label="Import report">
          <p role="status">
            {`${report.created} added (${report.published} published, ${report.created - report.published} drafts), ${report.skipped} skipped.`}{" "}
            <a href={`/admin/${segment}`}>See the list</a>
          </p>
          <ul>
            {report.items
              .filter((item) => item.note || item.outcome === "skipped")
              .map((item) => (
                <li key={item.row}>
                  {`${item.name ? `File ${item.name}` : `Row ${item.row}`}${item.title && !item.name ? ` (${item.title})` : ""}: ${item.note ?? ""}`}
                </li>
              ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function ContentList({
  type,
  segment,
  singular,
  entries,
  trashed,
  view,
  canAdd,
  timeZone = null,
}: ContentListProps) {
  const when = useWhen(timeZone);
  const [title, setTitle] = useState("");
  const [editor, setEditor] = useState("layout");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<TrashedEntry | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProblem, setImportProblem] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<ImportReply | null>(null);
  const [markdownFiles, setMarkdownFiles] = useState<File[]>([]);
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ListSort | null>(SORTS[0]!.sort);
  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const e of entries) by[e.status] = (by[e.status] ?? 0) + 1;
    return by;
  }, [entries]);
  const shownEntries = useMemo(() => {
    const words = search.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (filter === "all" || e.status === filter) &&
        (words === "" ||
          e.title.toLowerCase().includes(words) ||
          e.slug.toLowerCase().includes(words)),
    );
  }, [entries, filter, search]);
  const sortKey = SORTS.find(
    (s) => s.sort.column === sort?.column && s.sort.direction === sort?.direction,
  )?.key;

  async function runImport(data: FormData) {
    setImporting(true);
    setImportProblem(null);
    setImportReport(null);
    data.append("type", type);
    try {
      const response = await fetch("/api/admin/import/pages", { method: "POST", body: data });
      const body = (await response.json()) as ImportReply & { error?: { message: string } };
      if (response.ok) setImportReport(body);
      else setImportProblem(body.error?.message ?? "The file could not be imported.");
    } catch {
      setImportProblem("The site could not be reached. Check your connection and try again.");
    }
    setImporting(false);
  }

  async function importCsv() {
    if (!importFile) {
      setImportProblem("Choose a CSV file first.");
      setImportReport(null);
      return;
    }
    const data = new FormData();
    data.append("file", importFile);
    await runImport(data);
  }

  async function importMarkdown() {
    if (markdownFiles.length === 0) {
      setImportProblem("Choose one or more Markdown files first.");
      setImportReport(null);
      return;
    }
    const data = new FormData();
    for (const file of markdownFiles) data.append("files", file);
    await runImport(data);
  }

  /** Restores or deletes one trashed entry, then shows the list again. */
  async function inTrash(entry: TrashedEntry, what: "restore" | "forever") {
    setProblem(null);
    try {
      const response =
        what === "restore"
          ? await fetch(`/api/admin/entries/${entry.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "restore" }),
            })
          : await fetch(`/api/admin/entries/${entry.id}?forever=1`, { method: "DELETE" });
      if (response.ok) {
        window.location.assign(`/admin/${segment}?view=trash`);
        return;
      }
      const body = (await response.json()) as { error?: { message: string } };
      setProblem(body.error?.message ?? "It did not work. Try again.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setDeleting(null);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch("/api/admin/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, title, editor }),
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

  const inTrashView = view === "trash";
  return (
    <>
      <div className="oks-list-head">
        <p className="oks-list-summary">
          {entries.length === 0
            ? `No ${segment} yet.`
            : `${entries.length} ${entries.length === 1 ? singular : segment}: ${
                FILTERS.filter((f) => counts[f.key])
                  .map((f) => `${counts[f.key]} ${f.label.toLowerCase()}`)
                  .join(", ") || "none shown"
              }.`}
        </p>
        {canAdd && !inTrashView ? (
          <div className="oks-list-actions">
            <Button onPress={() => setImportOpen(true)}>Import</Button>
            <Button color="primary" onPress={() => setAdding(true)}>
              {`New ${singular}`}
            </Button>
          </div>
        ) : null}
      </div>
      <nav className="oks-list-tabs" aria-label={`${segment} views`}>
        <button
          type="button"
          className="oks-list-tab"
          aria-pressed={!inTrashView && filter === "all"}
          onClick={() =>
            inTrashView ? window.location.assign(`/admin/${segment}`) : setFilter("all")
          }
        >
          All <span>{entries.length}</span>
        </button>
        {FILTERS.filter((f) => f.key !== "pending" || counts["pending"]).map((f) => (
          <button
            key={f.key}
            type="button"
            className="oks-list-tab"
            aria-pressed={!inTrashView && filter === f.key}
            onClick={() =>
              inTrashView ? window.location.assign(`/admin/${segment}`) : setFilter(f.key)
            }
          >
            {f.label} <span>{counts[f.key] ?? 0}</span>
          </button>
        ))}
        <a href={`/admin/${segment}?view=trash`} aria-current={inTrashView ? "page" : undefined}>
          Trash <span>{trashed.length}</span>
        </a>
      </nav>
      {inTrashView ? null : (
        <div className="oks-list-tools">
          <input
            type="search"
            aria-label={`Search ${segment}`}
            placeholder={`Search ${segment}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label={`Sort ${segment}`}
            value={sortKey ?? ""}
            onChange={(event) =>
              setSort(SORTS.find((s) => s.key === event.target.value)?.sort ?? null)
            }
          >
            {sortKey ? null : <option value="">Sorted by a column</option>}
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <Modal
        isOpen={importOpen && canAdd && !inTrashView}
        onClose={() => setImportOpen(false)}
        title={`Import ${segment}`}
      >
        <div className="oks-imports">
          <details>
            <summary style={{ minBlockSize: "24px", lineHeight: "24px" }}>
              Import from a CSV file
            </summary>
            <p>
              The first row names the columns. Use <code>title</code> (needed), and if you like{" "}
              <code>slug</code>, <code>type</code> (page or post), <code>status</code> (draft or
              published) and <code>content</code> (a blank line starts a new paragraph). A row that
              asks to be published is checked first: if it has no content or a picture with no
              description, it is kept as a draft and the report says why.
            </p>
            <p>
              <label htmlFor="import-file">CSV file</label>
              <br />
              <input
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
              />
            </p>
            <p>
              <Button onPress={() => void importCsv()} isDisabled={importing}>
                Import the file
              </Button>
            </p>
            <ImportOutcome problem={importProblem} report={importReport} segment={segment} />
          </details>
          <details>
            <summary style={{ minBlockSize: "24px", lineHeight: "24px" }}>
              Import from Markdown files
            </summary>
            <p>
              One file is one {singular}. A block of lines between two <code>---</code> lines at the
              top may give <code>title</code>, <code>slug</code>, <code>type</code> and{" "}
              <code>status</code>; without a title, the first heading or the file name is used.
              Headings, lists, quotes, code, pictures, bold, italic and links are kept. Pictures are
              not downloaded, and a picture with no description keeps a {singular} from going live.
            </p>
            <p>
              <label htmlFor="import-md">Markdown files</label>
              <br />
              <input
                id="import-md"
                type="file"
                multiple
                accept=".md,.markdown,text/markdown"
                onChange={(event) => setMarkdownFiles(Array.from(event.target.files ?? []))}
              />
            </p>
            <p>
              <Button onPress={() => void importMarkdown()} isDisabled={importing}>
                Import the files
              </Button>
            </p>
            <ImportOutcome problem={importProblem} report={importReport} segment={segment} />
          </details>
        </div>
      </Modal>
      {problem && inTrashView ? (
        <Alert color="danger" title="Not done" description={problem} />
      ) : null}
      {inTrashView ? (
        trashed.length === 0 ? (
          <p>The trash is empty.</p>
        ) : (
          <>
            <p>Things in the trash are deleted for good after 30 days.</p>
            <ListTable
              label={`${segment} in the trash`}
              rows={trashed.map((e) => ({ ...e, deleted: when(e.trashedAt) }))}
              getRowKey={(row) => row.id}
              columns={[
                { key: "title", header: "Title", sortable: true },
                {
                  key: "deleted",
                  header: "Deleted",
                  sortValue: (row) => row.trashedAt,
                  sortable: true,
                },
                {
                  key: "daysLeft",
                  header: "Days left",
                  sortable: true,
                  render: (row) => `${row.daysLeft}`,
                },
                {
                  key: "actions",
                  header: "Actions",
                  render: (row) => (
                    <>
                      <Button size="sm" onPress={() => void inTrash(row, "restore")}>
                        Restore
                      </Button>{" "}
                      <Button size="sm" color="danger" onPress={() => setDeleting(row)}>
                        Delete forever
                      </Button>
                    </>
                  ),
                },
              ]}
            />
          </>
        )
      ) : null}
      <Modal
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        role="alertdialog"
        title="Delete for good?"
        actions={
          <>
            <Button onPress={() => setDeleting(null)}>Cancel</Button>
            <Button color="danger" onPress={() => deleting && void inTrash(deleting, "forever")}>
              Delete forever
            </Button>
          </>
        }
      >
        <p>{deleting?.title} and its earlier copies will be removed. This cannot be undone.</p>
      </Modal>
      <Modal
        isOpen={adding && canAdd && !inTrashView}
        onClose={() => setAdding(false)}
        title={`New ${singular}`}
      >
        <form onSubmit={add} aria-label={`Add a ${singular}`}>
          {problem ? <Alert color="danger" title="Not added" description={problem} /> : null}
          <TextField
            name="title"
            label={`Title of the new ${singular}`}
            required
            value={title}
            onChange={setTitle}
          />
          {type === "page" ? (
            <p>
              <label>
                Start in{" "}
                <select value={editor} onChange={(e) => setEditor(e.target.value)}>
                  <option value="layout">Layout editor (sections, columns, buttons)</option>
                  <option value="writing">Writing editor (words and pictures)</option>
                </select>
              </label>
            </p>
          ) : null}
          <Button type="submit" color="primary" isDisabled={busy}>
            Add new
          </Button>
        </form>
      </Modal>
      {inTrashView ? null : entries.length === 0 ? (
        <p>Nothing here yet.</p>
      ) : (
        <ListTable
          label={segment}
          rows={shownEntries.map((e) => ({ ...e, updated: when(e.updatedAt) }))}
          getRowKey={(row) => row.id}
          sort={sort}
          onSortChange={setSort}
          columns={[
            {
              key: "title",
              header: "Title",
              sortable: true,
              render: (row) => (
                <>
                  <a className="oks-list-title" href={`/admin/${segment}/${row.id}`}>
                    {row.title}
                  </a>
                  <span className="oks-list-path">{`/${row.slug}`}</span>
                </>
              ),
            },
            {
              key: "status",
              header: "Status",
              sortable: true,
              render: (row) => (
                <span className="oks-chip" data-status={row.status}>
                  {STATUS_WORDS[row.status] ?? row.status}
                </span>
              ),
            },
            {
              key: "authorName",
              header: "Author",
              sortable: true,
              render: (row) => (
                <span className="oks-person">
                  <span className="oks-person-mark" aria-hidden="true">
                    {(row.authorName || "?").charAt(0).toUpperCase()}
                  </span>
                  {row.authorName}
                </span>
              ),
            },
            {
              key: "updated",
              header: "Changed",
              sortValue: (row) => row.updatedAt,
              sortable: true,
            },
          ]}
        />
      )}
      {!inTrashView && entries.length > 0 && shownEntries.length === 0 ? (
        <p role="status">{`No ${segment} match that.`}</p>
      ) : null}
    </>
  );
}
