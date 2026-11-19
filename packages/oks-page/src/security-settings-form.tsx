"use client";
// The security settings form: whether administrators must use two-factor sign-in.
import type { SecuritySettings } from "@oks-page/core";
import { Alert, Button, RadioGroupField } from "oks-ui";
import { useState, type FormEvent } from "react";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function SecuritySettingsFormScreen({ initial }: { initial: SecuritySettings }) {
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

  return (
    <form className="oks-security-settings" onSubmit={(event) => void save(event)}>
      <RadioGroupField
        name="requireTwoFactorForAdmins"
        label="Two-factor sign-in for administrators"
        options={[
          { label: "Recommended, not required", value: "off" },
          {
            label: "Required: an administrator without it must set it up before using the admin",
            value: "on",
          },
        ]}
        value={rule}
        onChange={(value: string) => setRule(value)}
      />
      <p>
        You need two-factor on for your own account first. Set it up on{" "}
        <a href="/admin/account">Your account</a>.
      </p>
      <p>
        <label htmlFor="style-hosts">Other hosts that may serve stylesheets</label>
        <br />
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
      </p>
      <p id="style-hosts-hint">
        Public pages load stylesheets only from this site. If you keep files on a CDN or another
        host you trust, write its name here, one per line (for example{" "}
        <code>assets.example.com</code>). Only https and exact host names work: no <code>*</code>,
        no <code>http://</code>, no port. Themes and plug-ins cannot add a host.
      </p>
      <p>
        <Button color="primary" type="submit">
          Save settings
        </Button>
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p role="status">{note}</p>
    </form>
  );
}
