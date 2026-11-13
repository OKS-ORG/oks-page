export interface EntryView {
  id: string;
  title: string;
  slug: string;
  type: string;
  html: string;
  plainText: string;
  updatedAt: number;
  /** When it was first published. */
  publishedAt: number;
  /** The author's name (empty when unknown). */
  authorName: string;
  /** What search results and link previews say: the one written in the SEO box, or one made from the text. */
  description: string;
  /** True when the page asks search engines not to list it. */
  noindex: boolean;
  /** The address of the first picture in the page (a library file), or null: the picture of a link preview. */
  image: string | null;
}

/** What every page needs to know about the site: its name and its tagline. */
export interface SiteInfo {
  siteName: string;
  tagline: string;
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
