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
    <section aria-labelledby="types-heading">
      <h2 id="types-heading">Content types</h2>
      <p>
        Pages and posts are built in. Make your own kinds of content here, such as a product, an
        event or a team member, and choose the fields each one has. Each type gets its own list in
        the Content menu.
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p style={{ minBlockSize: "1.5rem" }} role="status">
        {note}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Address</th>
            <th scope="col">Fields</th>
            <th scope="col">Entries</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => (
            <tr key={t.key}>
              <th scope="row">
                {t.label}
                {t.builtIn ? " (built in)" : ""}
              </th>
              <td>
                <code>/{t.urlPrefix}…</code>
              </td>
              <td>{t.fields.length}</td>
              <td>{t.entryCount}</td>
              <td>
                {t.builtIn ? null : (
                  <Button onPress={() => edit(t)} aria-label={`Change ${t.label}`}>
                    Change
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft ? null : (
        <p>
          <Button onPress={() => setDraft(blank())}>Add a content type</Button>
        </p>
      )}
      {draft ? (
        <form
          aria-label={draft.isNew ? "New content type" : `Change ${draft.label}`}
          onSubmit={(event) => void save(event)}
        >
          <h3>{draft.isNew ? "New content type" : `Change ${draft.label}`}</h3>
          <p>
            <label>
              Name
              <br />
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
          </p>
          <p>
            <label>
              Key (cannot change later)
              <br />
              <input
                value={draft.key}
                disabled={!draft.isNew}
                onChange={(event) => setDraft({ ...draft, key: event.target.value })}
              />
            </label>
          </p>
          <p>
            <label>
              Address prefix
              <br />
              <input
                value={draft.urlPrefix}
                placeholder="shop/"
                disabled={draft.entryCount > 0}
                onChange={(event) => setDraft({ ...draft, urlPrefix: event.target.value })}
              />
            </label>
            <br />
            <small>
              {draft.entryCount > 0
                ? "It cannot change while the type has entries."
                : 'A page of this type has an address like "/shop/red-shoe". Leave it empty for "/red-shoe".'}
            </small>
          </p>
          <fieldset>
            <legend>
              <strong>Fields</strong>
            </legend>
            {draft.fields.map((f, index) => (
              <div key={index} role="group" aria-label={`Field ${index + 1}`}>
                <label>
                  Field name
                  <input
                    value={f.label}
                    onChange={(event) =>
                      setField(index, {
                        label: event.target.value,
                        ...(f.key === "" || f.key === keyOf(f.label)
                          ? { key: keyOf(event.target.value) }
                          : {}),
                      })
                    }
                  />
                </label>{" "}
                <label>
                  Field key
                  <input
                    value={f.key}
                    onChange={(event) => setField(index, { key: event.target.value })}
                  />
                </label>{" "}
                <label>
                  Kind
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
                </label>{" "}
                <label>
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(event) => setField(index, { required: event.target.checked })}
                  />{" "}
                  Required
                </label>{" "}
                <label>
                  <input
                    type="checkbox"
                    checked={f.sortable}
                    disabled={f.type === "long text" || f.type === "picture"}
                    onChange={(event) => setField(index, { sortable: event.target.checked })}
                  />{" "}
                  Fast to sort by
                </label>{" "}
                <label>
                  <input
                    type="checkbox"
                    checked={f.filterable}
                    disabled={f.type === "long text" || f.type === "picture"}
                    onChange={(event) => setField(index, { filterable: event.target.checked })}
                  />{" "}
                  Fast to search by
                </label>{" "}
                <Button
                  onPress={() =>
                    setDraft({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })
                  }
                  aria-label={`Remove field ${index + 1}`}
                >
                  Remove
                </Button>
              </div>
            ))}
            <p>
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
            </p>
          </fieldset>
          <p>
            <Button type="submit">Save content type</Button>{" "}
            <Button onPress={() => setDraft(null)}>Cancel</Button>{" "}
            {draft.isNew ? null : (
              <Button
                color="danger"
                isDisabled={draft.entryCount > 0}
                onPress={() => void remove(draft.key)}
              >
                Delete this type
              </Button>
            )}
          </p>
          {!draft.isNew && draft.entryCount > 0 ? (
            <p>
              <small>
                A type with entries cannot be deleted. Move its entries to the trash and empty it
                first.
              </small>
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

const byLabel = (a: ContentTypeInfo, b: ContentTypeInfo) => a.label.localeCompare(b.label);
