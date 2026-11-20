// The words for a permission the host refused (ADR 0036): one plain sentence for the owner and one exact message for
// the developer. The sentences are English here; the translated ones belong in the SDK (spec 04, section 4.2).
import type { CallKind } from "./types.js";

/** What the owner reads for each exact permission (spec 04, section 4.2). */
const PLAIN: Record<string, string> = {
  "content:read": "Read your published posts and pages",
  "content:read_drafts": "Read your drafts and private content",
  "content:write": "Change posts and pages when they are saved",
  "content:publish": "Publish and unpublish",
  "content:delete": "Delete content",
  "media:read": "See your media files",
  "media:write": "Upload and change media",
  "users:read": "See user names and roles",
  "users:read_email": "See people's email addresses",
  "comments:read": "Read or moderate comments",
  "comments:moderate": "Read or moderate comments",
  "menus:write": "Change menus",
  "settings:read": "Read your site settings",
  "email:send": "Send email from your site",
  "site:head": "Add tags to every page's head",
  "site:scripts": "Add scripts to your public pages",
  "routes:public": "Add its own web addresses to your site",
  "admin:pages": "Add admin pages and dashboard cards",
  cron: "Run tasks on a schedule",
};

/** Every exact permission of the list in spec 04, section 4.2 (a network permission names its host after a colon). */
export const KNOWN_PERMISSIONS = Object.keys(PLAIN);

/** The plain sentence for an exact permission; a permission the table does not know is shown as it is. */
export function permissionWords(permission: string): string {
  const host = /^network:fetch:(.+)$/.exec(permission)?.[1];
  if (host) return `Connect to ${host}`;
  return PLAIN[permission] ?? permission;
}

/** The note for the owner: what is missing, what it means, and what to do. */
export function ownerSentence(plugin: string, permission: string): string {
  return `${plugin} needs the permission '${permissionWords(permission)}' but does not have it, so part of it does not work. Ask the author for an update.`;
}

/** The message for the developer: which hook or block, which exact permission, and the fix. */
export function developerMessage(
  call: { kind: CallKind; name: string } | undefined,
  permission: string,
): string {
  const who = call ? `${call.kind === "hook" ? "Hook" : "Block"} "${call.name}"` : "This call";
  return `${who} needs "${permission}". Add it to "permissions" in the manifest.`;
}

/** How risky a permission is, as the owner sees it on the approval screen (spec 04, section 4.2). */
export function permissionRisk(permission: string): "low" | "medium" | "high" {
  if (permission.startsWith("network:fetch:")) return "high";
  if (
    [
      "content:read_drafts",
      "content:publish",
      "content:delete",
      "users:read_email",
      "email:send",
      "site:head",
      "site:scripts",
    ].includes(permission)
  )
    return "high";
  if (
    [
      "content:write",
      "media:write",
      "comments:read",
      "comments:moderate",
      "menus:write",
      "routes:public",
      "cron",
    ].includes(permission)
  )
    return "medium";
  return "low";
}
