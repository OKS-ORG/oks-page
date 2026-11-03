// The five default roles and their capabilities (spec 02, section 6). Custom roles are made in the admin later.

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
];
