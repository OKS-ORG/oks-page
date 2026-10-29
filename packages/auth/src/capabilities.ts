// What a person may do on a site (spec 02, section 6): the capabilities of their role there. A plugin acting for that
// person may do an action only if this allows it too (spec 02, section 8, rule 1; PL-38).

/** The one database call this needs. Every `SqlRunner` from `@oks-page/db` fits. */
export interface CapabilityRunner {
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface UserCapabilities {
  userId: string;
  /** True when the person has `capability` for every content type, or for `typeKey` when the role limits it to some
   * types. Someone who is not a member of the site has none. */
  can(capability: string, typeKey?: string): boolean;
}

/** The role key that has every capability, including ones added later by plugins (spec 02, section 6). */
export const ADMINISTRATOR_ROLE = "administrator";

export async function capabilitiesOf(
  runner: CapabilityRunner,
  siteId: string,
  userId: string,
): Promise<UserCapabilities> {
  const rows = await runner.all(
    `select r."key" as role_key, c."capability" as capability, c."scope_type_key" as scope
       from "site_members" m
       join "roles" r on r."id" = m."role_id"
       left join "role_capabilities" c on c."role_id" = r."id"
      where m."site_id" = ? and m."user_id" = ?`,
    [siteId, userId],
  );
  const administrator = rows.some((r) => r["role_key"] === ADMINISTRATOR_ROLE);
  // A capability with no scope is for every content type; a scoped one only for the types it names.
  const everywhere = new Set<string>();
  const forTypes = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r["capability"] == null) continue;
    const capability = String(r["capability"]);
    const scope = String(r["scope"] ?? "");
    if (scope === "") everywhere.add(capability);
    else forTypes.set(capability, (forTypes.get(capability) ?? new Set()).add(scope));
  }
  return {
    userId,
    can: (capability, typeKey) =>
      administrator ||
      everywhere.has(capability) ||
      (typeKey !== undefined && (forTypes.get(capability)?.has(typeKey) ?? false)),
  };
}
