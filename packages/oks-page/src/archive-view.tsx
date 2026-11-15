// A category or tag archive: its name, its description and the posts in it, newest first. Used by the server build
// and the export build, so both write the same page.
import type { TermArchive } from "./data/types";
import { Pager } from "./pager";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const archiveTitle = (archive: TermArchive) =>
  `${archive.kind === "category" ? "Category" : "Tag"}: ${archive.name}`;

export function ArchiveView({ archive }: { archive: TermArchive }) {
  return (
    <main>
      <h1>{archiveTitle(archive)}</h1>
      <ArchiveContent archive={archive} />
    </main>
  );
}

/** The archive without its heading: what a theme's layout shows as the page's content. */
export function ArchiveContent({ archive }: { archive: TermArchive }) {
  return (
    <>
      {archive.description ? <p>{archive.description}</p> : null}
      {archive.posts.length === 0 ? (
        <p>There are no posts here yet.</p>
      ) : (
        <ul>
          {archive.posts.map((post) => (
            <li key={post.slug}>
              <a href={`/${post.slug}`}>{post.title}</a>{" "}
              <time dateTime={day(post.publishedAt)}>{day(post.publishedAt)}</time>
            </li>
          ))}
        </ul>
      )}
      <Pager base={`${archive.kind}/${archive.slug}`} page={archive.page} pages={archive.pages} />
    </>
  );
}
