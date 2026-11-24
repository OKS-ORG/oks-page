// White-label admin (spec 11, section 5): what a freelancer or agency changes so the admin looks like their own product when
// they hand a site to a client. The admin name is free for any site; the logo, the help link and the footer line belong to the
// Agency tier (a licence key that covers "agency"), because they are the agency's own tools (section 3). A key that ends
// never breaks a site: the extras are simply not shown any more.
import type { SqlRunner } from "@oks-page/db";
import type { Actor } from "./content.js";
import { bestLicenceState, type LicencePayload } from "./licence.js";

export const WHITE_LABEL_KEY = "white_label";
/** The licence item the paid white-label features belong to. */
export const AGENCY_ITEM = "agency";
export const NAME_MAX = 40;
export const FOOTER_MAX = 120;

export interface WhiteLabel {
  /** The name shown in the admin (1 to 40 characters), or empty for the product's own name. */
  name: string;
  /** A picture from the media library (PNG, JPEG, WebP or AVIF), or null. Agency tier. */
  logoId: string | null;
  /** Where "Help" goes: an `https://` address or a `mailto:` address, or empty. Agency tier. */
  helpUrl: string;
  /** A line in the admin's footer instead of "Developed with …" (up to 120 characters), or empty. Agency tier. */
  footer: string;
}

export const NO_WHITE_LABEL: WhiteLabel = { name: "", logoId: null, helpUrl: "", footer: "" };

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HTTPS = /^https:\/\/[^\s"'<>\\]{3,300}$/;
const MAILTO = /^mailto:[^\s@"'<>\\]{1,64}@[^\s@"'<>\\]{1,190}\.[^\s@"'<>\\]{2,}$/;

/** Text made safe to show: tags and control characters removed, spaces tidied. */
export function tidyText(v: string): string {
  return Array.from(v, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .replace(/<[^>]*>?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Fail = { ok: false; code: "forbidden" | "invalid"; message: string; field?: string };

const decode = (runner: SqlRunner, raw: unknown): unknown => {
  if (typeof raw !== "string" || runner.dialect === "postgres") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** The stored values, read again carefully: anything that is not sound is left out. */
export function effectiveWhiteLabel(stored: unknown): WhiteLabel {
  const v = (stored !== null && typeof stored === "object" ? stored : {}) as Record<
    string,
    unknown
  >;
  const name = typeof v["name"] === "string" ? tidyText(v["name"]) : "";
  const help = typeof v["helpUrl"] === "string" ? v["helpUrl"].trim() : "";
  const footer = typeof v["footer"] === "string" ? tidyText(v["footer"]) : "";
  return {
    name: name.length <= NAME_MAX ? name : "",
    logoId: typeof v["logoId"] === "string" && ID.test(v["logoId"]) ? v["logoId"] : null,
    helpUrl: HTTPS.test(help) || MAILTO.test(help) ? help : "",
    footer: footer.length <= FOOTER_MAX ? footer : "",
  };
}

export async function loadWhiteLabel(runner: SqlRunner, siteId: string): Promise<WhiteLabel> {
  const rows = await runner.all(
    `select "value" from "settings" where "site_id" = ? and "key" = ?`,
    [siteId, WHITE_LABEL_KEY],
  );
  return effectiveWhiteLabel(decode(runner, rows[0]?.["value"]));
}

/**
 * True when the keys of the site include an Agency key that still lets the paid features run. Only a key that names "agency"
 * counts: a key that covers every plug-in and theme (`*`) does not unlock the agency's own tools.
 */
export function agencyActive(
  licences: readonly LicencePayload[],
  host: string,
  now: Date,
): boolean {
  const named = licences.filter((l) => l.covers.includes(AGENCY_ITEM));
  return bestLicenceState(named, { item: AGENCY_ITEM, host, now })?.paidFeatures === true;
}

/** A logo from the library: a picture that is ready and is not an SVG file (SVG needs cleaning first; not offered here). */
export async function logoOf(
  runner: SqlRunner,
  siteId: string,
  mediaId: string,
): Promise<{ key: string; mime: string } | null> {
  const rows = await runner.all(
    `select "storage_key", "mime_type", "status" from "media" where "id" = ? and "site_id" = ?`,
    [mediaId, siteId],
  );
  const r = rows[0];
  if (!r || String(r["status"]) !== "ready") return null;
  const mime = String(r["mime_type"]);
  if (!/^image\/(png|jpeg|webp|avif)$/.test(mime)) return null;
  return { key: String(r["storage_key"]), mime };
}

/**
 * Saves the white-label settings. Only people who manage the settings. The name is free; a logo, a help link or a footer line
 * needs an Agency key (emptying them never does). Nine kinds of bad input are refused in plain words (spec 11, section 5).
 */
export async function saveWhiteLabel(
  runner: SqlRunner,
  actor: Actor,
  siteId: string,
  input: unknown,
  agency: boolean,
): Promise<{ ok: true; whiteLabel: WhiteLabel } | Fail> {
  if (!actor.can("settings.manage"))
    return { ok: false, code: "forbidden", message: "You may not change the site settings." };
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { ok: false, code: "invalid", message: "The request was not understood." };
  const given = input as Record<string, unknown>;
  const unknown = Object.keys(given).find(
    (k) => !["name", "logoId", "helpUrl", "footer"].includes(k),
  );
  if (unknown)
    return {
      ok: false,
      code: "invalid",
      message: "This is not a white-label setting.",
      field: unknown,
    };
  const bad = (field: string, message: string): Fail => ({
    ok: false,
    code: "invalid",
    message,
    field,
  });
  const need = (field: string): Fail =>
    bad(field, "This needs an Agency licence key. Add one in Settings > Licence keys.");

  const rawName = given["name"] ?? "";
  if (typeof rawName !== "string") return bad("name", "Admin name: write some words.");
  const name = tidyText(rawName);
  if (name.length > NAME_MAX) return bad("name", `Admin name: use at most ${NAME_MAX} characters.`);

  const rawFooter = given["footer"] ?? "";
  if (typeof rawFooter !== "string") return bad("footer", "Footer line: write some words.");
  const footer = tidyText(rawFooter);
  if (footer.length > FOOTER_MAX)
    return bad("footer", `Footer line: use at most ${FOOTER_MAX} characters.`);
  if (footer !== "" && !agency) return need("footer");

  const rawHelp = given["helpUrl"] ?? "";
  if (typeof rawHelp !== "string") return bad("helpUrl", "Help link: write an address.");
  const helpUrl = rawHelp.trim();
  if (helpUrl !== "" && !HTTPS.test(helpUrl) && !MAILTO.test(helpUrl))
    return bad("helpUrl", "Help link: use an address that starts with https:// or mailto:.");
  if (helpUrl !== "" && !agency) return need("helpUrl");

  const rawLogo = given["logoId"] ?? null;
  let logoId: string | null = null;
  if (rawLogo !== null && rawLogo !== "") {
    if (typeof rawLogo !== "string" || !ID.test(rawLogo))
      return bad("logoId", "Logo: choose a picture from the library.");
    if (!agency) return need("logoId");
    if (!(await logoOf(runner, siteId, rawLogo)))
      return bad(
        "logoId",
        "Logo: choose a PNG, JPEG, WebP or AVIF picture from the library that is ready.",
      );
    logoId = rawLogo;
  }

  const value: WhiteLabel = { name, logoId, helpUrl, footer };
  await runner.all(
    `insert into "settings" ("site_id", "key", "value", "revision", "updated_at") values (?, ?, ?, 1, ?)
     on conflict ("site_id", "key") do update set "value" = excluded."value", "revision" = "settings"."revision" + 1, "updated_at" = excluded."updated_at"`,
    [siteId, WHITE_LABEL_KEY, JSON.stringify(value), new Date()],
  );
  return { ok: true, whiteLabel: value };
}

/** What the admin shows, from what was saved and whether an Agency key is active: the extras are only shown with a key. */
export interface AdminBrand {
  name: string;
  logoUrl: string | null;
  helpHref: string | null;
  footerText: string | null;
}

export function adminBrand(wl: WhiteLabel, agency: boolean, logoUrl: string | null): AdminBrand {
  return {
    name: wl.name,
    logoUrl: agency && wl.logoId ? logoUrl : null,
    helpHref: agency && wl.helpUrl !== "" ? wl.helpUrl : null,
    footerText: agency && wl.footer !== "" ? wl.footer : null,
  };
}
