"use client";
// Settings > Branding (spec 11, section 5): what the admin calls itself. The name is free for any site. The logo, the help link
// and the footer line are the Agency tier's: without an Agency key they are shown but cannot be changed, with the way to add a key.
import type { WhiteLabel } from "@oks-page/core";
import { Alert, Button } from "oks-ui";
import { useState, type FormEvent } from "react";

const FIELD: React.CSSProperties = {
  minBlockSize: "32px",
  maxInlineSize: "28rem",
  inlineSize: "100%",
};

export function BrandingScreen({
  initial,
  agency,
  pictures,
}: {
  initial: WhiteLabel;
  agency: boolean;
  pictures: { id: string; name: string }[];
}) {
  const [values, setValues] = useState({
    name: initial.name,
    logoId: initial.logoId ?? "",
    helpUrl: initial.helpUrl,
    footer: initial.footer,
  });
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setNote("Saving…");
    const response = await fetch("/api/admin/settings/branding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...values, logoId: values.logoId === "" ? null : values.logoId }),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      setNote("");
      setProblem(body?.error?.message ?? "The branding could not be saved.");
      return;
    }
    setNote("Saved. Open another screen to see it.");
  }

  return (
    <form aria-labelledby="branding-title" onSubmit={(event) => void save(event)}>
      <h2 id="branding-title">The admin&apos;s own name</h2>
      <p>
        When you give a site to a client, the admin can carry your name instead of the
        product&apos;s. The name is free for every site.
      </p>
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      <p>
        <label>
          Admin name (up to 40 characters; empty uses the product&apos;s own)
          <br />
          <input
            type="text"
            maxLength={40}
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
            style={FIELD}
          />
        </label>
      </p>
      <h2>For agencies</h2>
      {agency ? (
        <p>An Agency licence key is active, so these can be set.</p>
      ) : (
        <Alert
          color="warning"
          title="These need an Agency licence key"
          description="The logo, the help link and the footer line are the Agency tier's tools. You can add a key in Settings > Licence keys. Handing a site to a client never needs one."
        />
      )}
      <p>
        <label>
          Logo (a picture from your library)
          <br />
          <select
            value={values.logoId}
            disabled={!agency}
            onChange={(e) => setValues({ ...values, logoId: e.target.value })}
            style={FIELD}
          >
            <option value="">No logo</option>
            {pictures.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p>
        <label>
          Help link (https:// or mailto: address)
          <br />
          <input
            type="text"
            value={values.helpUrl}
            disabled={!agency}
            onChange={(e) => setValues({ ...values, helpUrl: e.target.value })}
            style={FIELD}
          />
        </label>
      </p>
      <p>
        <label>
          Footer line (up to 120 characters; replaces &ldquo;Developed with …&rdquo;)
          <br />
          <input
            type="text"
            maxLength={120}
            value={values.footer}
            disabled={!agency}
            onChange={(e) => setValues({ ...values, footer: e.target.value })}
            style={FIELD}
          />
        </label>
      </p>
      <p>
        <Button type="submit" color="primary">
          Save branding
        </Button>
      </p>
      <p role="status">{note}</p>
    </form>
  );
}
