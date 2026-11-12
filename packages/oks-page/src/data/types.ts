export interface EntryView {
  id: string;
  title: string;
  slug: string;
  type: string;
  html: string;
  plainText: string;
  updatedAt: number;
}

/** A category or tag archive: the posts that carry the term (for a category, also those in the categories under it). */
export interface TermArchive {
  id: string;
  /** "category" or "tag". */
  kind: string;
  name: string;
  slug: string;
  description: string;
  posts: { title: string; slug: string; publishedAt: number }[];
  /** True when there are more posts than the list shows. */
  more: boolean;
}
