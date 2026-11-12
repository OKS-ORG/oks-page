"use client";
// The security settings form: whether administrators must use two-factor sign-in.
import type { SecuritySettings } from "@oks-page/core";
import { Alert, Button, RadioGroupField } from "oks-ui";
import { useState, type FormEvent } from "react";

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

export function SecuritySettingsFormScreen({ initial }: { initial: SecuritySettings }) {
  const [rule, setRule] = useState(initial.requireTwoFactorForAdmins ? "on" : "off");
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
        body: JSON.stringify({ requireTwoFactorForAdmins: rule === "on" }),
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
        <Button color="primary" type="submit">
          Save settings
        </Button>
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p role="status">{note}</p>
    </form>
  );
}
