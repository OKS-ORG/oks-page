// How the admin writes a time. The site has one time zone (Settings > General); everyone sees times in it. A site that has
// not chosen one ("automatic") shows each person's own browser time. The server does not know that zone, so while it draws
// a page, and while the browser takes the page over, such a time is left out: both draw the same, and the time appears right
// after. (Writing the server's own time first made React report that the two did not match.)
import { formatInZone } from "@oks-page/core/timezone";
import { useSyncExternalStore } from "react";

const nothingToWatch = () => () => {};

/** False while the server draws a page and while the browser takes it over, true from then on. */
export function useInBrowser(): boolean {
  return useSyncExternalStore(
    nothingToWatch,
    () => true,
    () => false,
  );
}

export function formatWhen(iso: string, timeZone: string | null, inBrowser: boolean): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  if (timeZone) return formatInZone(ms, timeZone);
  return inBrowser
    ? new Date(ms).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
    : "";
}

/** Writes times in the site's zone, or in the browser's when the site has none. */
export function useWhen(timeZone: string | null): (iso: string) => string {
  const inBrowser = useInBrowser();
  return (iso) => formatWhen(iso, timeZone, inBrowser);
}
