// /search?q=...: the site's search page. Not indexed by search engines; results are never cached.
import { getSiteMenu, getThemeLayouts } from "@data";
import { extractOf, layoutCandidates, pickLayout, search } from "@oks-page/core";
import type { Metadata } from "next";
import { connection } from "next/server";
import { PublicFrame } from "./public-frame";
import { ThemedPage } from "./theme-layout";
import { getSearchIndex } from "./search-index";

export const metadata: Metadata = { title: "Search", robots: { index: false, follow: true } };

const PER_PAGE = 10;
const MOST_QUERY = 200;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Props = { searchParams: Promise<{ q?: string; page?: string; exact?: string }> };

const href = (q: string, page: number, exact: boolean) =>
  `/search?q=${encodeURIComponent(q)}${exact ? "&exact=1" : ""}${page > 1 ? `&page=${page}` : ""}`;

export default async function SearchPage({ searchParams }: Props) {
  await connection();
  const params = await searchParams;
  const q = (typeof params.q === "string" ? params.q : "").slice(0, MOST_QUERY);
  const exact = params.exact === "1";
  const asked = Number.parseInt(typeof params.page === "string" ? params.page : "1", 10);
  const searched = q.trim().length > 0;
  const result = searched ? search(await getSearchIndex(), q, exact) : null;
  const total = result?.hits.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), pages) : 1;
  const shown = result?.hits.slice((page - 1) * PER_PAGE, page * PER_PAGE) ?? [];
  const usedWords = result?.corrected ?? result?.words ?? [];

  const body = (
    <>
      <form role="search" action="/search" method="get">
        <label htmlFor="search-q">Search this site</label>{" "}
        <input id="search-q" type="search" name="q" defaultValue={q} maxLength={MOST_QUERY} />{" "}
        <button type="submit">Search</button>
      </form>
      {!searched ? (
        <p>Type a word or two to find pages and posts.</p>
      ) : total === 0 ? (
        <div>
          <p>
            No results for <strong>{q}</strong>.
          </p>
          <ul>
            <li>Check the spelling, or try fewer words.</li>
            <li>Try a more general word, for example “bread” instead of “sourdough loaf”.</li>
          </ul>
        </div>
      ) : (
        <>
          {result?.corrected ? (
            <p>
              Showing results for <strong>{result.corrected.join(" ")}</strong>.{" "}
              <a href={href(q, 1, true)}>Search for {q} instead</a>
            </p>
          ) : null}
          <p aria-live="polite">{`${total} ${total === 1 ? "result" : "results"}`}</p>
          <ol>
            {shown.map((hit) => (
              <li key={hit.row.id}>
                <h2>
                  <a href={`/${hit.row.slug}`}>{hit.row.title}</a>
                </h2>
                <p>
                  <small>
                    {hit.row.type === "post" ? "Post" : "Page"} ·{" "}
                    <time dateTime={day(hit.row.publishedAt)}>{day(hit.row.publishedAt)}</time>
                  </small>
                </p>
                <p>
                  {extractOf(hit.row.text, usedWords).map((segment, i) =>
                    segment.mark ? <mark key={i}>{segment.text}</mark> : segment.text,
                  )}
                </p>
              </li>
            ))}
          </ol>
          {pages > 1 ? (
            <nav aria-label="Search pages">
              {page > 1 ? <a href={href(q, page - 1, exact)}>Previous</a> : null}
              {page > 1 && page < pages ? " | " : null}
              {page < pages ? <a href={href(q, page + 1, exact)}>Next</a> : null}{" "}
              <span>{`Page ${page} of ${pages}`}</span>
            </nav>
          ) : null}
        </>
      )}
    </>
  );
  const layouts = await getThemeLayouts();
  const layout = pickLayout(layouts, layoutCandidates({ kind: "search" }));
  if (layout && layouts)
    return (
      <ThemedPage
        layout={layout}
        parts={layouts.parts}
        page={{ title: "Search", content: body, meta: null, isFront: false }}
      />
    );
  const [header, footer] = await Promise.all([getSiteMenu("primary"), getSiteMenu("footer")]);
  return (
    <PublicFrame header={header} footer={footer}>
      <main>
        <h1>Search</h1>
        {body}
      </main>
    </PublicFrame>
  );
}
