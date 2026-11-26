// The red notice on every admin page (spec 14, section 6): a security warning names the version of the core this site runs, or its
// major version no longer gets security fixes. Only people who manage the settings see it, and only while the site has not been updated.
import { loadUpdateAlerts } from "@oks-page/core";
import { actorOf } from "./admin-actor";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { coreVersion } from "./updates-context";

const box = {
  background: "#fde7e9",
  color: "#5c0011",
  borderBottom: "3px solid #b00020",
  padding: ".75rem 1rem",
  fontSize: "1rem",
} as const;

export async function UpdateBanner() {
  try {
    const member = await signedInMember();
    if (!member) return null;
    const actor = await actorOf(member);
    if (!actor.can("settings.manage")) return null;
    const alerts = await loadUpdateAlerts(getRunner(), member.siteId, coreVersion());
    if (alerts.coreWarnings.length === 0 && alerts.unsupportedLatest === null) return null;
    return (
      <div role="alert" data-update-banner="" style={box}>
        {alerts.coreWarnings.map((w) => (
          <p key={w.id} style={{ margin: ".25rem 0" }}>
            <strong>Security warning ({w.severity}) for the core:</strong> {w.summary} Update to
            version {w.fixed} or later.{" "}
            <a href="/admin/tools/updates" style={{ color: "#5c0011" }}>
              See what to do
            </a>
          </p>
        ))}
        {alerts.unsupportedLatest !== null ? (
          <p style={{ margin: ".25rem 0" }}>
            <strong>This version no longer gets security fixes.</strong> Update to version{" "}
            {alerts.unsupportedLatest}.{" "}
            <a href="/admin/tools/updates" style={{ color: "#5c0011" }}>
              See what to do
            </a>
          </p>
        ) : null}
      </div>
    );
  } catch {
    // The admin must always open, whatever is wrong with the update notes.
    return null;
  }
}
