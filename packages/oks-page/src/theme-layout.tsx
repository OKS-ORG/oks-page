// A public page drawn from a layout of the theme in use (spec 05, section 7). Ordinary content in the layout was written
// to HTML by the core's block writer; the site blocks are drawn here with live data: the site title and logo, menus,
// the page's title and content, post details, the newest posts, a search form, breadcrumbs, sections, and parts
// (headers and footers). The limits of the theme checker are kept here too, so even a changed row cannot loop or grow.
import { getLatestPosts, getLook, getSiteInfo, getSiteMenu } from "@data";
import {
  MAX_EXPANDED_BLOCKS,
  MAX_PART_DEPTH,
  type DrawNode,
  type FeedItem,
  type PublicMenuItem,
} from "@oks-page/core";
import type { ReactNode } from "react";
import { LINK, LookStyles, MenuList } from "./public-frame";

/** What the layout needs to know about the page it draws. */
export interface ThemedPageInfo {
  /** The page's main heading. */
  title: string;
  /** The page's own content (the entry's text, a list of posts, search results). */
  content: ReactNode;
  /** For a post: when it was published and by whom. */
  meta: { publishedAt: number; authorName: string } | null;
  /** True on the front page (no breadcrumbs there). */
  isFront: boolean;
  /** The static export marks the content for its search index. */
  pagefind?: boolean;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * Hiding a block on some screens (spec 06, PB-97), with the default breakpoints: phone up to 767 px, tablet 768 to
 * 1024 px, desktop from 1025 px. Mobile-first with min-width only (spec 06, section 4): a later rule wins, so a block
 * hidden on phone and tablet shows again from 1025 px. The wrapper takes no room of its own (display: contents).
 */
export const HIDE_CSS =
  ".oks-hide{display:contents}.oks-hide-phone{display:none}" +
  "@media (min-width:768px){.oks-hide-phone{display:contents}.oks-hide-tablet{display:none}}" +
  "@media (min-width:1025px){.oks-hide-tablet{display:contents}.oks-hide-desktop{display:none}}";
const SCREEN_WORDS: Record<string, string> = {
  phone: "phone",
  tablet: "tablet",
  desktop: "desktop",
};
const hiddenWords = (hide: string[]): string =>
  `Hidden on ${hide.map((s) => SCREEN_WORDS[s] ?? s).join(" and ")}`;
const SECTION_TAGS = new Set(["section", "header", "footer", "main", "aside", "nav", "div"]);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const text = (value: unknown, most: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, most) : null;
const placeOf = (props: Record<string, unknown>): string =>
  typeof props["place"] === "string" && NAME.test(props["place"]) ? props["place"] : "primary";
const MENU_LABELS: Record<string, string> = { primary: "Main menu", footer: "Footer menu" };
/** What the editor's preview shows for a block that draws nothing. */
const EMPTY_LABELS: Record<string, string> = {
  "site-logo": "Logo",
  menu: "Menu",
  "post-meta": "Date and author",
  "query-loop": "Latest posts",
  breadcrumbs: "Breadcrumbs",
  "post-featured-image": "Featured picture",
  pagination: "Page numbers",
  part: "Header or footer",
};

/** The menu places and whether a list of posts is used, so the data is read once before drawing. */
function needs(nodes: DrawNode[], parts: Record<string, DrawNode[]>) {
  const places = new Set<string>();
  let posts = false;
  let seen = 0;
  const walk = (list: DrawNode[], depth: number) => {
    for (const node of list) {
      if (node.kind !== "site" || ++seen > MAX_EXPANDED_BLOCKS) continue;
      if (node.type === "menu") places.add(placeOf(node.props));
      if (node.type === "query-loop") posts = true;
      if (node.type === "section") walk(node.children, depth);
      if (node.type === "part" && depth < MAX_PART_DEPTH) {
        const name = node.props["name"];
        if (typeof name === "string" && Object.hasOwn(parts, name)) walk(parts[name]!, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return { places: [...places], posts };
}

export async function ThemedPage({
  layout,
  parts,
  page,
  before,
  editor = false,
}: {
  layout: DrawNode[];
  parts: Record<string, DrawNode[]>;
  page: ThemedPageInfo;
  /** Drawn before the layout (the preview notice). */
  before?: ReactNode;
  /**
   * The site editor's preview: every block is wrapped in an element that carries its id, so a click can select it, and
   * a block that shows nothing here (no logo yet, an empty menu) shows its name instead.
   */
  editor?: boolean;
}) {
  const wanted = needs(layout, parts);
  const [site, look, latest, ...menuLists] = await Promise.all([
    getSiteInfo(),
    getLook(),
    wanted.posts ? getLatestPosts() : Promise.resolve([] as FeedItem[]),
    ...wanted.places.map((place) => getSiteMenu(place)),
  ]);
  const menus = new Map<string, PublicMenuItem[]>(
    wanted.places.map((place, i) => [place, menuLists[i] as PublicMenuItem[]]),
  );

  let left = MAX_EXPANDED_BLOCKS;
  let searchForms = 0;
  let hiding = false;
  const draw = (nodes: DrawNode[], depth: number, stack: string[]): ReactNode[] =>
    nodes.map((node, i) => {
      let drawn = drawNode(node, i, depth, stack);
      const hide = node.hide ?? [];
      if (!editor || !node.id) {
        if (hide.length === 0 || drawn === null) return drawn;
        hiding = true;
        return (
          <div key={i} className={["oks-hide", ...hide.map((s) => `oks-hide-${s}`)].join(" ")}>
            {drawn}
          </div>
        );
      }
      if (drawn === null && node.kind === "site")
        drawn = (
          <p className="oks-editor-empty">{`${EMPTY_LABELS[node.type] ?? node.type} (nothing to show here)`}</p>
        );
      // In the editor a hidden block stays in place, faded at the sizes it is hidden on, so it can still be selected.
      return (
        <div
          key={i}
          data-oks-block={node.id}
          className={["oks-editor-block", ...hide.map((s) => `oks-editor-hidden-${s}`)].join(" ")}
          {...(hide.length > 0 ? { title: hiddenWords(hide) } : {})}
        >
          {drawn}
        </div>
      );
    });
  const drawNode = (node: DrawNode, i: number, depth: number, stack: string[]): ReactNode => {
    if (--left < 0) return null;
    if (node.kind === "html")
      return <div key={i} className="oks-blocks" dangerouslySetInnerHTML={{ __html: node.html }} />;
    const props = node.props;
    switch (node.type) {
      case "site-title":
        return (
          <p key={i} className="oks-site-title">
            <a href="/" style={LINK}>
              {site.siteName}
            </a>
          </p>
        );
      case "site-logo":
        return look.logo ? (
          <a key={i} href="/" className="oks-site-logo" style={LINK}>
            <img
              src={look.logo.url}
              alt={look.logo.alt}
              {...(look.logo.width && look.logo.height
                ? { width: look.logo.width, height: look.logo.height }
                : {})}
              style={{ maxBlockSize: "4rem", inlineSize: "auto" }}
            />
          </a>
        ) : null;
      case "menu": {
        const place = placeOf(props);
        const items = menus.get(place) ?? [];
        if (items.length === 0) return null;
        const label = text(props["label"], 60) ?? MENU_LABELS[place] ?? `Menu: ${place}`;
        return (
          <nav key={i} aria-label={label} className={`oks-menu oks-menu-${place}`}>
            <MenuList items={items} />
          </nav>
        );
      }
      case "post-title":
        return (
          <h1 key={i} className="oks-title">
            {page.title}
          </h1>
        );
      case "post-content":
        return (
          <div
            key={i}
            className="oks-content"
            {...(page.pagefind ? { "data-pagefind-body": "" } : {})}
          >
            {page.content}
          </div>
        );
      case "post-meta":
        return page.meta ? (
          <p key={i} className="oks-post-meta">
            <time dateTime={day(page.meta.publishedAt)}>{day(page.meta.publishedAt)}</time>
            {page.meta.authorName ? ` · ${page.meta.authorName}` : null}
          </p>
        ) : null;
      case "query-loop": {
        const count = Number(props["count"]);
        const shown = latest.slice(
          0,
          Number.isInteger(count) && count >= 1 && count <= 20 ? count : 5,
        );
        if (shown.length === 0) return null;
        return (
          <ul key={i} className="oks-latest-posts">
            {shown.map((post) => (
              <li key={post.path}>
                <a href={post.path}>{post.title}</a>{" "}
                <time dateTime={day(post.publishedAt)}>{day(post.publishedAt)}</time>
              </li>
            ))}
          </ul>
        );
      }
      case "search-form": {
        const id = `oks-search-${++searchForms}`;
        return (
          <form key={i} role="search" action="/search" method="get" className="oks-search-form">
            <label htmlFor={id}>Search this site</label>{" "}
            <input id={id} type="search" name="q" maxLength={200} />{" "}
            <button type="submit">Search</button>
          </form>
        );
      }
      case "breadcrumbs":
        return page.isFront ? null : (
          <nav key={i} aria-label="Breadcrumb" className="oks-breadcrumbs">
            <ol>
              <li>
                <a href="/">Home</a>
              </li>
              <li aria-current="page">{page.title}</li>
            </ol>
          </nav>
        );
      case "section": {
        const tag =
          typeof props["tag"] === "string" && SECTION_TAGS.has(props["tag"]) ? props["tag"] : "div";
        const name =
          typeof props["name"] === "string" && NAME.test(props["name"]) ? props["name"] : null;
        const Tag = tag as "div";
        return (
          <Tag key={i} className={name ? `oks-section oks-section-${name}` : "oks-section"}>
            {draw(node.children, depth, stack)}
          </Tag>
        );
      }
      case "part": {
        const name = props["name"];
        if (
          typeof name !== "string" ||
          !Object.hasOwn(parts, name) ||
          stack.includes(name) ||
          depth >= MAX_PART_DEPTH
        )
          return null;
        return (
          <div key={i} className={`oks-part oks-part-${name}`} style={{ display: "contents" }}>
            {draw(parts[name]!, depth + 1, [...stack, name])}
          </div>
        );
      }
      default:
        // Pagination and featured pictures are not drawn yet; unknown site blocks are kept as data and not drawn.
        return null;
    }
  };

  const drawn = draw(layout, 0, []);
  return (
    <>
      <LookStyles look={look} />
      {hiding ? <style dangerouslySetInnerHTML={{ __html: HIDE_CSS }} /> : null}
      {before}
      {drawn}
    </>
  );
}
