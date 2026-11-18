// The contrast check of a look (spec 05, sections 5 and 9; TH-52). It reads the colors the theme in use and the owner's
// main color give, works out what the page really shows in light and in dark, and says in plain words where text would
// be hard to read. It only warns; it never refuses (D68). Colors written as "#rgb" or "#rrggbb" are checked; any other
// form (such as rgb(...)) is left out, because the check does not guess.
import type { SqlRunner } from "@oks-page/db";
import { loadActiveThemeVersion } from "./theme-install.js";
import { contrastWarnings, type ContrastWarning } from "./theme-contrast-rules.js";
import { loadThemeStyles } from "./theme-settings.js";

export { NEEDED_CONTRAST, contrastWarnings, type ContrastWarning } from "./theme-contrast-rules.js";

/** The warnings for the site, for both modes (the screen shows those the owner's choice makes reachable). */
export async function loadContrastWarnings(
  runner: SqlRunner,
  siteId: string,
): Promise<ContrastWarning[]> {
  const styles = await loadThemeStyles(runner, siteId);
  const version = await loadActiveThemeVersion(runner, siteId);
  return contrastWarnings(version?.tokens ?? null, { ...styles, colorMode: "system" });
}
