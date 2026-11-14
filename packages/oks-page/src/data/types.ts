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
  /** The layout the page chose in its settings ("" for its usual one). */
  layout: string;
}

/** What every page needs to know about the site: its name, its tagline and its language. */
export interface SiteInfo {
  siteName: string;
  tagline: string;
  /** The language of the site's content ("en", "ar"…), Settings > Languages. */
  lang: string;
  dir: "ltr" | "rtl";
  /** The site icon (Settings > General), or null. */
  icon: { url: string; type: string } | null;
}

/** A post in a list of the newest posts. */
export interface PostSummary {
  title: string;
  slug: string;
  publishedAt: number;
  excerpt: string;
}

/** The look as the public pages use it: the theme's CSS file, the owner's CSS, and the logo if there is one. */
export interface Look {
  /** The address of the CSS file of the theme in use (fonts, design values, the theme's CSS), or null. */
  themeCssUrl: string | null;
  css: string;
  logo: { url: string; width: number | null; height: number | null; alt: string } | null;
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
