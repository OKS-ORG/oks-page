// The plugins that ship with the product (spec 16, D133): the Forms plugin is installed and switched on in new sites. The
// plugin file is kept in this package (`forms-plugin-file.json`, made by scripts/first-party-plugins.mjs from
// apps/forms-plugin, and compared with it by a repository check), so a site installs it without a download. The owner
// can switch it off or remove it like any plugin.
import type { Actor } from "@oks-page/core";
import type { SqlRunner } from "@oks-page/db";
import type { PluginSettings } from "@oks-page/sandbox";
import businessFile from "./business-plugin-file.json";
import formsFile from "./forms-plugin-file.json";
import { installPlugin, savePluginSettings } from "./plugin-admin";

/** The text of the Forms plugin file, as `oks pack` writes it. */
export const FORMS_PLUGIN_TEXT: string = JSON.stringify(formsFile);

/** The text of the Business plugin file (spec 19). It is offered in Tools > Plugins; a site adds it when it is for a business. */
export const BUSINESS_PLUGIN_TEXT: string = JSON.stringify(businessFile);

/** The plugins that ship with the product, by the name Tools > Plugins asks for. */
export const BUNDLED_PLUGINS: Record<string, string> = {
  forms: FORMS_PLUGIN_TEXT,
  business: BUSINESS_PLUGIN_TEXT,
};

/** What the wizard knows about the site, for the plugins that start from it. */
export interface DefaultPluginsOptions {
  /** What the owner said the site is for. A site for a business starts with the Business plugin too. */
  purpose?: string;
  siteName?: string;
  /** The site's time zone, when the wizard had a real one. */
  timeZone?: string | null;
}

export type DefaultPluginsResult = { ok: true } | { ok: false; message: string };

/**
 * Installs what a new site starts with, for the person who just made the site. Forms gets every permission it asks for
 * (it was approved by the product's decision, D133) and sends messages to the owner's own email address until the owner
 * writes other addresses. It never throws: a plugin that cannot be installed must not stop a site from being made, so
 * the answer says what went wrong and the site is set up without it (the owner can add Forms in Tools > Plugins).
 */
export async function installDefaultPlugins(
  runner: SqlRunner,
  siteId: string,
  userId: string,
  adminEmail: string,
  settings: PluginSettings,
  options: DefaultPluginsOptions = {},
): Promise<DefaultPluginsResult> {
  // The person who set the site up acts here with the plugin rights, as the one who made the site.
  const actor: Actor = { userId, can: () => true };
  try {
    const installed = await installPlugin(
      runner,
      actor,
      siteId,
      FORMS_PLUGIN_TEXT,
      formsFile.manifest.permissions,
      "setup",
    );
    // A site that already has it (setup was run again after a failure) keeps what it has.
    if (!installed.ok)
      return installed.code === "taken" ? { ok: true } : { ok: false, message: installed.message };
    const saved = await savePluginSettings(
      runner,
      actor,
      siteId,
      formsFile.manifest.id,
      { send_to: adminEmail },
      settings,
    );
    if (!saved.ok) return { ok: false, message: saved.message };
    // A site for a business also starts with the Business plugin, switched on, with the business name, the owner's email and the
    // site's time zone filled in (spec 19, section 2). If it cannot be added the site and Forms are still there.
    if (options.purpose === "business") {
      const business = await installPlugin(
        runner,
        actor,
        siteId,
        BUSINESS_PLUGIN_TEXT,
        businessFile.manifest.permissions,
        "setup",
      );
      if (!business.ok)
        return business.code === "taken" ? { ok: true } : { ok: false, message: business.message };
      const filled = await savePluginSettings(
        runner,
        actor,
        siteId,
        businessFile.manifest.id,
        {
          name: (options.siteName ?? "").trim().slice(0, 120),
          email: adminEmail,
          ...(options.timeZone ? { time_zone: options.timeZone } : {}),
        },
        settings,
      );
      if (!filled.ok) return { ok: false, message: filled.message };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The plugin could not be installed.",
    };
  }
}
