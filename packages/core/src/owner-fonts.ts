// Fonts an owner uploads (spec 05, section 6): a woff2 file kept on the site itself, with the owner's word that they may
// use it. A site has at most a few of them. The list (names and facts, no file) is one settings row; each file is another,
// so reading the list never loads the files. A font is chosen like a library font, by its key
// (`own-sans-400-<first 16 letters of the fingerprint>`), and the page writes its `@font-face` rule from the key alone.
import { createHash } from "node:crypto";
import { newId, type SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { OWN_FONT_KEY, FONT_KINDS, type FontKind } from "./font-library.js";
import { loadThemeStyles } from "./theme-settings.js";

export const OWNER_FONTS_KEY = "owner-fonts";
const FILE_KEY = (sha16: string) => `owner-font-file:${sha16}`;
/** How many fonts a site may keep, and how big one file may be. */
export const MAX_OWNER_FONTS = 6;
export const MAX_OWNER_FONT_BYTES = 400_000;
export const OWNER_FONT_WEIGHTS = ["400", "700", "vf"] as const;
export type OwnerFontWeight = (typeof OWNER_FONT_WEIGHTS)[number];

export interface OwnerFont {
  /** The stored choice: `own-<kind>-<weight>-<16 letters>`. */
  key: string;
  /** The name the owner gave it; shown in the lists only. */
  name: string;
  kind: FontKind;
  weight: OwnerFontWeight;
  sha256: string;
  bytes: number;
  addedBy: string;
  addedAt: string;
}

export type OwnerFontResult<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      code: "forbidden" | "invalid" | "not_found" | "in_use";
      message: string;
      field?: string;
    };

const parse = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,39}$/u;

/** The list as stored; anything damaged is left out, field by field. */
export function readOwnerFonts(raw: unknown): OwnerFont[] {
  const list = parse(raw);
  if (!Array.isArray(list)) return [];
  const fonts: OwnerFont[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const key = String(f["key"] ?? "");
    const m = OWN_FONT_KEY.exec(key);
    if (!m || typeof f["name"] !== "string" || !NAME.test(f["name"])) continue;
    fonts.push({
      key,
      name: f["name"],
      kind: m[1] as FontKind,
      weight: m[2] as OwnerFontWeight,
      sha256: String(f["sha256"] ?? ""),
      bytes: Number(f["bytes"]) || 0,
      addedBy: String(f["addedBy"] ?? ""),
      addedAt: String(f["addedAt"] ?? ""),
    });
  }
  return fonts;
}

export async function loadOwnerFonts(runner: SqlRunner, siteId: string): Promise<OwnerFont[]> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, OWNER_FONTS_KEY],
  );
  return readOwnerFonts(rows[0]?.["value"]);
}

/** Whether these bytes look like a woff2 font: the signature, a length that matches, and some tables. */
export function checkFontFile(bytes: Uint8Array): { ok: true } | { ok: false; message: string } {
  if (bytes.length === 0) return { ok: false, message: "Choose a font file." };
  if (bytes.length > MAX_OWNER_FONT_BYTES)
    return {
      ok: false,
      message: `The file is too big. A font file can be at most ${Math.round(MAX_OWNER_FONT_BYTES / 1000)} KB.`,
    };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = bytes.length >= 4 ? String.fromCharCode(...bytes.subarray(0, 4)) : "";
  if (bytes.length < 48 || signature !== "wOF2")
    return { ok: false, message: "This is not a .woff2 font file." };
  if (view.getUint32(8) !== bytes.length || view.getUint16(12) === 0 || view.getUint16(14) !== 0)
    return { ok: false, message: "This font file is damaged. Download it again." };
  return { ok: true };
}

const writeSetting = (runner: SqlRunner, siteId: string, key: string, value: unknown) =>
  runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, key, JSON.stringify(value), new Date()],
  );

async function audit(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  action: string,
  key: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await runner.all(
    `insert into "audit_log" ("id", "site_id", "actor_type", "actor_id", "action", "target_type", "target_id",
      "detail", "created_at") values (?, ?, 'user', ?, ?, 'font', ?, ?, ?)`,
    [newId(), siteId, actor.userId, action, key, JSON.stringify(detail), new Date()],
  );
}

export interface OwnerFontInput {
  name: string;
  kind: string;
  weight: string;
  /** The owner says they may use this font on their site. */
  licence: boolean;
  bytes: Uint8Array;
}

/** Adds a font. Needs `settings.manage`, the owner's word about the licence, and a file that passes the check. */
export async function addOwnerFont(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: OwnerFontInput,
  now: () => number = Date.now,
): Promise<OwnerFontResult<{ font: OwnerFont }>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the design." };
  const bad = (field: string, message: string) =>
    ({ ok: false, code: "invalid", field, message }) as const;
  const name = String(input.name ?? "").trim();
  if (!NAME.test(name))
    return bad("name", "Give the font a name of letters, digits, spaces and hyphens (up to 40).");
  if (!(FONT_KINDS as readonly string[]).includes(input.kind))
    return bad("kind", "Say what kind of font it is: sans-serif, serif or monospace.");
  if (!(OWNER_FONT_WEIGHTS as readonly string[]).includes(input.weight))
    return bad("weight", "Choose regular, bold or a font that has every weight.");
  if (input.licence !== true)
    return bad("licence", "Confirm that you have the right to use this font on your site.");
  const file = checkFontFile(input.bytes);
  if (!file.ok) return bad("file", file.message);

  const fonts = await loadOwnerFonts(runner, siteId);
  if (fonts.length >= MAX_OWNER_FONTS)
    return bad("file", `A site can keep ${MAX_OWNER_FONTS} fonts of its own. Remove one first.`);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const key = `own-${input.kind}-${input.weight}-${sha256.slice(0, 16)}`;
  if (fonts.some((f) => f.key === key)) return bad("file", "This font file is already added.");
  const font: OwnerFont = {
    key,
    name,
    kind: input.kind as FontKind,
    weight: input.weight as OwnerFontWeight,
    sha256,
    bytes: input.bytes.length,
    addedBy: actor.userId,
    addedAt: new Date(now()).toISOString(),
  };
  await runner.transaction(async (tx) => {
    await writeSetting(tx, siteId, FILE_KEY(sha256.slice(0, 16)), {
      data: Buffer.from(input.bytes).toString("base64"),
    });
    await writeSetting(tx, siteId, OWNER_FONTS_KEY, [...fonts, font]);
    await audit(tx, actor, siteId, "font.add", key, {
      name,
      bytes: font.bytes,
      licenceConfirmed: true,
    });
  });
  return { ok: true, font };
}

/** Removes a font; refused while the look still uses it. Needs `settings.manage`. */
export async function deleteOwnerFont(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  key: string,
): Promise<OwnerFontResult<{ removed: OwnerFont }>> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the design." };
  const fonts = await loadOwnerFonts(runner, siteId);
  const found = fonts.find((f) => f.key === key);
  if (!found) return { ok: false, code: "not_found", message: "This font does not exist." };
  const styles = await loadThemeStyles(runner, siteId);
  if (styles.bodyFont === key || styles.headingFont === key)
    return {
      ok: false,
      code: "in_use",
      message: `${found.name} is used by your site. Choose another font for the text and the headings first.`,
    };
  await runner.transaction(async (tx) => {
    await writeSetting(
      tx,
      siteId,
      OWNER_FONTS_KEY,
      fonts.filter((f) => f.key !== key),
    );
    await tx.all(`delete from "settings" where "site_id" = ? and "key" = ?`, [
      siteId,
      FILE_KEY(found.sha256.slice(0, 16)),
    ]);
    await audit(tx, actor, siteId, "font.remove", key, { name: found.name });
  });
  return { ok: true, removed: found };
}

/** The bytes of a font by the first 16 letters of its fingerprint; checked against the whole fingerprint. */
export async function loadOwnerFontFile(
  runner: SqlRunner,
  sha16: string,
): Promise<Uint8Array | null> {
  if (!/^[0-9a-f]{16}$/.test(sha16)) return null;
  const rows = await runner.all(`select "value" from "settings" where "key" = ?`, [
    FILE_KEY(sha16),
  ]);
  const value = parse(rows[0]?.["value"]) as { data?: unknown } | null;
  if (!value || typeof value.data !== "string") return null;
  const bytes = new Uint8Array(Buffer.from(value.data, "base64"));
  if (!checkFontFile(bytes).ok) return null;
  return createHash("sha256").update(bytes).digest("hex").startsWith(sha16) ? bytes : null;
}
