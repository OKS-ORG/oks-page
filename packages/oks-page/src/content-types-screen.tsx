"use client";
// Settings > Content types: make your own kinds of content (a product, an event, a team member) with the fields each
// one needs. Page and Post are built in and only listed. A type with entries cannot be deleted or change its address.
import type { ContentTypeInfo, FieldDef } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

const TYPES: { value: FieldDef["type"]; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "long text", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "true / false", label: "Yes or no" },
  { value: "date", label: "Date" },
  { value: "picture", label: "Picture" },
  { value: "relation", label: "Link to another type" },
];

const keyOf = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 40);

interface Draft {
  key: string;
  isNew: boolean;
  label: string;
  urlPrefix: string;
  fields: FieldDef[];
  entryCount: number;
}

const blank = (): Draft => ({
  key: "",
  isNew: true,
  label: "",
  urlPrefix: "",
  fields: [],
  entryCount: 0,
});

export function ContentTypesScreen({ initial }: { initial: ContentTypeInfo[] }) {
  const [types, setTypes] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const edit = (t: ContentTypeInfo) =>
    setDraft({
      key: t.key,
      isNew: false,
      label: t.label,
      urlPrefix: t.urlPrefix,
      fields: t.fields,
      entryCount: t.entryCount,
    });

  const setField = (index: number, change: Partial<FieldDef>) =>
    setDraft((d) =>
      d ? { ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...change } : f)) } : d,
    );

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/content-types", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: draft.key,
        label: draft.label,
        urlPrefix: draft.urlPrefix,
        fields: draft.fields,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      type?: ContentTypeInfo;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.type) {
      setNote("");
      setProblem(body?.error?.message ?? "The content type could not be saved.");
      return;
    }
    const saved = body.type;
    setTypes((all) => [...all.filter((t) => t.key !== saved.key), saved].sort(byLabel));
    setDraft(null);
    setNote(`"${saved.label}" is saved.`);
  }

  async function remove(key: string) {
    setProblem(null);
    const response = await fetch(`/api/admin/content-types?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      setProblem(body?.error?.message ?? "The content type could not be deleted.");
      return;
    }
    setTypes((all) => all.filter((t) => t.key !== key));
    setDraft(null);
    setNote("The content type is deleted.");
  }

  return (
    <section aria-labelledby="types-heading" className="oks-bare">
      <h2 id="types-heading" className="oks-sr-only">
        Content types
      </h2>
      <div className="oks-list-head">
        <p className="oks-list-summary">
          Kinds of content beyond pages and posts, each with its own fields. Each type gets its own
          list in the Content menu.
        </p>
        <div className="oks-list-actions">
          <Button
            color="primary"
            onPress={() => {
              setProblem(null);
              setNote("");
              setDraft(blank());
            }}
          >
            New content type
          </Button>
        </div>
      </div>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p className="oks-status-line" role="status">
        {note}
      </p>
      <div className="oks-types">
        <ul className="oks-type-list" aria-label="Content types">
          {types.map((t) => {
            const line = `${t.entryCount} ${t.entryCount === 1 ? "entry" : "entries"} · /${t.urlPrefix}…`;
            const inside = (
              <>
                <span>
                  <span className="oks-list-title">{t.label}</span>
                  <span className="oks-list-path">{line}</span>
                </span>
                <span className="oks-chip" data-status={t.builtIn ? "scheduled" : "published"}>
                  {t.builtIn ? "Built in" : `${t.fields.length} fields`}
                </span>
              </>
            );
            return (
              <li key={t.key}>
                {t.builtIn ? (
                  <div className="oks-type-row">{inside}</div>
                ) : (
                  <button
                    type="button"
                    className="oks-type-row"
                    aria-label={`Change ${t.label}`}
                    aria-current={draft?.key === t.key && !draft.isNew ? "true" : undefined}
                    onClick={() => edit(t)}
                  >
                    {inside}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {draft ? (
          <form
            className="oks-type-form"
            aria-label={draft.isNew ? "New content type" : `Change ${draft.label}`}
            onSubmit={(event) => void save(event)}
          >
            <h3>{draft.isNew ? "New content type" : `Change ${draft.label}`}</h3>
            <div className="oks-type-basics">
              <label className="oks-field-block">
                <span>Name</span>
                <input
                  value={draft.label}
                  maxLength={80}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      label: event.target.value,
                      ...(draft.isNew ? { key: keyOf(event.target.value) } : {}),
                    })
                  }
                />
              </label>
              <label className="oks-field-block">
                <span>Key (cannot change later)</span>
                <input
                  value={draft.key}
                  disabled={!draft.isNew}
                  onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                />
              </label>
              <label className="oks-field-block">
                <span>Address prefix</span>
                <input
                  value={draft.urlPrefix}
                  placeholder="shop/"
                  disabled={draft.entryCount > 0}
                  aria-describedby="type-prefix-help"
                  onChange={(event) => setDraft({ ...draft, urlPrefix: event.target.value })}
                />
              </label>
              <p id="type-prefix-help" className="oks-list-path">
                {draft.entryCount > 0
                  ? "The address cannot change while the type has entries."
                  : 'A page of this type has an address like "/shop/red-shoe". Leave it empty for "/red-shoe".'}
              </p>
            </div>
            <div className="oks-type-fields-head">
              <h4>Fields</h4>
              <Button
                onPress={() =>
                  setDraft({
                    ...draft,
                    fields: [
                      ...draft.fields,
                      {
                        key: "",
                        label: "",
                        type: "text",
                        required: false,
                        sortable: false,
                        filterable: false,
                      },
                    ],
                  })
                }
              >
                Add a field
              </Button>
            </div>
            {draft.fields.length > 0 ? (
              <div className="oks-field-head" aria-hidden="true">
                <span>Field</span>
                <span>Type</span>
                <span>Required</span>
                <span>Sort by it</span>
                <span>Filter by it</span>
                <span />
              </div>
            ) : (
              <p className="oks-list-path">No fields yet.</p>
            )}
            {draft.fields.map((f, index) => (
              <div
                key={index}
                className="oks-field-row"
                role="group"
                aria-label={`Field ${index + 1}`}
              >
                <div className="oks-field-names">
                  <label>
                    <span className="oks-sr-only">Field name</span>
                    <input
                      value={f.label}
                      placeholder="Field name"
                      onChange={(event) =>
                        setField(index, {
                          label: event.target.value,
                          ...(f.key === "" || f.key === keyOf(f.label)
                            ? { key: keyOf(event.target.value) }
                            : {}),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span className="oks-sr-only">Field key</span>
                    <input
                      value={f.key}
                      placeholder="Field key"
                      onChange={(event) => setField(index, { key: event.target.value })}
                    />
                  </label>
                </div>
                <div className="oks-field-names">
                  <label>
                    <span className="oks-sr-only">Kind</span>
                    <select
                      value={f.type}
                      onChange={(event) =>
                        setField(index, { type: event.target.value as FieldDef["type"] })
                      }
                    >
                      {TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {f.type === "relation" ? (
                    <label>
                      <span className="oks-sr-only">Links to</span>
                      <select
                        value={f.target ?? ""}
                        onChange={(event) => setField(index, { target: event.target.value })}
                      >
                        <option value="">Links to: choose a type…</option>
                        {[
                          ...types.map((t) => ({ key: t.key, label: t.label })),
                          ...(draft.isNew && draft.key && draft.label
                            ? [{ key: draft.key, label: `${draft.label} (this type)` }]
                            : []),
                        ].map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
                <label className="oks-field-tick">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(event) => setField(index, { required: event.target.checked })}
                  />
                  <span>Required</span>
                </label>
                <label className="oks-field-tick">
                  <input
                    type="checkbox"
                    checked={f.sortable}
                    disabled={
                      f.type === "long text" || f.type === "picture" || f.type === "relation"
                    }
                    onChange={(event) => setField(index, { sortable: event.target.checked })}
                  />
                  <span>Fast to sort by</span>
                </label>
                <label className="oks-field-tick">
                  <input
                    type="checkbox"
                    checked={f.filterable}
                    disabled={f.type === "long text" || f.type === "picture"}
                    onChange={(event) => setField(index, { filterable: event.target.checked })}
                  />
                  <span>Fast to search by</span>
                </label>
                <Button
                  size="sm"
                  onPress={() =>
                    setDraft({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })
                  }
                  aria-label={`Remove field ${index + 1}`}
                >
                  Remove
                </Button>
              </div>
            ))}
            <p className="oks-list-path">
              A field that sorts or filters gets a fast index by itself.
            </p>
            <div className="oks-detail-actions">
              <Button type="submit" color="primary">
                Save content type
              </Button>
              <Button onPress={() => setDraft(null)}>Cancel</Button>
              {draft.isNew ? null : (
                <Button
                  color="danger"
                  isDisabled={draft.entryCount > 0}
                  onPress={() => void remove(draft.key)}
                >
                  Delete this type
                </Button>
              )}
            </div>
            {!draft.isNew && draft.entryCount > 0 ? (
              <p className="oks-list-path">
                A type with entries cannot be deleted. Move its entries to the trash and empty it
                first.
              </p>
            ) : null}
          </form>
        ) : (
          <p className="oks-type-form oks-list-path">
            Choose a type on the left to change it, or make a new one.
          </p>
        )}
      </div>
    </section>
  );
}

const byLabel = (a: ContentTypeInfo, b: ContentTypeInfo) => a.label.localeCompare(b.label);
