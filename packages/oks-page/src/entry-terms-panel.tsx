"use client";
// The "Categories and tags" box on a post's edit screen. It saves on its own button: choosing them does not make a
// new copy of the text.
import { Alert, Button, TextField } from "oks-ui";
import { useEffect, useState, type FormEvent } from "react";

interface Category {
  id: string;
  name: string;
  parentId: string | null;
}

/** The categories in tree order, each with its depth. */
function inTreeOrder(all: Category[]): { category: Category; depth: number }[] {
  const out: { category: Category; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of all.filter(
      (x) => (x.parentId && all.some((p) => p.id === x.parentId) ? x.parentId : null) === parent,
    )) {
      out.push({ category: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function EntryTermsPanel({ id }: { id: string }) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/admin/entries/${id}/terms`)
      .then((r) => r.json())
      .then(
        (body: {
          categories?: Category[];
          selected?: { categoryIds: string[]; tags: string[] };
          error?: { message: string };
        }) => {
          if (!live) return;
          if (!body.categories || !body.selected) {
            setProblem(body.error?.message ?? "The categories could not be loaded.");
            return;
          }
          setCategories(body.categories);
          setChosen(body.selected.categoryIds);
          setTags(body.selected.tags.join(", "));
        },
      )
      .catch(() => live && setProblem("The categories could not be loaded."));
    return () => {
      live = false;
    };
  }, [id]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch(`/api/admin/entries/${id}/terms`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          categoryIds: chosen,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        categoryIds?: string[];
        tags?: string[];
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? "It could not be saved.");
      setChosen(body?.categoryIds ?? chosen);
      setTags((body?.tags ?? []).join(", "));
      setNote("Categories and tags saved.");
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  if (!categories && !problem) return <p role="status">Loading categories and tags…</p>;
  return (
    <form aria-labelledby="terms-heading" onSubmit={(event) => void save(event)}>
      <h2 id="terms-heading">Categories and tags</h2>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      {categories ? (
        <>
          <fieldset>
            <legend>Categories</legend>
            {inTreeOrder(categories).map(({ category, depth }) => (
              <p key={category.id} style={{ marginInlineStart: `${depth * 1.25}rem` }}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.includes(category.id)}
                    onChange={(event) =>
                      setChosen((now) =>
                        event.target.checked
                          ? [...now, category.id]
                          : now.filter((c) => c !== category.id),
                      )
                    }
                  />{" "}
                  {category.name}
                </label>
              </p>
            ))}
          </fieldset>
          <TextField
            name="tags"
            label="Tags (separated by commas)"
            value={tags}
            onChange={setTags}
          />
          <p>
            <Button type="submit">Save categories and tags</Button>
          </p>
        </>
      ) : null}
      <p role="status">{note}</p>
    </form>
  );
}
