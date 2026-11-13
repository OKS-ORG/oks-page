"use client";
// The "Search engines" box on the edit screen: the description that search results and link previews show, and a switch to ask
// search engines not to list the page. It saves on its own button, so it does not make a new copy of the text.
import { Alert, Button } from "oks-ui";
import { useEffect, useState, type FormEvent } from "react";

const MAX = 300;
const ROW: React.CSSProperties = { margin: "0.75rem 0" };

export function EntrySeoPanel({ id }: { id: string }) {
  const [description, setDescription] = useState("");
  const [noindex, setNoindex] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/admin/entries/${id}/seo`)
      .then((r) => r.json())
      .then(
        (body: {
          seo?: { description: string; noindex: boolean };
          error?: { message: string };
        }) => {
          if (!live) return;
          if (!body.seo) {
            setProblem(body.error?.message ?? "The search engine settings could not be loaded.");
            return;
          }
          setDescription(body.seo.description);
          setNoindex(body.seo.noindex);
          setLoaded(true);
        },
      )
      .catch(() => live && setProblem("The search engine settings could not be loaded."));
    return () => {
      live = false;
    };
  }, [id]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch(`/api/admin/entries/${id}/seo`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description, noindex }),
      });
      const body = (await response.json().catch(() => null)) as {
        seo?: { description: string; noindex: boolean };
        error?: { message?: string };
      } | null;
      if (!response.ok || !body?.seo)
        throw new Error(body?.error?.message ?? "It could not be saved.");
      setDescription(body.seo.description);
      setNoindex(body.seo.noindex);
      setNote("Search engine settings saved.");
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  const length = Array.from(description).length;
  const hint =
    length === 0
      ? "Empty: a description is made from the first words of the page."
      : length < 70
        ? `${length} characters. 70 to 160 works well in search results.`
        : length <= 160
          ? `${length} characters. That is a good length.`
          : `${length} characters. Search results may cut it after about 160.`;

  if (!loaded && !problem) return <p role="status">Loading the search engine settings…</p>;
  return (
    <form aria-labelledby="seo-heading" onSubmit={(event) => void save(event)}>
      <h2 id="seo-heading">Search engines</h2>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      {loaded ? (
        <>
          <div style={ROW}>
            <label htmlFor="seo-description">
              Description for search results and link previews
            </label>
            <br />
            <textarea
              id="seo-description"
              rows={3}
              maxLength={MAX}
              aria-describedby="seo-description-hint"
              style={{ width: "100%", maxWidth: "40rem", paddingInline: "0.5rem" }}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <p id="seo-description-hint">{hint}</p>
          </div>
          <div style={ROW}>
            <label>
              <input
                type="checkbox"
                checked={noindex}
                onChange={(event) => setNoindex(event.target.checked)}
              />{" "}
              Ask search engines not to list this page
            </label>
            <p>
              The page stays on the site. It also leaves the sitemap, the site search and the feeds.
            </p>
          </div>
          <p>
            <Button type="submit">Update search engine settings</Button>
          </p>
        </>
      ) : null}
      <p role="status">{note}</p>
    </form>
  );
}
