// Spec 09 section 5: SVG files are cleaned before they are stored. This is a
// security component: it keeps a growing test set (svg.test.ts).

export const MAX_SVG_BYTES = 200 * 1024;

export class SvgRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgRefused";
  }
}

/** Elements that can run code, call another host, or change the page around them. */
const FORBIDDEN_TAGS = [
  "script",
  "foreignObject",
  "use",
  "style",
  "a",
  "image",
  "iframe",
  "animate",
  "set",
  "animateTransform",
  "animateMotion",
  "mpath",
  "discard",
  "feImage",
  "handler",
  "listener",
  "embed",
  "object",
];

const SVG_NS = "http://www.w3.org/2000/svg";

type Purifier = {
  sanitize: (dirty: string, config: Record<string, unknown>) => string;
};

let purifier: Promise<Purifier> | null = null;

// jsdom is large, so it is loaded the first time an SVG arrives.
function getPurifier(): Promise<Purifier> {
  purifier ??= (async () => {
    const [{ JSDOM }, { default: createDOMPurify }] = await Promise.all([
      import("jsdom"),
      import("dompurify"),
    ]);
    const instance = createDOMPurify(new JSDOM("").window as never);
    instance.addHook("uponSanitizeAttribute", (_node, data) => {
      const name = data.attrName.toLowerCase();
      const value = data.attrValue.trim();
      const drop = () => {
        data.keepAttr = false;
        data.forceKeepAttr = false;
      };
      if (name.startsWith("on") || name === "style") return drop();
      // Only links to something inside the same file stay.
      if ((name === "href" || name.endsWith(":href")) && !value.startsWith("#")) return drop();
      if (/url\s*\(/i.test(value)) {
        const refs = [...value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)];
        if (refs.length === 0 || refs.some((m) => !(m[2] ?? "").trim().startsWith("#")))
          return drop();
      }
      // Script and data addresses in any attribute.
      if (/^\s*(javascript|vbscript|data)\s*:/i.test(value)) return drop();
    });
    return instance as unknown as Purifier;
  })();
  return purifier;
}

/**
 * Cleans an SVG file and returns the safe version as text. Refuses a file that
 * is too big, defines entities, or is not an SVG at all.
 */
export async function cleanSvg(bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_SVG_BYTES) {
    throw new SvgRefused(
      `The SVG file is too big. The most allowed is ${MAX_SVG_BYTES / 1024} KB.`,
    );
  }
  let source = new TextDecoder("utf-8").decode(bytes);
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  // Entities allow "billion laughs" and reading local files.
  if (/<!ENTITY/i.test(source) || /<!DOCTYPE[^>]*\[/i.test(source)) {
    throw new SvgRefused("This SVG file defines entities, which are not allowed.");
  }
  const purify = await getPurifier();
  const cleaned = purify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ["style"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    PARSER_MEDIA_TYPE: "image/svg+xml",
    RETURN_TRUSTED_TYPE: false,
  });
  if (typeof cleaned !== "string" || !/^\s*<svg[\s>]/i.test(cleaned)) {
    throw new SvgRefused("This is not a usable SVG file.");
  }
  // A standalone SVG file needs its namespace to be drawn.
  return /^\s*<svg[^>]*\sxmlns\s*=/i.test(cleaned)
    ? cleaned
    : cleaned.replace(/^\s*<svg/i, `<svg xmlns="${SVG_NS}"`);
}
