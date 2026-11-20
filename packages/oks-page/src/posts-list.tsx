// The list of the newest posts: what the home page shows when it shows your latest posts, and what the posts page shows
// (Settings > Reading). Each post with its date and a short summary. Used by the server and the export build alike.
import type { PostSummary } from "./data/types";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function PostsList({
  posts,
  empty = "There are no posts yet.",
}: {
  posts: PostSummary[];
  empty?: string;
}) {
  if (posts.length === 0) return <p>{empty}</p>;
  return (
    <ul className="oks-posts-list">
      {posts.map((post) => (
        <li key={post.slug}>
          <h2>
            <a href={`/${post.slug}`}>{post.title}</a>
          </h2>
          <p>
            <time dateTime={day(post.publishedAt)}>{day(post.publishedAt)}</time>
          </p>
          {post.excerpt ? <p>{post.excerpt}</p> : null}
        </li>
      ))}
    </ul>
  );
}
