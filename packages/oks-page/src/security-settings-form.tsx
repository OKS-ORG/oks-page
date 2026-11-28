"use client";
// The security settings form: whether administrators must use two-factor sign-in.
import type { BlockedStyle, SecuritySettings } from "@oks-page/core";
import { Alert, Button, RadioGroupField } from "oks-ui";
import { useState, type FormEvent } from "react";
import { SaveBar, SettingRow, SettingsCard } from "./settings-rows";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function SecuritySettingsFormScreen({
  initial,
  blocked: initialBlocked = [],
}: {
  initial: SecuritySettings;
  blocked?: BlockedStyle[];
}) {
  const [blocked, setBlocked] = useState(initialBlocked);
  const [saved, setSaved] = useState(initial.styleHosts);
  const [rule, setRule] = useState(initial.requireTwoFactorForAdmins ? "on" : "off");
  const [hosts, setHosts] = useState(initial.styleHosts.join("\n"));
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch("/api/admin/settings/security", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requireTwoFactorForAdmins: rule === "on",
          styleHosts: hosts
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(body, "It could not be saved."));
      setNote(
        rule === "on"
          ? "Saved. Administrators without two-factor are asked to set it up when they next open the admin."
          : "Saved.",
      );
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  // "Allow" adds one blocked host to the saved list; "Not now" forgets it. Both answer with the list that is left.
  async function decide(host: string, allow: boolean) {
    setProblem(null);
    setNote("Saving…");
    try {
      const response = await fetch("/api/admin/settings/security", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(allow ? { styleHosts: [...saved, host] } : { dismissBlocked: host }),
      });
      const body = (await response.json().catch(() => null)) as {
        settings?: SecuritySettings;
        blocked?: BlockedStyle[];
      } | null;
      if (!response.ok) throw new Error(failure(body, "It could not be saved."));
      if (body?.settings) {
        setSaved(body.settings.styleHosts);
        setHosts(body.settings.styleHosts.join("\n"));
      }
      setBlocked(body?.blocked ?? []);
      setNote(allow ? `${host} is allowed now.` : `${host} stays blocked.`);
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  return (
    <form className="oks-security-settings oks-set-form" onSubmit={(event) => void save(event)}>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <SettingsCard title="Signing in">
        <SettingRow
          label="Two-factor sign-in"
          help={
            <>
              You need two-factor on for your own account first. Set it up on{" "}
              <a href="/admin/account">Your account</a>.
            </>
          }
        >
          <RadioGroupField
            name="requireTwoFactorForAdmins"
            label="Two-factor sign-in for administrators"
            options={[
              { label: "Recommended, not required", value: "off" },
              {
                label:
                  "Required: an administrator without it must set it up before using the admin",
                value: "on",
              },
            ]}
            value={rule}
            onChange={(value: string) => setRule(value)}
          />
        </SettingRow>
      </SettingsCard>
      {blocked.length > 0 ? (
        <section aria-labelledby="blocked-styles-title">
          <h2 id="blocked-styles-title">Stylesheets that were blocked</h2>
          <p>
            A visitor's browser refused to load styles from these hosts, because they are not on the
            list below. If you know and trust a host, allow it. If you do not know it, leave it
            blocked: it may be something a visitor's own browser added.
          </p>
          <ul>
            {blocked.map((b) => (
              <li key={b.host}>
                <strong>{b.host}</strong>
                {b.page ? ` on ${b.page}` : ""}, {b.count === 1 ? "once" : `${b.count} times`}{" "}
                <Button type="button" onPress={() => void decide(b.host, true)}>
                  Allow {b.host}
                </Button>{" "}
                <Button type="button" onPress={() => void decide(b.host, false)}>
                  Not now
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <SettingsCard title="Stylesheets from other hosts">
        <SettingRow
          label="Other hosts that may serve stylesheets"
          htmlFor="style-hosts"
          helpId="style-hosts-hint"
          help={
            <>
              Public pages load stylesheets only from this site. If you keep files on a CDN or
              another host you trust, write its name here, one per line (for example{" "}
              <code>assets.example.com</code>). Only https and exact host names work: no{" "}
              <code>*</code>, no <code>http://</code>, no port. Themes and plug-ins cannot add a
              host.
            </>
          }
        >
          <textarea
            id="style-hosts"
            name="styleHosts"
            rows={4}
            cols={48}
            spellCheck={false}
            aria-describedby="style-hosts-hint"
            value={hosts}
            onChange={(event) => setHosts(event.target.value)}
          />
        </SettingRow>
      </SettingsCard>
      <SaveBar note={note}>
        <Button color="primary" type="submit">
          Save settings
        </Button>
      </SaveBar>
    </form>
  );
}
