// How the admin writes a time. The site has one time zone (Settings > General); everyone sees times in it. A site that has
// not chosen one ("automatic") shows each person's own browser time, as before.
import { formatInZone } from "@oks-page/core/timezone";

export function formatWhen(iso: string, timeZone: string | null): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return timeZone
    ? formatInZone(ms, timeZone)
    : new Date(ms).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}
