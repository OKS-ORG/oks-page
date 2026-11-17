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

/** One page of the list of the newest posts. */
export interface PostsPage {
  posts: PostSummary[];
  /** The page asked for (from 1). */
  page: number;
  /** How many pages the whole list has (at least 1). */
  pages: number;
  /** How many posts the whole list has. */
  total: number;
}

/** The look as the public pages use it: the theme's CSS file, the owner's CSS, and the logo if there is one. */
export interface Look {
  /** The address of the CSS file of the theme in use (fonts, design values, the theme's CSS), or null. */
  themeCssUrl: string | null;
  /** The owner's CSS as text, for a page that cannot link to a file (the export build). */
  css: string;
  /** The owner's CSS as a file (`/site-style/<fingerprint>.css`), or null when it is written into the page. */
  cssUrl: string | null;
  /** Whether the page may link to style files (`/site-style/...`): the server build yes, the export build no. */
  styleFiles: boolean;
  logo: { url: string; width: number | null; height: number | null; alt: string } | null;
  /** Light only, dark only, or the visitor's device decides; and whether visitors get a switch. */
  colorMode: "light" | "dark" | "system";
  modeSwitch: boolean;
}

/** A category or tag archive: the posts that carry the term (for a category, also those in the categories under it). */
export interface TermArchive {
  id: string;
  /** "category" or "tag". */
  kind: string;
  name: string;
  slug: string;
  description: string;
  /** The posts of the page asked for, newest first. */
  posts: { title: string; slug: string; publishedAt: number }[];
  /** The page asked for (from 1). */
  page: number;
  /** How many pages the archive has (at least 1). */
  pages: number;
  /** How many posts the archive has. */
  total: number;
}
