// The default roles and their capabilities (spec 02, section 6; the Client role is spec 11, section 4). Custom roles are made in
// the admin later.
import { newId, type SqlRunner } from "@oks-page/db";

const CONTENT_OWN = ["content.create", "content.edit_own", "content.delete_own"];
const EDITOR = [
  ...CONTENT_OWN,
  "content.edit_any",
  "content.publish_own",
  "content.publish_any",
  "content.delete_any",
  "content.read_private",
  "content.read_members",
  "media.upload",
  "media.edit_own",
  "media.edit_any",
  "media.delete_any",
  "media.upload_svg",
  "comments.moderate",
  "menus.manage",
];

export interface DefaultRole {
  key: string;
  label: string;
  capabilities: string[];
}

export const DEFAULT_ROLES: DefaultRole[] = [
  {
    key: "administrator",
    label: "Administrator",
    // The Administrator also has every capability that a plugin adds later (the code treats the role as having all).
    capabilities: [
      ...EDITOR,
      "themes.manage",
      "plugins.manage",
      "settings.manage",
      "users.manage",
      "content_types.manage",
      "import",
      "export",
      "api_keys.manage",
    ],
  },
  { key: "editor", label: "Editor", capabilities: EDITOR },
  {
    key: "author",
    label: "Author",
    capabilities: [
      ...CONTENT_OWN,
      "content.publish_own",
      "content.read_members",
      "media.upload",
      "media.edit_own",
    ],
  },
  {
    key: "contributor",
    label: "Contributor",
    capabilities: [...CONTENT_OWN, "content.read_members"],
  },
  { key: "subscriber", label: "Subscriber", capabilities: ["content.read_members"] },
  // The person a site is handed to (spec 11, section 4): writes and edits all content and the library, but cannot publish
  // other people's work, change the design, plugins, settings or users, or delete what others wrote. A change to a page that
  // is already live goes live at once (D60); a new page waits for review.
  {
    key: "client",
    label: "Client",
    capabilities: [
      ...CONTENT_OWN,
      "content.edit_any",
      // May save a page that is already live and keep it live, without the right to publish or unpublish (D60).
      "content.edit_live",
      "content.read_members",
      "media.upload",
      "media.edit_own",
      "media.edit_any",
    ],
  },
];

/** The default roles that were added after the first sites were made. Only these are added to a site that lacks them. */
export const LATER_ROLES = ["client"];

/** Capabilities that came after a later role was made: a site's own system role of that name is given them (and nothing else). */
const ADDED_CAPABILITIES: Record<string, string[]> = { client: ["content.edit_live"] };

/**
 * Adds the default roles that came after a site was made (today: Client). It never changes a role that is there, and it never
 * brings back one of the original roles that was taken away. Safe to call any number of times; returns how many it added.
 */
export async function ensureDefaultRoles(runner: SqlRunner, siteId: string): Promise<number> {
  const have = new Set(
    (await runner.all(`select "key" from "roles" where "site_id" = ?`, [siteId])).map((r) =>
      String(r["key"]),
    ),
  );
  let added = 0;
  for (const role of DEFAULT_ROLES) {
    if (have.has(role.key) || !LATER_ROLES.includes(role.key)) continue;
    const id = newId();
    await runner.all(
      `insert into "roles" ("id", "site_id", "key", "label", "is_system", "created_at") values (?, ?, ?, ?, ?, ?)`,
      [id, siteId, role.key, role.label, true, new Date()],
    );
    for (const capability of role.capabilities)
      await runner.all(
        `insert into "role_capabilities" ("id", "role_id", "capability", "scope_type_key") values (?, ?, ?, ?)`,
        [newId(), id, capability, ""],
      );
    added += 1;
  }
  // A Client role made before it could edit live pages gets that one capability. Nothing else on a role is ever touched.
  for (const [key, capabilities] of Object.entries(ADDED_CAPABILITIES)) {
    const role = (
      await runner.all(
        `select "id" from "roles" where "site_id" = ? and "key" = ? and "is_system" = ?`,
        [siteId, key, true],
      )
    )[0];
    if (!role) continue;
    const roleId = String(role["id"]);
    const have = new Set(
      (
        await runner.all(`select "capability" from "role_capabilities" where "role_id" = ?`, [
          roleId,
        ])
      ).map((r) => String(r["capability"])),
    );
    // Only a role that still has the rest of the Client's rights is topped up: one an owner trimmed is left alone.
    const base = DEFAULT_ROLES.find((r) => r.key === key)!.capabilities.filter(
      (c) => !capabilities.includes(c),
    );
    if (!base.every((c) => have.has(c))) continue;
    for (const capability of capabilities)
      if (!have.has(capability))
        await runner.all(
          `insert into "role_capabilities" ("id", "role_id", "capability", "scope_type_key") values (?, ?, ?, ?)`,
          [newId(), roleId, capability, ""],
        );
  }
  return added;
}
