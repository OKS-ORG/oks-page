// The comments under a post: the approved ones, and a form (it works without script: it posts to /api/comments).
// Shown only while Settings > Comments is on. Every text is drawn as text, never as HTML.
import { getComments } from "@data";

export async function CommentsSection({ entryId, slug }: { entryId: string; slug: string }) {
  const { enabled, comments } = await getComments(entryId);
  if (!enabled) return null;
  return (
    <section id="comments" aria-labelledby="comments-heading">
      <h2 id="comments-heading">Comments{comments.length > 0 ? ` (${comments.length})` : ""}</h2>
      {comments.length === 0 ? <p>No comments yet.</p> : null}
      {comments.map((c) => (
        <article key={c.id} aria-label={`Comment by ${c.name}`}>
          <p>
            <strong>{c.name}</strong> ·{" "}
            <time dateTime={c.createdAt}>{c.createdAt.slice(0, 10)}</time>
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{c.content}</p>
        </article>
      ))}
      <form method="post" action="/api/comments" aria-label="Leave a comment">
        <h3>Leave a comment</h3>
        <input type="hidden" name="entryId" value={entryId} />
        <input type="hidden" name="back" value={`/${slug}`} />
        {/* A robot fills every box it finds; a person never sees this one. */}
        <div aria-hidden="true" style={{ position: "absolute", insetInlineStart: "-10000px" }}>
          <label>
            Leave this empty
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <p>
          <label>
            Name
            <br />
            <input name="name" required maxLength={80} autoComplete="name" />
          </label>
        </p>
        <p>
          <label>
            Comment
            <br />
            <textarea
              name="content"
              required
              maxLength={2000}
              rows={5}
              style={{ inlineSize: "100%", maxInlineSize: "40rem" }}
            />
          </label>
        </p>
        <p>
          <small>
            Your comment shows after someone has looked at it. Your email is not asked for.
          </small>
        </p>
        <button type="submit">Send comment</button>
      </form>
    </section>
  );
}
