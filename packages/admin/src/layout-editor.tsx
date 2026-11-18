// The layout editor (spec 06): a page as a tree of blocks. An outline to choose and move blocks (with buttons, so it
// works from the keyboard), a preview in an iframe so the screen sizes answer to the frame's width (section 8), a panel
// for the settings of the chosen block, undo and redo (200 steps), and the design lock. Every change goes through the
// tree rules of the content-safety package, so a refused change says why in a plain sentence and changes nothing.
import {
  applyOp,
  checkStyle,
  DEFAULT_BREAKPOINTS,
  duplicateBlock,
  insertBlock,
  moveBlock,
  removeBlock,
  STYLE_PROPERTIES,
  updateProps,
  type Block,
  type Style,
  type TreeOp,
  type TreeResult,
} from "@oks-page/content-safety";
import { ICON_NAMES, pageCss, writeBlocks } from "@oks-page/renderer";
import { Button } from "oks-ui";
import {
  cloneElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

const HISTORY_LIMIT = 200;

const newId = (): string => globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 26);
const text = (value: string) => [{ type: "text", text: value, styles: {} }];
const block = (
  type: string,
  props: Record<string, unknown> = {},
  content: unknown = null,
  children: Block[] = [],
): Block => ({ id: newId(), type, props, content, children });

/** The blocks the layout editor can add, with what each starts as. */
const CATALOGUE: { type: string; label: string; make: () => Block }[] = [
  { type: "section", label: "Section", make: () => block("section", { width: "boxed" }) },
  { type: "container", label: "Container", make: () => block("container") },
  {
    type: "columns",
    label: "Columns (two)",
    make: () => block("columns", {}, null, [block("column"), block("column")]),
  },
  { type: "spacer", label: "Spacer", make: () => block("spacer", { size: "md" }) },
  {
    type: "heading",
    label: "Heading",
    make: () => block("heading", { level: 2 }, text("A heading")),
  },
  { type: "paragraph", label: "Paragraph", make: () => block("paragraph", {}, text("Some text.")) },
  { type: "quote", label: "Quote", make: () => block("quote", {}, text("A quote.")) },
  { type: "divider", label: "Divider", make: () => block("divider") },
  { type: "image", label: "Image", make: () => block("image", { src: "", alt: "" }) },
  {
    type: "button",
    label: "Button",
    make: () => block("button", { text: "Button", href: "", variant: "solid" }),
  },
  {
    type: "buttonGroup",
    label: "Button group",
    make: () =>
      block("buttonGroup", {}, null, [
        block("button", { text: "Button", href: "", variant: "solid" }),
      ]),
  },
  { type: "gallery", label: "Gallery", make: () => block("gallery", { columns: 3, images: [] }) },
  { type: "audio", label: "Audio", make: () => block("audio", { src: "", title: "" }) },
  { type: "icon", label: "Icon", make: () => block("icon", { name: "star", size: 24 }) },
  {
    type: "socialLinks",
    label: "Social links",
    make: () => block("socialLinks", { items: [] }),
  },
  { type: "map", label: "Map", make: () => block("map", { query: "", provider: "osm" }) },
  {
    type: "accordion",
    label: "Accordion",
    make: () => block("accordion", {}, null, [newItem(), newItem()]),
  },
  {
    type: "tabs",
    label: "Tabs",
    make: () => block("tabs", {}, null, [newTab("First"), newTab("Second")]),
  },
  {
    type: "slider",
    label: "Slider",
    make: () => block("slider", { label: "Slides" }, null, [newSlide(), newSlide()]),
  },
];

function newItem(): Block {
  return block("toggle", {}, text("A question"), [block("paragraph", {}, text("The answer."))]);
}
function newTab(title: string): Block {
  return block("tab", { title }, null, [block("paragraph", {}, text("Words for this tab."))]);
}
function newSlide(): Block {
  return block("slide", {}, null, [block("paragraph", {}, text("A slide."))]);
}

/** One item per line, fields split by a bar: "address | description". Written back when the box is left. */
function ListBox({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <p style={{ margin: "0.5rem 0" }}>
      <span aria-hidden="true">{label}</span>
      <br />
      <textarea
        aria-label={label}
        rows={4}
        style={{ width: "100%" }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
      />
    </p>
  );
}
const splitLines = (value: string): string[][] =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("|").map((part) => part.trim()));

const NAMES: Record<string, string> = {
  section: "Section",
  container: "Container",
  columns: "Columns",
  column: "Column",
  spacer: "Spacer",
  heading: "Heading",
  paragraph: "Paragraph",
  quote: "Quote",
  divider: "Divider",
  image: "Image",
  button: "Button",
  buttonGroup: "Button group",
  gallery: "Gallery",
  audio: "Audio",
  icon: "Icon",
  socialLinks: "Social links",
  map: "Map",
  accordion: "Accordion",
  toggle: "Accordion item",
  tabs: "Tabs",
  tab: "Tab",
  slider: "Slider",
  slide: "Slide",
};

const wordsOf = (b: Block): string => {
  if (b.type === "button") return String(b.props["text"] ?? "");
  if (b.type === "image") return String(b.props["alt"] ?? "");
  if (b.type === "tab" || b.type === "audio") return String(b.props["title"] ?? "");
  if (b.type === "map") return String(b.props["query"] ?? "");
  if (b.type === "icon") return String(b.props["name"] ?? "");
  return Array.isArray(b.content)
    ? b.content.map((r) => String((r as { text?: unknown }).text ?? "")).join("")
    : "";
};
const labelOf = (b: Block): string => {
  const words = wordsOf(b).trim();
  return `${NAMES[b.type] ?? b.type}${words ? `: ${words.length > 28 ? `${words.slice(0, 28)}…` : words}` : ""}`;
};

interface Place {
  block: Block;
  parent: Block | null;
  index: number;
  siblings: Block[];
}

function findPlace(tree: Block[], id: string | null): Place | null {
  if (id === null) return null;
  const walk = (list: Block[], parent: Block | null): Place | null => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      if (b.id === id) return { block: b, parent, index: i, siblings: list };
      const inside = walk(b.children, b);
      if (inside) return inside;
    }
    return null;
  };
  return walk(tree, null);
}

const DEVICES = [
  { key: "base", label: "Phone", width: 390 },
  { key: "tablet", label: "Tablet", width: 800 },
  { key: "desktop", label: "Desktop", width: 1200 },
] as const;

/** What a block shows as when it is not hidden, to put back after a smaller screen hides it. */
const NATURAL_DISPLAY: Record<string, string> = {
  container: "flex",
  columns: "grid",
  buttonGroup: "flex",
  button: "inline-block",
};

const readStyle = (b: Block): Style => checkStyle(b.props["style"], DEFAULT_BREAKPOINTS).style;

export interface LayoutEditorProps {
  label?: string;
  initialBlocks: Block[];
  /** Whether this person is a designer: only a designer may lock parts of a page. */
  canLock?: boolean;
  /** Every change, so the screen can autosave. */
  onChange?: (blocks: Block[]) => void;
  /** Saves, and says what the checks repaired. */
  onSave: (blocks: Block[]) => Promise<{ repairs: string[] }>;
  /** Extra controls (the switch to the writing editor, for example). */
  toolbar?: ReactNode;
  /** A way to bring blocks back from outside (an unsaved copy), kept by the screen. */
  registerReplace?: (replace: (blocks: Block[]) => void) => void;
}

export function LayoutEditor(props: LayoutEditorProps) {
  const [tree, setTree] = useState<Block[]>(props.initialBlocks);
  const treeRef = useRef(tree);
  const [selected, setSelected] = useState<string | null>(null);
  const [past, setPast] = useState<TreeOp[]>([]);
  const [future, setFuture] = useState<TreeOp[]>([]);
  const [message, setMessage] = useState("");
  const [device, setDevice] = useState<(typeof DEVICES)[number]["key"]>("desktop");
  const [adding, setAdding] = useState(CATALOGUE[0]!.type);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  const commit = useCallback(
    (next: Block[]) => {
      treeRef.current = next;
      setTree(next);
      props.onChange?.(next);
    },
    [props],
  );

  /** Runs an operation: a refusal shows its sentence and changes nothing; a change is put on the undo list. */
  const run = useCallback(
    (result: TreeResult, select?: string | null) => {
      if (!result.ok) {
        setMessage(result.message);
        return false;
      }
      setMessage("");
      setPast((p) => [...p, result.inverse].slice(-HISTORY_LIMIT));
      setFuture([]);
      commit(result.tree);
      if (select !== undefined) setSelected(select);
      return true;
    },
    [commit],
  );

  const undo = useCallback(() => {
    const op = past[past.length - 1];
    if (!op) return;
    const result = applyOp(treeRef.current, op);
    if (!result.ok) return setMessage(result.message);
    setPast(past.slice(0, -1));
    setFuture((f) => [...f, result.inverse]);
    commit(result.tree);
  }, [past, commit]);

  const redo = useCallback(() => {
    const op = future[future.length - 1];
    if (!op) return;
    const result = applyOp(treeRef.current, op);
    if (!result.ok) return setMessage(result.message);
    setFuture(future.slice(0, -1));
    setPast((p) => [...p, result.inverse].slice(-HISTORY_LIMIT));
    commit(result.tree);
  }, [future, commit]);

  const { registerReplace } = props;
  useEffect(() => {
    registerReplace?.((blocks) => {
      setPast([]);
      setFuture([]);
      setSelected(null);
      commit(blocks);
    });
  }, [registerReplace, commit]);

  const place = findPlace(tree, selected);

  // ---- adding ----
  function add() {
    const entry = CATALOGUE.find((c) => c.type === adding);
    if (!entry) return;
    const fresh = entry.make();
    // Inside the chosen block if it takes this one; else after it, or after the block that holds it, and so on up.
    const tries: { parentId: string | null; index: number }[] = [];
    if (place) tries.push({ parentId: place.block.id, index: place.block.children.length });
    let at: Place | null = place;
    while (at) {
      tries.push({ parentId: at.parent?.id ?? null, index: at.index + 1 });
      at = findPlace(tree, at.parent?.id ?? null);
    }
    tries.push({ parentId: null, index: tree.length });
    let last = "";
    for (const t of tries) {
      const result = insertBlock(tree, t.parentId, t.index, fresh);
      if (result.ok) return void run(result, fresh.id);
      last = result.message;
    }
    setMessage(last);
  }

  // ---- moving and removing the chosen block ----
  const moveBy = (delta: -1 | 1) => {
    if (!place) return;
    const to = place.index + delta;
    if (to < 0 || to >= place.siblings.length) return setMessage("It is already at the end.");
    run(moveBlock(tree, place.block.id, place.parent?.id ?? null, to));
  };
  const moveOut = () => {
    if (!place) return;
    if (!place.parent) return setMessage("It is already at the top of the page.");
    const up = findPlace(tree, place.parent.id)!;
    run(moveBlock(tree, place.block.id, up.parent?.id ?? null, up.index + 1));
  };
  const moveIn = () => {
    if (!place) return;
    const before = place.siblings[place.index - 1];
    if (!before) return setMessage("There is no block above it to move into.");
    run(moveBlock(tree, place.block.id, before.id, before.children.length));
  };
  const duplicate = () => {
    if (!place) return;
    const copy = duplicateBlock(place.block);
    run(insertBlock(tree, place.parent?.id ?? null, place.index + 1, copy), copy.id);
  };
  const remove = () => {
    if (!place) return;
    run(removeBlock(tree, place.block.id), null);
  };

  // ---- settings of the chosen block ----
  const setProp = (key: string, value: unknown) => {
    if (!place) return;
    const next = { ...place.block.props };
    if (value === undefined || value === "" || value === false) delete next[key];
    else next[key] = value;
    run(updateProps(tree, place.block.id, next));
  };
  const setWords = (value: string) => {
    if (!place) return;
    run(updateProps(tree, place.block.id, place.block.props, text(value)));
  };
  const setStyle = (style: Style) => {
    if (!place) return;
    const next = { ...place.block.props };
    if (Object.keys(style).length > 0) next["style"] = style;
    else delete next["style"];
    run(updateProps(tree, place.block.id, next));
  };
  const setDeclaration = (screen: string, property: string, value: string | null) => {
    if (!place) return;
    const style: Style = JSON.parse(JSON.stringify(readStyle(place.block)));
    const declarations = { ...(style[screen as keyof Style] ?? {}) };
    if (value === null) delete declarations[property];
    else {
      const checked = checkStyle({ [screen]: { [property]: value } }, DEFAULT_BREAKPOINTS);
      if (checked.messages.length > 0) return setMessage(checked.messages[0]!);
      Object.assign(declarations, checked.style[screen as keyof Style] ?? {});
    }
    if (Object.keys(declarations).length > 0) style[screen as keyof Style] = declarations;
    else delete style[screen as keyof Style];
    setStyle(style);
  };
  /** "Hide on phone / tablet / desktop" uses display: none on those screens, and puts the usual display back after. */
  const setHidden = (screen: string, hidden: boolean) => {
    if (!place) return;
    const style: Style = JSON.parse(JSON.stringify(readStyle(place.block)));
    const order = DEVICES.map((d) => d.key as string);
    const now = new Set(order.filter((k) => style[k as keyof Style]?.["display"] === "none"));
    if (hidden) now.add(screen);
    else now.delete(screen);
    const natural = NATURAL_DISPLAY[place.block.type] ?? "block";
    order.forEach((k, i) => {
      const declarations = { ...(style[k as keyof Style] ?? {}) };
      if (now.has(k)) declarations["display"] = "none";
      else if (i > 0 && now.has(order[i - 1]!)) declarations["display"] = natural;
      else delete declarations["display"];
      if (Object.keys(declarations).length > 0) style[k as keyof Style] = declarations;
      else delete style[k as keyof Style];
    });
    setStyle(style);
  };

  // ---- the preview ----
  const document = useMemo(() => {
    const written = writeBlocks(tree, { ids: true });
    const css = pageCss(tree);
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,sans-serif;margin:0;padding:1rem}img{max-inline-size:100%}[data-oks-id]{cursor:default}[data-selected]{outline:2px solid #2563eb;outline-offset:2px}${css}</style><body>${written.html}`;
  }, [tree]);

  // A click in the preview chooses the block under it. The frame has no script (it only shares its origin, so this page
  // can read it); the click is caught here, and links in the preview do nothing.
  const frame = useRef<HTMLIFrameElement>(null);
  const markSelected = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll("[data-selected]").forEach((el) => el.removeAttribute("data-selected"));
    if (selected)
      doc.querySelector(`[data-oks-id="${selected}"]`)?.setAttribute("data-selected", "");
  }, [selected]);
  const wireFrame = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.onclick = (event) => {
      event.preventDefault();
      const hit = (event.target as Element | null)?.closest?.("[data-oks-id]");
      const id = hit?.getAttribute("data-oks-id");
      if (id) setSelected(id);
    };
    markSelected();
  }, [markSelected]);
  useEffect(markSelected, [markSelected]);

  // ---- dragging in the list: before, after or inside the block it is dropped on ----
  const [drag, setDrag] = useState<string | null>(null);
  const [hint, setHint] = useState<{ id: string; where: "before" | "after" | "inside" } | null>(
    null,
  );
  const drop = () => {
    if (!drag || !hint) return;
    const target = findPlace(tree, hint.id);
    const from = findPlace(tree, drag);
    setDrag(null);
    setHint(null);
    if (!target || !from) return;
    let parentId: string | null;
    let index: number;
    if (hint.where === "inside") {
      parentId = target.block.id;
      index = target.block.children.length;
    } else {
      parentId = target.parent?.id ?? null;
      index = target.index + (hint.where === "after" ? 1 : 0);
    }
    // The block leaves its old place first, so a place further down in the same list moves up by one.
    if ((from.parent?.id ?? null) === parentId && from.index < index) index -= 1;
    run(moveBlock(tree, drag, parentId, index));
  };

  // ---- keys: undo and redo ----
  const onKey = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
  };

  async function save() {
    setSaving(true);
    setSaved("");
    try {
      const result = await props.onSave(treeRef.current);
      setSaved(
        result.repairs.length > 0
          ? `Saved. ${result.repairs.length} thing${result.repairs.length === 1 ? " was" : "s were"} fixed on the way.`
          : "Saved.",
      );
    } catch {
      // The screen shows why it did not save.
    }
    setSaving(false);
  }

  const style = place ? readStyle(place.block) : {};
  const hiddenOn = (key: string) => style[key as keyof Style]?.["display"] === "none";
  const locked = place?.block.props["locked"] === true;
  const deviceWidth = DEVICES.find((d) => d.key === device)!.width;
  const panel = { flex: "1 1 16rem", minWidth: 0 } as const;

  const outline = (list: Block[], depth: number): ReactNode => (
    <ul style={{ listStyle: "none", margin: 0, paddingInlineStart: depth === 0 ? 0 : "1rem" }}>
      {list.map((b) => (
        <li key={b.id}>
          <button
            type="button"
            draggable
            onDragStart={(e) => {
              setDrag(b.id);
              e.dataTransfer.setData("text/plain", b.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDrag(null);
              setHint(null);
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              const box = e.currentTarget.getBoundingClientRect();
              const at = (e.clientY - box.top) / Math.max(box.height, 1);
              setHint({ id: b.id, where: at < 0.25 ? "before" : at > 0.75 ? "after" : "inside" });
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop();
            }}
            onClick={() => setSelected(b.id)}
            aria-current={selected === b.id ? "true" : undefined}
            style={{
              display: "block",
              width: "100%",
              textAlign: "start",
              padding: "0.25rem 0.5rem",
              border: "1px solid transparent",
              borderColor: selected === b.id ? "currentColor" : "transparent",
              borderTopColor: hint?.id === b.id && hint.where === "before" ? "#2563eb" : undefined,
              borderBottomColor:
                hint?.id === b.id && hint.where === "after" ? "#2563eb" : undefined,
              boxShadow:
                hint?.id === b.id && hint.where === "inside"
                  ? "inset 0 0 0 2px #2563eb"
                  : undefined,
              background: selected === b.id ? "rgba(127,127,127,0.18)" : "none",
              color: "inherit",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            {b.props["locked"] === true ? "🔒 " : ""}
            {labelOf(b)}
          </button>
          {b.children.length > 0 ? outline(b.children, depth + 1) : null}
        </li>
      ))}
    </ul>
  );

  // The label is the control's own name (aria-label), so a field's value is never read out as part of its name.
  const field = (label: string, input: ReactElement<Record<string, unknown>>) => (
    <p style={{ margin: "0.5rem 0" }}>
      <span aria-hidden="true">{label}</span>
      <br />
      {cloneElement(input, { "aria-label": label })}
    </p>
  );

  const typeSettings = place ? (
    <>
      {["heading", "paragraph", "quote", "toggle"].includes(place.block.type)
        ? field(
            "Text",
            <textarea
              rows={3}
              style={{ width: "100%" }}
              value={wordsOf(place.block)}
              onChange={(e) => setWords(e.target.value)}
            />,
          )
        : null}
      {place.block.type === "heading"
        ? field(
            "Level",
            <select
              value={String(place.block.props["level"] ?? 2)}
              onChange={(e) => setProp("level", Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  Heading {n}
                </option>
              ))}
            </select>,
          )
        : null}
      {place.block.type === "button" ? (
        <>
          {field(
            "Button text",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["text"] ?? "")}
              onChange={(e) => setProp("text", e.target.value)}
            />,
          )}
          {field(
            "Link",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["href"] ?? "")}
              onChange={(e) => setProp("href", e.target.value)}
            />,
          )}
          {field(
            "Look",
            <select
              value={String(place.block.props["variant"] ?? "solid")}
              onChange={(e) => setProp("variant", e.target.value)}
            >
              <option value="solid">Solid</option>
              <option value="outline">Outline</option>
              <option value="link">Link</option>
            </select>,
          )}
        </>
      ) : null}
      {place.block.type === "image" ? (
        <>
          {field(
            "Picture address",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["src"] ?? "")}
              onChange={(e) => setProp("src", e.target.value)}
            />,
          )}
          {field(
            "Describe the picture",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["alt"] ?? "")}
              onChange={(e) => setProp("alt", e.target.value)}
            />,
          )}
        </>
      ) : null}
      {place.block.type === "section"
        ? field(
            "Width",
            <select
              value={String(place.block.props["width"] ?? "boxed")}
              onChange={(e) => setProp("width", e.target.value)}
            >
              <option value="boxed">Boxed</option>
              <option value="full">Full width</option>
            </select>,
          )
        : null}
      {place.block.type === "spacer"
        ? field(
            "Height",
            <select
              value={String(place.block.props["size"] ?? "md")}
              onChange={(e) => setProp("size", e.target.value)}
            >
              {["xs", "sm", "md", "lg", "xl"].map((s) => (
                <option key={s} value={s}>
                  {s.toUpperCase()}
                </option>
              ))}
            </select>,
          )
        : null}
      {place.block.type === "gallery" ? (
        <>
          <ListBox
            key={place.block.id}
            label="Pictures (one per line: address | description)"
            value={(Array.isArray(place.block.props["images"]) ? place.block.props["images"] : [])
              .map((i: { src?: string; alt?: string }) => `${i.src ?? ""} | ${i.alt ?? ""}`)
              .join("\n")}
            onCommit={(v) =>
              setProp(
                "images",
                splitLines(v).map(([src, alt]) => ({ src: src ?? "", alt: alt ?? "" })),
              )
            }
          />
          {field(
            "Columns",
            <select
              value={String(place.block.props["columns"] ?? 3)}
              onChange={(e) => setProp("columns", Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>,
          )}
        </>
      ) : null}
      {place.block.type === "audio" ? (
        <>
          {field(
            "Audio address",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["src"] ?? "")}
              onChange={(e) => setProp("src", e.target.value)}
            />,
          )}
          {field(
            "Title",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["title"] ?? "")}
              onChange={(e) => setProp("title", e.target.value)}
            />,
          )}
        </>
      ) : null}
      {place.block.type === "icon" ? (
        <>
          {field(
            "Icon",
            <select
              value={String(place.block.props["name"] ?? "star")}
              onChange={(e) => setProp("name", e.target.value)}
            >
              {ICON_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>,
          )}
          {field(
            "Size (8 to 128)",
            <input
              type="number"
              min={8}
              max={128}
              value={Number(place.block.props["size"] ?? 24)}
              onChange={(e) => setProp("size", Number(e.target.value) || undefined)}
            />,
          )}
          {field(
            "What it means (read out to people who cannot see it)",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["label"] ?? "")}
              onChange={(e) => setProp("label", e.target.value)}
            />,
          )}
          {field(
            "Link",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["href"] ?? "")}
              onChange={(e) => setProp("href", e.target.value)}
            />,
          )}
        </>
      ) : null}
      {place.block.type === "socialLinks" ? (
        <ListBox
          key={place.block.id}
          label="Links (one per line: network | address)"
          value={(Array.isArray(place.block.props["items"]) ? place.block.props["items"] : [])
            .map((i: { network?: string; href?: string }) => `${i.network ?? ""} | ${i.href ?? ""}`)
            .join("\n")}
          onCommit={(v) =>
            setProp(
              "items",
              splitLines(v).map(([network, href]) => ({
                network: network ?? "",
                href: href ?? "",
              })),
            )
          }
        />
      ) : null}
      {place.block.type === "map" ? (
        <>
          {field(
            "Address or place",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["query"] ?? "")}
              onChange={(e) => setProp("query", e.target.value)}
            />,
          )}
          {field(
            "Map service",
            <select
              value={String(place.block.props["provider"] ?? "osm")}
              onChange={(e) => setProp("provider", e.target.value)}
            >
              <option value="osm">OpenStreetMap</option>
              <option value="google">Google Maps</option>
            </select>,
          )}
        </>
      ) : null}
      {place.block.type === "accordion" ? (
        <>
          <p>
            <label>
              <input
                type="checkbox"
                checked={place.block.props["single"] === true}
                onChange={(e) => setProp("single", e.target.checked)}
              />{" "}
              Only one item open at a time
            </label>
          </p>
          <p>
            <Button
              onPress={() =>
                run(insertBlock(tree, place.block.id, place.block.children.length, newItem()))
              }
            >
              Add an item
            </Button>
          </p>
        </>
      ) : null}
      {place.block.type === "tabs" ? (
        <p>
          <Button
            onPress={() =>
              run(insertBlock(tree, place.block.id, place.block.children.length, newTab("Tab")))
            }
          >
            Add a tab
          </Button>
        </p>
      ) : null}
      {place.block.type === "tab"
        ? field(
            "Tab title",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["title"] ?? "")}
              onChange={(e) => setProp("title", e.target.value)}
            />,
          )
        : null}
      {place.block.type === "slider" ? (
        <>
          {field(
            "Name of the slider (read out to people who cannot see it)",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["label"] ?? "")}
              onChange={(e) => setProp("label", e.target.value)}
            />,
          )}
          <p>
            <Button
              onPress={() =>
                run(insertBlock(tree, place.block.id, place.block.children.length, newSlide()))
              }
            >
              Add a slide
            </Button>
          </p>
        </>
      ) : null}
      {place.block.type === "columns" ? (
        <p>
          <Button
            onPress={() =>
              run(insertBlock(tree, place.block.id, place.block.children.length, block("column")))
            }
          >
            Add a column
          </Button>
        </p>
      ) : null}
      {["section", "container"].includes(place.block.type)
        ? field(
            "Anchor name (for links to this part)",
            <input
              style={{ width: "100%" }}
              value={String(place.block.props["anchor"] ?? "")}
              onChange={(e) => setProp("anchor", e.target.value)}
            />,
          )
        : null}
    </>
  ) : null;

  return (
    <div
      role="group"
      aria-label={props.label ?? "Layout editor"}
      onKeyDown={onKey}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      <div
        role="toolbar"
        aria-label="Layout tools"
        style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}
      >
        <Button isDisabled={past.length === 0} onPress={undo}>
          Undo
        </Button>
        <Button isDisabled={future.length === 0} onPress={redo}>
          Redo
        </Button>
        <label>
          Add a block{" "}
          <select value={adding} onChange={(e) => setAdding(e.target.value)}>
            {CATALOGUE.map((c) => (
              <option key={c.type} value={c.type}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <Button onPress={add}>Add</Button>
        <span role="radiogroup" aria-label="Preview size">
          {DEVICES.map((d) => (
            <label key={d.key} style={{ marginInlineEnd: "0.5rem" }}>
              <input
                type="radio"
                name="layout-device"
                checked={device === d.key}
                onChange={() => setDevice(d.key)}
              />{" "}
              {d.label}
            </label>
          ))}
        </span>
        <Button color="primary" isDisabled={saving} onPress={() => void save()}>
          Save
        </Button>
        {props.toolbar}
      </div>
      {message ? (
        <p role="alert" style={{ margin: 0 }}>
          {message}
        </p>
      ) : null}
      {saved ? (
        <p role="status" style={{ margin: 0 }}>
          {saved}
        </p>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-start" }}>
        <section aria-label="Blocks on this page" style={panel}>
          <h3 style={{ marginTop: 0 }}>Blocks</h3>
          {tree.length === 0 ? <p>The page is empty. Add a section to start.</p> : outline(tree, 0)}
        </section>
        <section aria-label="Preview" style={{ flex: "3 1 24rem", minWidth: 0 }}>
          <h3 style={{ marginTop: 0 }}>Preview ({deviceWidth} px wide)</h3>
          <div style={{ overflowX: "auto" }}>
            <iframe
              ref={frame}
              title="Page preview"
              sandbox="allow-same-origin"
              onLoad={wireFrame}
              srcDoc={document}
              style={{
                width: `${deviceWidth}px`,
                maxWidth: "100%",
                height: "32rem",
                border: "1px solid rgba(127,127,127,0.5)",
                background: "#fff",
                boxSizing: "border-box",
              }}
            />
          </div>
        </section>
        <section aria-label="Settings of the chosen block" style={{ ...panel, flex: "1 1 18rem" }}>
          <h3 style={{ marginTop: 0 }}>Settings</h3>
          {!place ? (
            <p>Choose a block in the list to change it.</p>
          ) : (
            <>
              <p style={{ margin: "0 0 0.5rem" }}>
                <strong>{labelOf(place.block)}</strong>
              </p>
              <div
                role="group"
                aria-label="Move or remove"
                style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}
              >
                <Button onPress={() => moveBy(-1)}>Move up</Button>
                <Button onPress={() => moveBy(1)}>Move down</Button>
                <Button onPress={moveOut}>Move out</Button>
                <Button onPress={moveIn}>Move into the block above</Button>
                <Button onPress={duplicate}>Duplicate</Button>
                <Button color="danger" onPress={remove}>
                  Delete
                </Button>
              </div>
              {typeSettings}
              <fieldset style={{ margin: "0.75rem 0" }}>
                <legend>Hide on</legend>
                {DEVICES.map((d) => (
                  <label key={d.key} style={{ marginInlineEnd: "0.75rem" }}>
                    <input
                      type="checkbox"
                      checked={hiddenOn(d.key)}
                      onChange={(e) => setHidden(d.key, e.target.checked)}
                    />{" "}
                    {d.label}
                  </label>
                ))}
              </fieldset>
              <StyleBox
                key={`${place.block.id}-${device}`}
                screen={device}
                declarations={style[device] ?? {}}
                onSet={(property, value) => setDeclaration(device, property, value)}
              />
              {props.canLock ? (
                <fieldset style={{ margin: "0.75rem 0" }}>
                  <legend>Design lock</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={locked}
                      onChange={(e) => setProp("locked", e.target.checked)}
                    />{" "}
                    Locked: your client cannot change this part
                  </label>
                  {locked
                    ? field(
                        "What a client may still do",
                        <select
                          value={String(place.block.props["lockMode"] ?? "")}
                          onChange={(e) => setProp("lockMode", e.target.value)}
                        >
                          <option value="">Nothing</option>
                          <option value="content">Change the words</option>
                        </select>,
                      )
                    : null}
                </fieldset>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** The style of the chosen block on one screen size: the values set, and a way to add one. */
function StyleBox({
  screen,
  declarations,
  onSet,
}: {
  screen: string;
  declarations: Record<string, string>;
  onSet: (property: string, value: string | null) => void;
}) {
  const [property, setProperty] = useState("padding");
  const [value, setValue] = useState("");
  const screenName = DEVICES.find((d) => d.key === screen)!.label.toLowerCase();
  return (
    <fieldset style={{ margin: "0.75rem 0" }}>
      <legend>Style on {screenName}</legend>
      {Object.keys(declarations).length === 0 ? (
        <p style={{ margin: 0 }}>Nothing set. The theme&rsquo;s look is used.</p>
      ) : (
        <ul style={{ margin: 0, paddingInlineStart: "1.25rem" }}>
          {Object.entries(declarations).map(([p, v]) => (
            <li key={p}>
              {p}: {v}{" "}
              <Button aria-label={`Remove ${p}`} onPress={() => onSet(p, null)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p style={{ margin: "0.5rem 0 0" }}>
        <label>
          Setting{" "}
          <select value={property} onChange={(e) => setProperty(e.target.value)}>
            {STYLE_PROPERTIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Value <input value={value} onChange={(e) => setValue(e.target.value)} />
        </label>{" "}
        <Button
          isDisabled={value.trim() === ""}
          onPress={() => {
            onSet(property, value.trim());
            setValue("");
          }}
        >
          Set
        </Button>
      </p>
    </fieldset>
  );
}
