"use client";
// The site editor (spec 05, section 17.5). On the left: the layouts and the outline of the open one. In the middle: the
// real site with the changes, where a click selects a block. On the right: what can be done with the selected block.
// Every change is kept as a draft on the server a moment after it is made; Publish shows all changed layouts at once.
import { EntryEditor } from "@oks-page/admin";
import type {
  LayoutDetail,
  LayoutInfo,
  LayoutUsage,
  LayoutVersion,
  SavedSectionDetail,
  SavedSectionInfo,
  SectionPlace,
} from "@oks-page/core";
import { Alert, Button, Modal } from "oks-ui";
import type { Block } from "oks-ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  allIds,
  blockLabel,
  copyWithNewIds,
  duplicateBlock,
  findBlock,
  hiddenScreens,
  hiddenWords,
  insertBlocks,
  isContentBlock,
  layoutTitle,
  moveBlock,
  newBlockId,
  removeBlock,
  replaceBlock,
  setHidden,
  setProps,
  SCREEN_SIZES,
  type LayoutBlock,
} from "./layout-tree";
import { uploadForEditor } from "./media-client";
import { formatWhen } from "./time-format";

export interface PreviewPage {
  value: string;
  label: string;
  type: string;
  slug: string;
}

interface Props {
  themeId: string;
  themeName: string;
  initialLayouts: LayoutInfo[];
  pages: PreviewPage[];
  /** The theme's headers, footers and other shared parts, by name. */
  parts: string[];
  /** The theme's ready-made sections, in library order, which are added as copies. */
  sections: { name: string; title: string; blocks: unknown[]; group: string }[];
  /** The site's saved sections ("My sections"), with how many places link to each. */
  initialSaved: SavedSection[];
  /** The groups a saved section can be in, with their names. */
  sectionGroups: { value: string; label: string }[];
}

export type SavedSection = SavedSectionInfo & { places: number };
const SECTION_KEY = "sections/";
const LINKED = "linked-section";

/** "Published 2 layouts and 1 saved section." */
function publishedWords(layouts: number, sections: number): string {
  const l = `${layouts} ${layouts === 1 ? "layout" : "layouts"}`;
  const s = `${sections} saved ${sections === 1 ? "section" : "sections"}`;
  const what = layouts > 0 && sections > 0 ? `${l} and ${s}` : sections > 0 ? s : l;
  return `Published ${what}. Your site shows the changes now.`;
}
const placesWords = (n: number) =>
  n === 0 ? "not linked anywhere yet" : n === 1 ? "linked in 1 place" : `linked in ${n} places`;

/** The preview sizes, each drawn at its real width and scaled down to fit (spec 06, section 4.1 breakpoints). */
const PREVIEW_SIZES = [
  { value: "desktop", label: "Desktop", width: 1280 },
  { value: "tablet", label: "Tablet", width: 820 },
  { value: "phone", label: "Phone", width: 390 },
] as const;
type PreviewSize = (typeof PREVIEW_SIZES)[number]["value"];
const SCREEN_LABELS = { phone: "Phone", tablet: "Tablet", desktop: "Desktop" } as const;
/** The section library's pictures: a section drawn 1280 px wide, shown at a quarter of its size. */
const PICTURE_WIDTH = 1280;
const PICTURE_SCALE = 0.25;

const SAVE_AFTER_MS = 700;
const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

const STATE_WORDS: Record<LayoutInfo["state"], string> = {
  theme: "The theme's",
  owner: "Your changes",
  "owner-outdated": "The theme changed this",
};

/** The blocks that can be added, with plain names. */
const ADDABLE: { value: string; label: string; make: () => Omit<LayoutBlock, "id"> }[] = [
  {
    value: "paragraph",
    label: "Text",
    make: () => ({
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "New text" }],
      children: [],
    }),
  },
  {
    value: "heading",
    label: "Heading",
    make: () => ({
      type: "heading",
      props: { level: 2 },
      content: [{ type: "text", text: "New heading" }],
      children: [],
    }),
  },
  {
    value: "section",
    label: "Group (holds other blocks)",
    make: () => ({ type: "section", props: { tag: "div" }, content: null, children: [] }),
  },
  {
    value: "site-title",
    label: "Site name",
    make: () => ({ type: "site-title", props: {}, content: null, children: [] }),
  },
  {
    value: "site-logo",
    label: "Logo",
    make: () => ({ type: "site-logo", props: {}, content: null, children: [] }),
  },
  {
    value: "menu",
    label: "Menu",
    make: () => ({ type: "menu", props: { place: "primary" }, content: null, children: [] }),
  },
  {
    value: "post-title",
    label: "Page title",
    make: () => ({ type: "post-title", props: {}, content: null, children: [] }),
  },
  {
    value: "post-content",
    label: "Page content",
    make: () => ({ type: "post-content", props: {}, content: null, children: [] }),
  },
  {
    value: "post-meta",
    label: "Date and author",
    make: () => ({ type: "post-meta", props: {}, content: null, children: [] }),
  },
  {
    value: "query-loop",
    label: "Latest posts",
    make: () => ({ type: "query-loop", props: { count: 5 }, content: null, children: [] }),
  },
  {
    value: "search-form",
    label: "Search box",
    make: () => ({ type: "search-form", props: {}, content: null, children: [] }),
  },
  {
    value: "breadcrumbs",
    label: "Breadcrumbs",
    make: () => ({ type: "breadcrumbs", props: {}, content: null, children: [] }),
  },
];
const SECTION_TAGS: [string, string][] = [
  ["div", "Group"],
  ["header", "Top area"],
  ["main", "Main area"],
  ["footer", "Bottom area"],
  ["aside", "Side area"],
  ["nav", "Navigation area"],
  ["section", "Section"],
];

/** The page that best shows a layout in the preview. */
function defaultPage(key: string, pages: PreviewPage[]): string {
  const name = key.split("/")[1] ?? "";
  const first = (test: (p: PreviewPage) => boolean) => pages.find(test)?.value;
  if (key.startsWith("parts/") || name === "front-page")
    return first((p) => p.slug === "home") ?? pages[0]!.value;
  if (name === "search") return "search";
  if (["archive", "category", "tag"].includes(name))
    return first((p) => p.type === "archive") ?? pages[0]!.value;
  if (name.startsWith("page"))
    return first((p) => p.type === "page" && p.slug !== "home") ?? pages[0]!.value;
  if (name.startsWith("single")) {
    const type = name.startsWith("single-") ? name.slice(7).split("-")[0]! : "post";
    return first((p) => p.type === type) ?? first((p) => p.type === "post") ?? pages[0]!.value;
  }
  return first((p) => p.type === "post") ?? first((p) => p.slug === "home") ?? pages[0]!.value;
}

/** "This changes all 24 posts and 3 pages." with the real numbers. */
function usageWords(key: string, title: string, usage: LayoutUsage | null): string {
  if (!usage) return "";
  const parts: string[] = [];
  for (const [type, n] of Object.entries(usage.entries)) {
    const word =
      type === "post"
        ? n === 1
          ? "post"
          : "posts"
        : type === "page"
          ? n === 1
            ? "page"
            : "pages"
          : type;
    parts.push(`${n === 1 ? "1" : `all ${n}`} ${word}`);
  }
  if (usage.archives) parts.push("the category and tag pages");
  if (usage.search) parts.push("the search page");
  const where =
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
  if (key.startsWith(SECTION_KEY))
    return parts.length > 0
      ? `Changes here show on every page where "${title}" is linked: this changes ${where}.`
      : `"${title}" is not linked on any published page yet.`;
  if (key.startsWith("parts/"))
    return parts.length > 0
      ? `The ${title} shows on every page that uses it: this changes ${where}.`
      : `The ${title} is not used by any page yet.`;
  return parts.length > 0
    ? `You are changing the ${title} layout. This changes ${where}.`
    : `You are changing the ${title} layout. No published page uses it yet.`;
}

export function SiteEditor({
  themeId,
  themeName,
  initialLayouts,
  pages,
  parts,
  sections,
  initialSaved,
  sectionGroups,
}: Props) {
  const [layouts, setLayouts] = useState(initialLayouts);
  const [saved, setSaved] = useState(initialSaved);
  const [savedPlaces, setSavedPlaces] = useState<SectionPlace[]>([]);
  const [saving2, setSaving2] = useState<{ name: string; group: string; link: boolean } | null>(
    null,
  );
  const [renaming, setRenaming] = useState<{ name: string; group: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [openKey, setOpenKey] = useState(initialLayouts[0]!.key);
  const [detail, setDetail] = useState<LayoutDetail | null>(null);
  const [versions, setVersions] = useState<LayoutVersion[]>([]);
  const [usage, setUsage] = useState<LayoutUsage | null>(null);
  const [blocks, setBlocks] = useState<LayoutBlock[]>([]);
  const [undo, setUndo] = useState<LayoutBlock[][]>([]);
  const [redo, setRedo] = useState<LayoutBlock[][]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(defaultPage(initialLayouts[0]!.key, pages));
  const [token, setToken] = useState(0);
  const [pending, setPending] = useState<LayoutBlock[] | null>(null);
  const [saving, setSaving] = useState<"saved" | "saving" | "error">("saved");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [editingText, setEditingText] = useState<LayoutBlock | null>(null);
  const [adding, setAdding] = useState(ADDABLE[0]!.value);
  const [size, setSize] = useState<PreviewSize>("desktop");
  const [library, setLibrary] = useState(false);
  const [libraryGroup, setLibraryGroup] = useState("all");
  const [box, setBox] = useState({ width: 0, height: 0 });
  const frame = useRef<HTMLIFrameElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const base = `/api/admin/themes/${encodeURIComponent(themeId)}`;
  // A saved section is opened like a layout, with the key "sections/<id>".
  const isSection = openKey.startsWith(SECTION_KEY);
  const savedId = isSection ? openKey.slice(SECTION_KEY.length) : "";
  const savedOpen = isSection ? (saved.find((s) => s.id === savedId) ?? null) : null;
  const open: Pick<LayoutInfo, "key" | "title" | "hasDraft" | "state" | "inTheme"> = savedOpen
    ? {
        key: openKey,
        title: savedOpen.name,
        hasDraft: savedOpen.hasDraft,
        state: "owner",
        inTheme: false,
      }
    : (layouts.find((l) => l.key === openKey) ?? layouts[0]!);
  const title = savedOpen ? savedOpen.name : layoutTitle(open.key, open.title);
  const drafts = layouts.filter((l) => l.hasDraft).length + saved.filter((s) => s.hasDraft).length;
  const sectionUrl = (id: string) => `/api/admin/sections/${encodeURIComponent(id)}`;
  const savedName = (id: unknown) =>
    saved.find((s) => s.id === id)?.name ?? "a section that no longer exists";
  /** The outline's and the tools' name of a block; a linked section is named after its saved section. */
  const labelOf = (b: LayoutBlock) =>
    b.type === LINKED ? `Linked section: ${savedName(b.props["id"])}` : blockLabel(b);

  const refreshList = useCallback(async () => {
    const [response, savedResponse] = await Promise.all([
      fetch(`${base}/layouts`),
      fetch("/api/admin/sections"),
    ]);
    const body = (await response.json().catch(() => null)) as { layouts?: LayoutInfo[] } | null;
    if (response.ok && body?.layouts) setLayouts(body.layouts);
    const list = (await savedResponse.json().catch(() => null)) as {
      sections?: SavedSection[];
    } | null;
    if (savedResponse.ok && list?.sections) setSaved(list.sections);
  }, [base]);

  // Opens a layout. With `keepBlocks` (after Publish, which does not change the blocks) the work and its undo steps stay.
  const load = useCallback(
    async (key: string, keepBlocks = false) => {
      setRenaming(null);
      setDeleting(false);
      setSaving2(null);
      if (key.startsWith(SECTION_KEY)) {
        const response = await fetch(sectionUrl(key.slice(SECTION_KEY.length)));
        const body = (await response.json().catch(() => null)) as {
          section?: SavedSectionDetail;
          places?: SectionPlace[];
          versions?: LayoutVersion[];
          usage?: LayoutUsage | null;
        } | null;
        if (!response.ok || !body?.section) {
          setProblem(failure(body, "The saved section could not be opened."));
          return;
        }
        setDetail(null);
        setSavedPlaces(body.places ?? []);
        setVersions(body.versions ?? []);
        setUsage(body.usage ?? null);
        if (keepBlocks) return;
        setBlocks((body.section.draft ?? body.section.published) as LayoutBlock[]);
        setUndo([]);
        setRedo([]);
        setSelected(null);
        setComparing(false);
        return;
      }
      const response = await fetch(`${base}/layout?key=${encodeURIComponent(key)}`);
      const body = (await response.json().catch(() => null)) as {
        layout?: LayoutDetail;
        versions?: LayoutVersion[];
        usage?: LayoutUsage | null;
      } | null;
      if (!response.ok || !body?.layout) {
        setProblem(failure(body, "The layout could not be opened."));
        return;
      }
      setDetail(body.layout);
      setVersions(body.versions ?? []);
      setUsage(body.usage ?? null);
      if (keepBlocks) return;
      setBlocks(
        (body.layout.draft ?? body.layout.published ?? body.layout.theme ?? []) as LayoutBlock[],
      );
      setUndo([]);
      setRedo([]);
      setSelected(null);
      setComparing(false);
    },
    [base],
  );

  useEffect(() => {
    void load(openKey);
  }, [load, openKey]);

  // The preview box: the page is drawn at the chosen size's real width and scaled to fit the box.
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [comparing]);
  const previewWidth = PREVIEW_SIZES.find((p) => p.value === size)!.width;
  const scale = box.width > 0 ? Math.min(1, box.width / previewWidth) : 1;

  // A change is kept as a draft a moment after the last one.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      void (async () => {
        setSaving("saving");
        const response = await fetch(
          openKey.startsWith(SECTION_KEY)
            ? sectionUrl(openKey.slice(SECTION_KEY.length))
            : `${base}/layout`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key: openKey, blocks: pending }),
          },
        );
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setSaving("error");
          setProblem(failure(body, "The change could not be kept."));
          return;
        }
        setSaving("saved");
        setProblem(null);
        setPending(null);
        setToken((t) => t + 1);
        await refreshList();
      })();
    }, SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending, base, openKey, refreshList]);

  const change = (next: LayoutBlock[]) => {
    setUndo((u) => [...u.slice(-49), blocks]);
    setRedo([]);
    setBlocks(next);
    setPending(next);
    setNote("");
  };
  const stepBack = () => {
    const previous = undo.at(-1);
    if (!previous) return;
    setRedo((r) => [...r, blocks]);
    setUndo((u) => u.slice(0, -1));
    setBlocks(previous);
    setPending(previous);
  };
  const stepForward = () => {
    const next = redo.at(-1);
    if (!next) return;
    setUndo((u) => [...u, blocks]);
    setRedo((r) => r.slice(0, -1));
    setBlocks(next);
    setPending(next);
  };

  async function run(work: () => Promise<string>, keepBlocks = false) {
    setProblem(null);
    setNote("Working…");
    try {
      const done = await work();
      await refreshList();
      await load(openKey, keepBlocks);
      setToken((t) => t + 1);
      setNote(done);
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }
  const post = async (url: string, body: unknown, fallback: string) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(failure(answer, fallback));
    return answer as Record<string, unknown>;
  };

  // The preview: a click selects the nearest block of the open layout; links do not navigate.
  const previewUrl = (use: string) =>
    isSection
      ? `/admin/site-editor/preview?saved=${encodeURIComponent(savedId)}&use=${use}&v=${token}`
      : layoutPreviewUrl(use);
  const layoutPreviewUrl = (use: string) =>
    `/admin/site-editor/preview?theme=${encodeURIComponent(themeId)}&layout=${encodeURIComponent(openKey)}&page=${encodeURIComponent(page)}&use=${use}&v=${token}`;
  const ids = allIds(blocks);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onFrameLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", (event) => {
      event.preventDefault();
      let node = (event.target as Element | null)?.closest("[data-oks-block]") ?? null;
      while (node && !idsRef.current.has(node.getAttribute("data-oks-block") ?? ""))
        node = node.parentElement?.closest("[data-oks-block]") ?? null;
      if (node) setSelected(node.getAttribute("data-oks-block"));
    });
    doc.addEventListener("submit", (event) => event.preventDefault());
    markSelected();
  };
  const markSelected = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    for (const el of doc.querySelectorAll("[data-selected]")) el.removeAttribute("data-selected");
    if (selected)
      doc
        .querySelector(`[data-oks-block="${CSS.escape(selected)}"]`)
        ?.setAttribute("data-selected", "");
  };
  useEffect(markSelected);

  const chosen = selected ? findBlock(blocks, selected) : null;
  const usedIds = (list: LayoutBlock[]) => allIds(list);

  function addSection(name: string) {
    const taken = usedIds(blocks);
    const ready = sections.find((s) => s.name === name);
    const added = (ready?.blocks ?? []).map((b) => copyWithNewIds(b as LayoutBlock, taken));
    setLibrary(false);
    if (added.length === 0) return;
    change(insertBlocks(blocks, selected, added));
    setSelected(added[0]!.id);
    setNote(`Added a copy of "${ready!.title}". Change it as you like.`);
  }

  /** The published blocks of a saved section, as fresh copies with new ids (and the hiding of the place, if any). */
  async function copiesOfSaved(id: string, hide: unknown = undefined): Promise<LayoutBlock[]> {
    const response = await fetch(sectionUrl(id));
    const body = (await response.json().catch(() => null)) as {
      section?: SavedSectionDetail;
    } | null;
    if (!response.ok || !body?.section)
      throw new Error(failure(body, "The saved section could not be read."));
    const taken = usedIds(blocks);
    return (body.section.published as LayoutBlock[]).map((b) => {
      const copy = copyWithNewIds(b, taken);
      if (!Array.isArray(hide) || hide.length === 0) return copy;
      const own = Array.isArray(copy.props["hide"]) ? (copy.props["hide"] as unknown[]) : [];
      return { ...copy, props: { ...copy.props, hide: [...new Set([...own, ...hide])] } };
    });
  }

  async function placeSaved(id: string, how: "copy" | "linked") {
    setLibrary(false);
    const name = savedName(id);
    try {
      const added =
        how === "linked"
          ? [
              {
                id: newBlockId(usedIds(blocks)),
                type: LINKED,
                props: { id },
                content: null,
                children: [],
              },
            ]
          : await copiesOfSaved(id);
      if (added.length === 0) return;
      change(insertBlocks(blocks, selected, added));
      setSelected(added[0]!.id);
      setNote(
        how === "linked"
          ? `Placed "${name}" as a linked section: it is the same everywhere it is linked.`
          : `Added a copy of "${name}". Change it as you like; the saved section stays as it is.`,
      );
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function detach(block: LayoutBlock) {
    try {
      const copies = await copiesOfSaved(String(block.props["id"] ?? ""), block.props["hide"]);
      change(replaceBlock(blocks, block.id, copies));
      setSelected(copies[0]?.id ?? null);
      setNote("Detached: this place has its own copy now. Other places stay linked.");
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function saveAsSection(
    block: LayoutBlock,
    form: { name: string; group: string; link: boolean },
  ) {
    setProblem(null);
    const response = await fetch("/api/admin/sections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: form.name, group: form.group, blocks: [block] }),
    });
    const body = (await response.json().catch(() => null)) as {
      section?: SavedSectionInfo;
    } | null;
    if (!response.ok || !body?.section) {
      setProblem(failure(body, "The section could not be saved."));
      return;
    }
    setSaving2(null);
    if (form.link) {
      const linkedBlock = {
        id: newBlockId(usedIds(blocks)),
        type: LINKED,
        props: { id: body.section.id },
        content: null,
        children: [],
      };
      change(replaceBlock(blocks, block.id, [linkedBlock]));
      setSelected(linkedBlock.id);
    }
    await refreshList();
    setNote(
      `Saved as "${body.section.name}". It is in the library under My sections${form.link ? ", and this place is linked to it" : ""}.`,
    );
  }

  function addBlock() {
    const taken = usedIds(blocks);
    let added: LayoutBlock[];
    if (adding.startsWith("part:")) {
      added = [
        {
          id: newBlockId(taken),
          type: "part",
          props: { name: adding.slice(5) },
          content: null,
          children: [],
        },
      ];
    } else {
      const kind = ADDABLE.find((a) => a.value === adding)!;
      added = [{ id: newBlockId(taken), ...kind.make() }];
    }
    if (added.length === 0) return;
    change(insertBlocks(blocks, selected, added));
    setSelected(added[0]!.id);
  }

  const outline = (list: LayoutBlock[], depth: number): ReactNode => (
    <ul
      className="oks-outline"
      style={{ listStyle: "none", paddingInlineStart: depth ? "1rem" : 0, margin: 0 }}
    >
      {list.map((b) => (
        <li key={b.id}>
          <button
            type="button"
            className="oks-outline-item"
            aria-pressed={b.id === selected}
            onClick={() => setSelected(b.id)}
          >
            {labelOf(b)}
            {hiddenWords(b) ? <small>{` (${hiddenWords(b)})`}</small> : null}
          </button>
          {b.children.length > 0 ? outline(b.children, depth + 1) : null}
        </li>
      ))}
    </ul>
  );

  const groups: [string, LayoutInfo[]][] = [
    ["Page layouts", layouts.filter((l) => l.kind === "template")],
    ["Headers and footers", layouts.filter((l) => l.kind === "part")],
  ];

  return (
    <div className="oks-site-editor">
      <style>{`
.oks-site-editor-narrow{display:none}
.oks-site-editor-grid{display:grid;grid-template-columns:minmax(14rem,18rem) minmax(0,1fr) minmax(15rem,20rem);gap:1rem;align-items:start}
.oks-site-editor-compare iframe{inline-size:100%;block-size:calc(100vh - 16rem);min-block-size:28rem;border:1px solid currentColor;background:#fff}
.oks-site-editor-holder{block-size:calc(100vh - 18rem);min-block-size:28rem;overflow:hidden;border:1px solid currentColor;background:#fff}
.oks-site-editor-holder iframe{display:block;border:0;background:#fff;transform-origin:0 0}
.oks-site-editor-sizes{display:flex;flex-wrap:wrap;gap:.75rem;border:0;padding:0;margin:0 0 .5rem}
.oks-site-editor-compare{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
.oks-library-groups{display:flex;flex-wrap:wrap;gap:.25rem .75rem;border:0;padding:0;margin:0 0 1rem}
.oks-library-list{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:1rem}
.oks-library-list li{border:1px solid currentColor;padding:.5rem;display:flex;flex-direction:column;gap:.5rem}
.oks-library-picture{inline-size:100%;block-size:12rem;overflow:hidden;background:#fff;pointer-events:none}
.oks-library-picture iframe{border:0;transform-origin:0 0}
.oks-outline-item,.oks-layout-item{display:block;inline-size:100%;text-align:start;min-block-size:28px;padding:.2rem .4rem;background:none;border:1px solid transparent;color:inherit;font:inherit;cursor:pointer}
.oks-outline-item[aria-pressed="true"],.oks-layout-item[aria-current="true"]{border-color:currentColor;font-weight:600}
@media (max-width:1100px){.oks-site-editor-grid{grid-template-columns:minmax(13rem,16rem) minmax(0,1fr)}.oks-site-editor-tools{grid-column:1 / -1}}
@media (max-width:767px){.oks-site-editor-grid{display:none}.oks-site-editor-narrow{display:block}}
`}</style>
      <p className="oks-site-editor-narrow">
        The site editor needs a wider screen (a tablet or a computer). On a phone you can still
        choose a theme and change the look and the menus.
      </p>
      <div className="oks-site-editor-grid">
        <div className="oks-site-editor-side">
          <nav aria-label="Layouts" className="oks-site-editor-layouts">
            <p>
              <strong>{themeName}</strong>
            </p>
            <p>
              <Button
                color="primary"
                isDisabled={drafts === 0 || pending !== null}
                onPress={() =>
                  void run(async () => {
                    const answer = await post(
                      `${base}/layouts`,
                      { action: "publish" },
                      "It could not be published.",
                    );
                    return publishedWords(
                      (answer["published"] as string[] | undefined)?.length ?? 0,
                      (answer["sections"] as string[] | undefined)?.length ?? 0,
                    );
                  }, true)
                }
              >
                {drafts > 0 ? `Publish changes (${drafts})` : "Nothing to publish"}
              </Button>
            </p>
            {groups.map(([label, list]) =>
              list.length > 0 ? (
                <div key={label}>
                  <h2 style={{ fontSize: "1rem" }}>{label}</h2>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {list.map((l) => (
                      <li key={l.key}>
                        <button
                          type="button"
                          className="oks-layout-item"
                          aria-current={l.key === openKey}
                          onClick={() => {
                            if (pending) return;
                            setOpenKey(l.key);
                            setPage(defaultPage(l.key, pages));
                          }}
                        >
                          {layoutTitle(l.key, l.title)}
                          <br />
                          <small>
                            {STATE_WORDS[l.state]}
                            {l.hasDraft ? " · draft" : ""}
                            {l.inTheme ? "" : " · no longer in the theme"}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
            {saved.length > 0 ? (
              <div>
                <h2 style={{ fontSize: "1rem" }}>My sections</h2>
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {saved.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="oks-layout-item"
                        aria-current={openKey === `${SECTION_KEY}${s.id}`}
                        onClick={() => {
                          if (pending) return;
                          setOpenKey(`${SECTION_KEY}${s.id}`);
                        }}
                      >
                        {s.name}
                        <br />
                        <small>
                          {placesWords(s.places)}
                          {s.hasDraft ? " · draft" : ""}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </nav>
          <section aria-label={`Outline of ${title}`}>
            <h2 style={{ fontSize: "1rem" }}>{`Outline of ${title}`}</h2>
            {blocks.length === 0 ? (
              <p>{isSection ? "This section is empty." : "This layout is empty."}</p>
            ) : (
              outline(blocks, 0)
            )}
          </section>
        </div>

        <section aria-label="Preview" className="oks-site-editor-preview">
          <p role="note">
            <strong>{usageWords(open.key, title, usage)}</strong> Changing a page changes only that
            page; changing a layout changes every page that uses it.
          </p>
          {detail?.state === "owner-outdated" ? (
            <Alert
              color="warning"
              title="The theme changed this layout since you edited it"
              description={`Your change started from version ${detail.baseVersion || "?"}; the theme is now version ${detail.themeVersion}. Keep yours, use the new one, or compare them first.`}
            />
          ) : null}
          {detail?.state === "owner-outdated" ? (
            <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <Button
                onPress={() =>
                  void run(async () => {
                    await post(
                      `${base}/layout`,
                      { action: "keep-mine", key: openKey },
                      "It could not be kept.",
                    );
                    return "Your layout is kept.";
                  })
                }
              >
                Keep mine
              </Button>
              <Button
                onPress={() =>
                  void run(async () => {
                    await post(
                      `${base}/layout`,
                      { action: "reset", key: openKey },
                      "The new layout could not be used.",
                    );
                    return "The theme's new layout is used now. Your old one is in the history.";
                  })
                }
              >
                Use the new one
              </Button>
              <Button onPress={() => setComparing((c) => !c)}>
                {comparing ? "Stop comparing" : "Compare"}
              </Button>
            </p>
          ) : null}
          <p>
            <label htmlFor="site-editor-page">Show this page in the preview</label>{" "}
            <select
              id="site-editor-page"
              value={page}
              onChange={(e) => setPage(e.target.value)}
              style={{ minBlockSize: "32px" }}
            >
              {pages.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>{" "}
            <span aria-live="polite">
              {pending || saving === "saving"
                ? "Keeping your change…"
                : saving === "error"
                  ? "Not kept"
                  : open.hasDraft
                    ? "Draft kept"
                    : ""}
            </span>
          </p>
          {comparing ? (
            <div className="oks-site-editor-compare">
              <div>
                <h2
                  style={{ fontSize: "1rem" }}
                >{`The theme's new layout (version ${detail?.themeVersion ?? ""})`}</h2>
                <iframe title="The theme's new layout" src={previewUrl("theme")} />
              </div>
              <div>
                <h2 style={{ fontSize: "1rem" }}>Yours</h2>
                <iframe title="Your layout" src={previewUrl("published")} />
              </div>
            </div>
          ) : (
            <>
              <fieldset className="oks-site-editor-sizes">
                <legend>Preview size</legend>
                {PREVIEW_SIZES.map((p) => (
                  <label key={p.value}>
                    <input
                      type="radio"
                      name="site-editor-size"
                      value={p.value}
                      checked={size === p.value}
                      onChange={() => setSize(p.value)}
                    />{" "}
                    {`${p.label} (${p.width} px)`}
                  </label>
                ))}
              </fieldset>
              <div ref={holder} className="oks-site-editor-holder">
                <iframe
                  ref={frame}
                  title="Preview of your site with your changes"
                  src={previewUrl("draft")}
                  onLoad={onFrameLoad}
                  style={{
                    inlineSize: `${previewWidth}px`,
                    blockSize: `${Math.max(box.height, 300) / scale}px`,
                    transform: scale < 1 ? `scale(${scale})` : undefined,
                  }}
                />
              </div>
            </>
          )}
        </section>

        <aside aria-label="Tools" className="oks-site-editor-tools">
          <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            <Button isDisabled={undo.length === 0} onPress={stepBack}>
              Undo
            </Button>
            <Button isDisabled={redo.length === 0} onPress={stepForward}>
              Redo
            </Button>
          </p>
          {chosen ? (
            <section aria-label="Selected block">
              <h2 style={{ fontSize: "1rem" }}>{`Selected: ${labelOf(chosen)}`}</h2>
              {chosen.type === LINKED ? (
                <p className="oks-linked-badge">
                  {`Linked section · ${placesWords(saved.find((s) => s.id === chosen.props["id"])?.places ?? 0)}. It is the same everywhere; change it once with "Edit the linked section".`}
                </p>
              ) : null}
              <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                <Button onPress={() => change(moveBlock(blocks, chosen.id, -1))}>Move up</Button>
                <Button onPress={() => change(moveBlock(blocks, chosen.id, 1))}>Move down</Button>
                <Button
                  onPress={() => {
                    const copied = duplicateBlock(blocks, chosen.id);
                    change(copied.blocks);
                    setSelected(copied.id);
                  }}
                >
                  Duplicate
                </Button>
                <Button
                  color="danger"
                  onPress={() => {
                    change(removeBlock(blocks, chosen.id));
                    setSelected(null);
                  }}
                >
                  Delete
                </Button>
              </p>
              {isContentBlock(chosen) ? (
                <p>
                  <Button onPress={() => setEditingText(chosen)}>Edit the text</Button>
                </p>
              ) : null}
              {chosen.type === LINKED ? (
                <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  <Button
                    isDisabled={pending !== null || !saved.some((s) => s.id === chosen.props["id"])}
                    onPress={() => setOpenKey(`${SECTION_KEY}${String(chosen.props["id"])}`)}
                  >
                    Edit the linked section
                  </Button>
                  <Button onPress={() => void detach(chosen)}>Detach</Button>
                </p>
              ) : saving2 ? (
                <fieldset style={{ border: "1px solid currentColor", padding: "0.5rem" }}>
                  <legend>Save as a section</legend>
                  <p>
                    <label htmlFor="se-save-name">Name</label>
                    <br />
                    <input
                      id="se-save-name"
                      value={saving2.name}
                      maxLength={80}
                      onChange={(e) => setSaving2({ ...saving2, name: e.target.value })}
                      style={{ minBlockSize: "32px", inlineSize: "100%" }}
                    />
                  </p>
                  <p>
                    <label htmlFor="se-save-group">Group</label>
                    <br />
                    <select
                      id="se-save-group"
                      value={saving2.group}
                      onChange={(e) => setSaving2({ ...saving2, group: e.target.value })}
                      style={{ minBlockSize: "32px" }}
                    >
                      {sectionGroups.map((g) => (
                        <option key={g.value} value={g.value}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                  </p>
                  <p>
                    <label>
                      <input
                        type="checkbox"
                        checked={saving2.link}
                        onChange={(e) => setSaving2({ ...saving2, link: e.target.checked })}
                      />{" "}
                      Link this place to the saved section
                    </label>
                  </p>
                  <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    <Button
                      color="primary"
                      isDisabled={saving2.name.trim() === "" || pending !== null}
                      onPress={() => void saveAsSection(chosen, saving2)}
                    >
                      Save the section
                    </Button>
                    <Button onPress={() => setSaving2(null)}>Cancel</Button>
                  </p>
                </fieldset>
              ) : (
                <p>
                  <Button onPress={() => setSaving2({ name: "", group: "other", link: false })}>
                    Save as a section
                  </Button>
                </p>
              )}
              {chosen.type === "menu" ? (
                <p>
                  <label htmlFor="se-menu-place">Which menu</label>
                  <br />
                  <select
                    id="se-menu-place"
                    value={
                      typeof chosen.props["place"] === "string" ? chosen.props["place"] : "primary"
                    }
                    onChange={(e) => change(setProps(blocks, chosen.id, { place: e.target.value }))}
                    style={{ minBlockSize: "32px" }}
                  >
                    <option value="primary">Main menu</option>
                    <option value="footer">Footer menu</option>
                  </select>
                </p>
              ) : null}
              {chosen.type === "query-loop" ? (
                <p>
                  <label htmlFor="se-count">How many posts (1 to 20)</label>
                  <br />
                  <input
                    id="se-count"
                    type="number"
                    min={1}
                    max={20}
                    value={Number(chosen.props["count"]) || 5}
                    onChange={(e) =>
                      change(
                        setProps(blocks, chosen.id, {
                          count: Math.min(20, Math.max(1, Number(e.target.value) || 5)),
                        }),
                      )
                    }
                    style={{ minBlockSize: "32px" }}
                  />
                </p>
              ) : null}
              {chosen.type === "section" ? (
                <p>
                  <label htmlFor="se-section-tag">What this area is</label>
                  <br />
                  <select
                    id="se-section-tag"
                    value={typeof chosen.props["tag"] === "string" ? chosen.props["tag"] : "div"}
                    onChange={(e) => change(setProps(blocks, chosen.id, { tag: e.target.value }))}
                    style={{ minBlockSize: "32px" }}
                  >
                    {SECTION_TAGS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </p>
              ) : null}
              <fieldset style={{ border: 0, padding: 0, margin: "0 0 1rem" }}>
                <legend>Show this block on</legend>
                {SCREEN_SIZES.map((screen) => {
                  const hidden = hiddenScreens(chosen);
                  return (
                    <label key={screen} style={{ marginInlineEnd: "0.75rem" }}>
                      <input
                        type="checkbox"
                        checked={!hidden.includes(screen)}
                        onChange={(e) =>
                          change(
                            setHidden(
                              blocks,
                              chosen.id,
                              e.target.checked
                                ? hidden.filter((s) => s !== screen)
                                : [...hidden, screen],
                            ),
                          )
                        }
                      />{" "}
                      {SCREEN_LABELS[screen]}
                    </label>
                  );
                })}
                {hiddenScreens(chosen).length === 3 ? (
                  <p>Visitors never see this block now. Tick a screen size to show it.</p>
                ) : null}
              </fieldset>
              {chosen.type === "part" && parts.length > 1 ? (
                <p>
                  <label htmlFor="se-part">Which shared part</label>
                  <br />
                  <select
                    id="se-part"
                    value={typeof chosen.props["name"] === "string" ? chosen.props["name"] : ""}
                    onChange={(e) => change(setProps(blocks, chosen.id, { name: e.target.value }))}
                    style={{ minBlockSize: "32px" }}
                  >
                    {parts.map((name) => (
                      <option key={name} value={name}>
                        {layoutTitle(`parts/${name}`, name)}
                      </option>
                    ))}
                  </select>
                </p>
              ) : null}
            </section>
          ) : (
            <p>Click a part of the preview, or a line of the outline, to select it.</p>
          )}

          <section aria-label="Add a block">
            <h2 style={{ fontSize: "1rem" }}>Add</h2>
            <p>
              <label htmlFor="se-add">
                {chosen ? "Add after the selected block" : "Add at the end"}
              </label>
              <br />
              <select
                id="se-add"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                style={{ minBlockSize: "32px", maxInlineSize: "100%" }}
              >
                <optgroup label="Blocks">
                  {ADDABLE.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </optgroup>
                {parts.length > 0 ? (
                  <optgroup label="Headers and footers">
                    {parts.map((name) => (
                      <option key={name} value={`part:${name}`}>
                        {layoutTitle(`parts/${name}`, name)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>{" "}
              <Button onPress={addBlock}>Add</Button>
            </p>
            {sections.length > 0 || saved.length > 0 ? (
              <p>
                <Button onPress={() => setLibrary(true)}>Add a ready-made section</Button>
              </p>
            ) : null}
          </section>

          {isSection && savedOpen ? (
            <section aria-label="This saved section">
              <h2 style={{ fontSize: "1rem" }}>This saved section</h2>
              <p>
                {`"${savedOpen.name}" is ${placesWords(savedPlaces.length)}. Changes stay a draft until you publish; then every place shows them.`}
              </p>
              {renaming ? (
                <fieldset style={{ border: "1px solid currentColor", padding: "0.5rem" }}>
                  <legend>Name and group</legend>
                  <p>
                    <label htmlFor="se-rename">Name</label>
                    <br />
                    <input
                      id="se-rename"
                      value={renaming.name}
                      maxLength={80}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                      style={{ minBlockSize: "32px", inlineSize: "100%" }}
                    />
                  </p>
                  <p>
                    <label htmlFor="se-regroup">Group</label>
                    <br />
                    <select
                      id="se-regroup"
                      value={renaming.group}
                      onChange={(e) => setRenaming({ ...renaming, group: e.target.value })}
                      style={{ minBlockSize: "32px" }}
                    >
                      {sectionGroups.map((g) => (
                        <option key={g.value} value={g.value}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                  </p>
                  <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    <Button
                      color="primary"
                      onPress={() =>
                        void run(async () => {
                          const response = await fetch(sectionUrl(savedId), {
                            method: "PATCH",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify(renaming),
                          });
                          if (!response.ok)
                            throw new Error(
                              failure(
                                await response.json().catch(() => null),
                                "It could not be renamed.",
                              ),
                            );
                          setRenaming(null);
                          return "The name and group are saved.";
                        }, true)
                      }
                    >
                      Save the name
                    </Button>
                    <Button onPress={() => setRenaming(null)}>Cancel</Button>
                  </p>
                </fieldset>
              ) : deleting ? (
                <div role="group" aria-label="Delete this section">
                  {savedPlaces.length > 0 ? (
                    <>
                      <p>
                        It is linked in these places. Each one gets a copy first, so no page
                        changes:
                      </p>
                      <ul>
                        {savedPlaces.map((p) => (
                          <li key={`${p.themeId}-${p.key}`}>
                            {p.key.startsWith(SECTION_KEY)
                              ? `Saved section: ${savedName(p.key.slice(SECTION_KEY.length))}`
                              : p.themeId === themeId
                                ? layoutTitle(
                                    p.key,
                                    layouts.find((l) => l.key === p.key)?.title ?? "",
                                  )
                                : `${layoutTitle(p.key, "")} (in another theme)`}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p>It is not linked anywhere, so nothing else changes.</p>
                  )}
                  <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    <Button
                      color="danger"
                      isDisabled={pending !== null}
                      onPress={() =>
                        void (async () => {
                          setProblem(null);
                          const response = await fetch(sectionUrl(savedId), { method: "DELETE" });
                          if (!response.ok) {
                            setProblem(
                              failure(
                                await response.json().catch(() => null),
                                "It could not be deleted.",
                              ),
                            );
                            return;
                          }
                          const name = savedOpen.name;
                          setDeleting(false);
                          await refreshList();
                          setOpenKey(layouts[0]!.key);
                          setNote(
                            `"${name}" is deleted. Every place that linked it has a copy now.`,
                          );
                        })()
                      }
                    >
                      {savedPlaces.length > 0
                        ? "Keep it on these pages as copies, then delete"
                        : "Yes, delete it"}
                    </Button>
                    <Button onPress={() => setDeleting(false)}>Keep it</Button>
                  </p>
                </div>
              ) : (
                <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  <Button
                    onPress={() => setRenaming({ name: savedOpen.name, group: savedOpen.group })}
                  >
                    Rename
                  </Button>
                  <Button color="danger" onPress={() => setDeleting(true)}>
                    Delete this section
                  </Button>
                </p>
              )}
            </section>
          ) : null}

          <section aria-label={isSection ? "Draft and history" : "This layout"}>
            <h2 style={{ fontSize: "1rem" }}>{isSection ? "Draft and history" : "This layout"}</h2>
            <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {open.hasDraft ? (
                <Button
                  onPress={() =>
                    void run(async () => {
                      const response = await fetch(
                        isSection
                          ? `${sectionUrl(savedId)}?draft=1`
                          : `${base}/layout?key=${encodeURIComponent(openKey)}`,
                        { method: "DELETE" },
                      );
                      if (!response.ok)
                        throw new Error(
                          failure(
                            await response.json().catch(() => null),
                            "The draft could not be thrown away.",
                          ),
                        );
                      return "The draft is thrown away.";
                    })
                  }
                >
                  Throw away the draft
                </Button>
              ) : null}
              {open.state !== "theme" && open.inTheme ? (
                resetting ? (
                  <>
                    <Button
                      color="danger"
                      onPress={() =>
                        void run(async () => {
                          setResetting(false);
                          await post(
                            `${base}/layout`,
                            { action: "reset", key: openKey },
                            "It could not be reset.",
                          );
                          return "The theme's layout is used again. Your changes are in the history.";
                        })
                      }
                    >
                      Yes, use the theme's layout
                    </Button>
                    <Button onPress={() => setResetting(false)}>Keep my changes</Button>
                  </>
                ) : (
                  <Button onPress={() => setResetting(true)}>Reset to the theme's layout</Button>
                )
              ) : null}
            </p>
            <details>
              <summary>{`History (${versions.length})`}</summary>
              {versions.length === 0 ? (
                <p>Nothing published yet.</p>
              ) : (
                <ol>
                  {versions.map((v) => (
                    <li key={v.id}>
                      {formatWhen(new Date(v.publishedAt).toISOString(), null)}
                      {v.publishedBy ? ` by ${v.publishedBy}` : ""}{" "}
                      <Button
                        size="sm"
                        onPress={() =>
                          void run(async () => {
                            await post(
                              isSection ? sectionUrl(savedId) : `${base}/layout`,
                              { action: "restore", versionId: v.id },
                              "It could not be restored.",
                            );
                            return "Restored as a draft. Publish to show it on the site.";
                          })
                        }
                      >
                        Restore
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
            </details>
          </section>
          {problem ? <Alert color="danger" title="Not done" description={problem} /> : null}
          <p role="status">{note}</p>
        </aside>
      </div>

      <Modal
        isOpen={library}
        onClose={() => setLibrary(false)}
        title="Ready-made sections"
        size="xl"
      >
        <p>
          {`Your saved sections and the sections of ${themeName}, drawn with your site's look. They go ${chosen ? "after the selected block" : "at the end"}.`}
        </p>
        <fieldset className="oks-library-groups">
          <legend>Group</legend>
          {[
            ["all", `All (${sections.length + saved.length})`],
            ...(saved.length > 0 ? [["my", `My sections (${saved.length})`]] : []),
            ...[...new Set(sections.map((s) => s.group))].map((g) => [
              g,
              `${g} (${sections.filter((s) => s.group === g).length})`,
            ]),
          ].map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="library-group"
                value={value}
                checked={libraryGroup === value}
                onChange={() => setLibraryGroup(value!)}
              />{" "}
              {label}
            </label>
          ))}
        </fieldset>
        <ul className="oks-library-list" aria-label="Sections">
          {(libraryGroup === "all" || libraryGroup === "my" ? saved : [])
            .filter((s) => !isSection || s.id !== savedId)
            .map((s) => (
              <li key={`saved-${s.id}`}>
                <h3 style={{ fontSize: "1rem", margin: 0 }}>{s.name}</h3>
                <small>{`My sections · ${placesWords(s.places)}`}</small>
                <div className="oks-library-picture">
                  <iframe
                    title={`Picture of ${s.name}`}
                    aria-hidden="true"
                    tabIndex={-1}
                    loading="lazy"
                    src={`/admin/site-editor/preview?saved=${encodeURIComponent(s.id)}&picture=1&v=${token}`}
                    style={{
                      inlineSize: `${PICTURE_WIDTH}px`,
                      blockSize: `${(12 * 16) / PICTURE_SCALE}px`,
                      transform: `scale(${PICTURE_SCALE})`,
                    }}
                  />
                </div>
                <p style={{ margin: 0 }}>
                  <Button
                    onPress={() => void placeSaved(s.id, "copy")}
                    aria-label={`Copy ${s.name}`}
                  >
                    Copy
                  </Button>{" "}
                  <small>Copy: change it here only</small>
                </p>
                <p style={{ margin: 0 }}>
                  <Button
                    onPress={() => void placeSaved(s.id, "linked")}
                    aria-label={`Linked ${s.name}`}
                  >
                    Linked
                  </Button>{" "}
                  <small>Linked: the same everywhere</small>
                </p>
              </li>
            ))}
          {sections
            .filter(() => libraryGroup !== "my")
            .filter((s) => libraryGroup === "all" || s.group === libraryGroup)
            .map((s) => (
              <li key={s.name}>
                <h3 style={{ fontSize: "1rem", margin: 0 }}>{s.title}</h3>
                <small>{s.group}</small>
                <div className="oks-library-picture">
                  <iframe
                    title={`Picture of ${s.title}`}
                    aria-hidden="true"
                    tabIndex={-1}
                    loading="lazy"
                    src={`/admin/site-editor/preview?theme=${encodeURIComponent(themeId)}&section=${encodeURIComponent(s.name)}`}
                    style={{
                      inlineSize: `${PICTURE_WIDTH}px`,
                      blockSize: `${(12 * 16) / PICTURE_SCALE}px`,
                      transform: `scale(${PICTURE_SCALE})`,
                    }}
                  />
                </div>
                <Button onPress={() => addSection(s.name)} aria-label={`Add ${s.title}`}>
                  Add
                </Button>
              </li>
            ))}
        </ul>
      </Modal>

      <Modal
        isOpen={editingText !== null}
        onClose={() => setEditingText(null)}
        title="Edit the text"
      >
        {editingText ? (
          <EntryEditor
            label="Text"
            initialBlocks={[editingText] as unknown as Block[]}
            onImageUpload={uploadForEditor}
            onFileUpload={uploadForEditor}
            onVideoUpload={uploadForEditor}
            onSave={async (next) => {
              const taken = usedIds(blocks);
              taken.delete(editingText.id);
              const fixed = (next as unknown as LayoutBlock[]).map((b, i) =>
                i === 0
                  ? { ...b, id: editingText.id }
                  : taken.has(b.id)
                    ? { ...b, id: newBlockId(taken) }
                    : b,
              );
              change(replaceBlock(blocks, editingText.id, fixed));
              setEditingText(null);
              return { repairs: [] };
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
