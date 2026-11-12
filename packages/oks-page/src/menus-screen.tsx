"use client";
// The menus screen: pick the header or footer menu, add pages, categories and links, move items around, and save the
// whole menu at once. A save from an old version is refused by the server and the person is told.
import type { MenuChoices, MenuItem, MenuView } from "@oks-page/core";
import { Alert, Button, TextField } from "oks-ui";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  addItem,
  canIndent,
  canMoveDown,
  canMoveUp,
  canOutdent,
  countItems,
  indent,
  moveDown,
  moveUp,
  outdent,
  removeItem,
  rename,
} from "./menu-tree";

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

export function MenusScreen({
  places,
  menu,
  choices,
}: {
  places: { key: string; label: string }[];
  menu: MenuView;
  choices: MenuChoices;
}) {
  const [items, setItems] = useState<MenuItem[]>(menu.items);
  const [version, setVersion] = useState(menu.updatedAt);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<{ text: string; conflict: boolean } | null>(null);
  const [adding, setAdding] = useState("entry");
  const [entryId, setEntryId] = useState("");
  const [termId, setTermId] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [addProblem, setAddProblem] = useState("");

  // Leaving with changes that were not saved asks first.
  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [dirty]);

  const entryById = useMemo(() => new Map(choices.entries.map((e) => [e.id, e])), [choices]);
  const termById = useMemo(() => new Map(choices.terms.map((t) => [t.id, t])), [choices]);

  const edit = (next: MenuItem[]) => {
    setItems(next);
    setDirty(true);
    setNote("");
  };

  const aim = (item: MenuItem): string => {
    if (item.kind === "entry") {
      const entry = entryById.get(item.entryId ?? "");
      return entry
        ? `${entry.type === "post" ? "Post" : "Page"}: /${entry.slug}`
        : "A page that is not published (it is left out of the site)";
    }
    if (item.kind === "term") {
      const term = termById.get(item.termId ?? "");
      return term ? `${term.kind === "tag" ? "Tag" : "Category"}: ${term.name}` : "A missing item";
    }
    return `Link: ${item.url ?? ""}`;
  };

  function add(event: FormEvent) {
    event.preventDefault();
    setAddProblem("");
    if (countItems(items) >= 100) return setAddProblem("A menu may have at most 100 items.");
    if (adding === "entry") {
      const entry = entryById.get(entryId);
      if (!entry) return setAddProblem("Choose a page or post first.");
      edit(
        addItem(items, {
          id: newId(),
          label: entry.title,
          kind: "entry",
          entryId: entry.id,
          children: [],
        }),
      );
    } else if (adding === "term") {
      const term = termById.get(termId);
      if (!term) return setAddProblem("Choose a category or tag first.");
      edit(
        addItem(items, {
          id: newId(),
          label: term.name,
          kind: "term",
          termId: term.id,
          children: [],
        }),
      );
    } else {
      if (!linkLabel.trim()) return setAddProblem("Give the link a label.");
      if (!/^(\/(?!\/)\S*|https?:\/\/\S+|mailto:\S+|tel:[+0-9 ()-]+)$/i.test(linkUrl.trim()))
        return setAddProblem("The address must start with /, https://, http://, mailto: or tel:.");
      edit(
        addItem(items, {
          id: newId(),
          label: linkLabel.trim(),
          kind: "url",
          url: linkUrl.trim(),
          children: [],
        }),
      );
      setLinkLabel("");
      setLinkUrl("");
    }
  }

  async function save() {
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch(`/api/admin/menus/${menu.place}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, updatedAt: version }),
      });
      const body = (await response.json().catch(() => null)) as {
        updatedAt?: number;
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setNote("");
        setProblem({
          text: body?.error?.message ?? "It could not be saved.",
          conflict: response.status === 409,
        });
        return;
      }
      setVersion(body?.updatedAt ?? version);
      setDirty(false);
      setNote("Menu saved.");
    } catch {
      setNote("");
      setProblem({ text: "The site could not be reached. Try again.", conflict: false });
    }
  }

  const list = (level: MenuItem[], depth: number) => (
    <ul style={{ listStyle: "none", paddingInlineStart: depth === 1 ? 0 : "1.5rem" }}>
      {level.map((item) => (
        <li key={item.id}>
          <p>
            <input
              type="text"
              aria-label="Label"
              value={item.label}
              maxLength={80}
              onChange={(event) => edit(rename(items, item.id, event.target.value))}
            />{" "}
            <small>{aim(item)}</small>
          </p>
          <p>
            <Button
              size="sm"
              aria-label={`Move up: ${item.label}`}
              isDisabled={!canMoveUp(items, item.id)}
              onPress={() => edit(moveUp(items, item.id))}
            >
              Up
            </Button>{" "}
            <Button
              size="sm"
              aria-label={`Move down: ${item.label}`}
              isDisabled={!canMoveDown(items, item.id)}
              onPress={() => edit(moveDown(items, item.id))}
            >
              Down
            </Button>{" "}
            <Button
              size="sm"
              aria-label={`Make a sub-item: ${item.label}`}
              isDisabled={!canIndent(items, item.id)}
              onPress={() => edit(indent(items, item.id))}
            >
              Make sub-item
            </Button>{" "}
            <Button
              size="sm"
              aria-label={`Move out: ${item.label}`}
              isDisabled={!canOutdent(items, item.id)}
              onPress={() => edit(outdent(items, item.id))}
            >
              Move out
            </Button>{" "}
            <Button
              size="sm"
              color="danger"
              aria-label={`Remove: ${item.label}`}
              onPress={() => edit(removeItem(items, item.id))}
            >
              Remove
            </Button>
          </p>
          {item.children.length > 0 ? list(item.children, depth + 1) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <nav aria-label="Menus">
        {places.map((p, i) => (
          <span key={p.key}>
            {i > 0 ? " | " : null}
            <a
              href={`/admin/menus?place=${p.key}`}
              {...(p.key === menu.place ? { "aria-current": "page" as const } : {})}
            >
              {p.label}
            </a>
          </span>
        ))}
      </nav>
      <h2>{menu.label}</h2>
      {problem ? <Alert color="danger" title="Not saved" description={problem.text} /> : null}
      {problem?.conflict ? (
        <p>
          <Button onPress={() => window.location.reload()}>Reload the menu</Button>
        </p>
      ) : null}
      <form aria-label="Add an item" onSubmit={add}>
        <p>
          <label htmlFor="menu-add-kind">Add </label>
          <select id="menu-add-kind" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="entry">A page or post</option>
            <option value="term">A category or tag</option>
            <option value="url">A link</option>
          </select>
        </p>
        {adding === "entry" ? (
          <p>
            <label htmlFor="menu-add-entry">Page or post </label>
            <select
              id="menu-add-entry"
              value={entryId}
              onChange={(e) => setEntryId(e.target.value)}
            >
              <option value="">Choose…</option>
              {choices.entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.type === "post" ? "Post" : "Page"}: {e.title}
                </option>
              ))}
            </select>
          </p>
        ) : null}
        {adding === "term" ? (
          <p>
            <label htmlFor="menu-add-term">Category or tag </label>
            <select id="menu-add-term" value={termId} onChange={(e) => setTermId(e.target.value)}>
              <option value="">Choose…</option>
              {choices.terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind === "tag" ? "Tag" : "Category"}: {t.name}
                </option>
              ))}
            </select>
          </p>
        ) : null}
        {adding === "url" ? (
          <>
            <TextField
              name="link-label"
              label="Label of the link"
              value={linkLabel}
              onChange={setLinkLabel}
            />
            <TextField
              name="link-url"
              label="Address of the link"
              description="Starts with /, https://, http://, mailto: or tel:"
              value={linkUrl}
              onChange={setLinkUrl}
            />
          </>
        ) : null}
        {addProblem ? <Alert color="danger" title="Not added" description={addProblem} /> : null}
        <p>
          <Button type="submit">Add to menu</Button>
        </p>
      </form>
      {items.length === 0 ? <p>This menu is empty.</p> : list(items, 1)}
      <p>
        <Button color="primary" onPress={() => void save()} isDisabled={!dirty}>
          Save menu
        </Button>
      </p>
      <p role="status">{note}</p>
    </>
  );
}
