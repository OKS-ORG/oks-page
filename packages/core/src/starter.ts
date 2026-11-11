// The built-in content types and the sample content of the setup wizard's last step ("Add sample content?").
import { newId } from "@oks-page/db";

export interface BuiltInType {
  key: string;
  label: string;
  /** The address rule (spec 08, section 4). Pages sit at the top; posts under /blog. */
  urlRule: string;
  hierarchical: boolean;
}

export const BUILT_IN_TYPES: BuiltInType[] = [
  { key: "page", label: "Page", urlRule: "/{slug}", hierarchical: true },
  { key: "post", label: "Post", urlRule: "/blog/{slug}", hierarchical: false },
];

export interface StarterEntry {
  type: "page" | "post";
  title: string;
  /** The whole address path, as the site reads it today ("home" is the front page). */
  slug: string;
  paragraphs: string[];
}

export const STARTER_ENTRIES: StarterEntry[] = [
  {
    type: "page",
    title: "Home",
    slug: "home",
    paragraphs: ["This is your home page. Edit it to say what your site is about."],
  },
  {
    type: "page",
    title: "About",
    slug: "about",
    paragraphs: ["Tell visitors who you are and what you do."],
  },
  {
    type: "page",
    title: "Contact",
    slug: "contact",
    paragraphs: ["Say how people can reach you."],
  },
  {
    type: "post",
    title: "Hello world",
    slug: "blog/hello-world",
    paragraphs: ["This is your first post. Edit or delete it, then start writing."],
  },
];

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The stored forms of an entry's text: the blocks (as the editor keeps them), the page HTML and the search text. */
export function starterBody(entry: StarterEntry): {
  body: string;
  html: string;
  plainText: string;
} {
  const blocks = entry.paragraphs.map((text) => ({
    id: newId(),
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  }));
  return {
    body: JSON.stringify({ version: 1, blocks }),
    html: entry.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join(""),
    plainText: entry.paragraphs.join("\n"),
  };
}
