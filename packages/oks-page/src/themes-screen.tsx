"use client";
// The Themes screen: upload a theme file and read the report in plain words, then use the theme, go back to the version
// before, or remove it. Every step is checked again on the server.
import type { InstalledTheme, PackageReport, ThemeSwitchPlan } from "@oks-page/core";
import { Modal } from "@oks-page/admin";
import { Alert, Button } from "oks-ui";
import { useRef, useState, type FormEvent } from "react";
import { SwitchPlan } from "./theme-switch-plan";

const MAX_BYTES = 24 * 1024 * 1024;

const failure = (body: unknown, fallback: string): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? fallback;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const starterOf = (themes: InstalledTheme[], id: string): number =>
  themes.find((t) => t.id === id)?.starterPages ?? 0;

function Report({ report, title }: { report: PackageReport; title: string }) {
  const groups: [string, string[]][] = [
    ["Refused", report.refused],
    ["Warnings", report.warnings],
    ["Passed", report.passed],
  ];
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {groups.map(([label, items]) =>
        items.length > 0 ? (
          <div key={label}>
            <h4>{label}</h4>
            <ul>
              {items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  );
}

function whatIsInside(theme: InstalledTheme): string {
  const parts = [
    plural(theme.layouts, "layout", "layouts"),
    plural(theme.parts, "header or footer", "headers and footers"),
    plural(theme.sections, "section", "sections"),
    plural(theme.fonts, "font", "fonts"),
  ];
  return parts.join(", ");
}

/** Two lines that open more sit one under the other; each is a 24 px target (WCAG 2.2, target size). */
const SUMMARY = { minBlockSize: "24px", lineHeight: "24px" } as const;

export function ThemesScreen({
  initial,
  rtlSite = false,
}: {
  initial: InstalledTheme[];
  /** The site is written right to left (Settings, Languages). */
  rtlSite?: boolean;
}) {
  const [themes, setThemes] = useState(initial);
  // The file is read from the field when the form is sent, so a file chosen while the page was still loading counts.
  const fileField = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<{ title: string; report: PackageReport } | null>(null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // The list of what a switch keeps and leaves behind, shown before the owner confirms.
  const [review, setReview] = useState<{ id: string; plan: ThemeSwitchPlan } | null>(null);
  // "Add the sample pages as drafts": off until the owner ticks it, and off again for every new switch.
  const [addStarter, setAddStarter] = useState(false);
  const active = themes.find((t) => t.isActive) ?? null;
  // The upload sits in a dialog; it stays open while a file is refused, so the report is read where the file was chosen.
  const [installing, setInstalling] = useState(false);

  async function refresh() {
    const response = await fetch("/api/admin/themes");
    const body = (await response.json().catch(() => null)) as { themes?: InstalledTheme[] } | null;
    if (response.ok && body?.themes) setThemes(body.themes);
  }

  async function run(work: () => Promise<string>) {
    setProblem(null);
    setNote("Working…");
    try {
      const done = await work();
      await refresh();
      setNote(done);
    } catch (error) {
      setNote("");
      setProblem((error as Error).message);
    }
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    const file = fileField.current?.files?.[0];
    if (!file) {
      setProblem("Choose a theme file first.");
      return;
    }
    setReport(null);
    if (file.size > MAX_BYTES) {
      setProblem("This file is too large for a theme (24 MB at most).");
      return;
    }
    await run(async () => {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/admin/themes", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as {
        change?: "new" | "update" | "same";
        theme?: InstalledTheme;
        report?: PackageReport | null;
      } | null;
      if (body?.report) setReport({ title: `Report for ${file.name}`, report: body.report });
      if (!response.ok) throw new Error(failure(body, "The theme could not be installed."));
      setInstalling(false);
      const theme = body?.theme;
      if (!theme) return "Done.";
      if (body?.change === "same") return `${theme.name} ${theme.version} is already installed.`;
      if (body?.change === "update")
        return theme.isActive
          ? `${theme.name} is now version ${theme.version}. Your site uses it now.`
          : `${theme.name} is now version ${theme.version}.`;
      return `${theme.name} ${theme.version} is installed. It is not in use yet.`;
    });
  }

  async function looksAt(id: string) {
    setProblem(null);
    setNote("");
    const response = await fetch(`/api/admin/themes/${encodeURIComponent(id)}`);
    const body = (await response.json().catch(() => null)) as { plan?: ThemeSwitchPlan } | null;
    if (!response.ok || !body?.plan) {
      setProblem(failure(body, "The list could not be made."));
      return;
    }
    setAddStarter(false);
    setReview({ id, plan: body.plan });
  }

  const post = async (
    id: string,
    action: "use" | "roll-back",
    fallback: string,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const response = await fetch(`/api/admin/themes/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(failure(body, fallback));
    return body;
  };

  // The theme in use is drawn first and large; the others sit in a grid under it.
  const ordered = [...themes].sort((a, b) => Number(b.isActive) - Number(a.isActive));
  const alerts = problem ? <Alert color="danger" title="Not done" description={problem} /> : null;

  return (
    <div className="oks-themes">
      <div className="oks-list-head">
        <p className="oks-list-summary">
          A theme sets how your whole site looks. Your pages and posts stay the same when you
          switch.
        </p>
        <div className="oks-list-actions">
          <Button
            onPress={() => {
              setProblem(null);
              setReport(null);
              setInstalling(true);
            }}
          >
            Install from a file
          </Button>
        </div>
      </div>

      {installing ? null : alerts}
      <p className="oks-status-line" role="status">
        {note}
      </p>
      {report && !installing ? (
        <div className="oks-theme-panel">
          <Report title={report.title} report={report.report} />
        </div>
      ) : null}

      {review ? (
        <section aria-labelledby="themes-switch" className="oks-theme-panel">
          <h2 id="themes-switch">Before you switch</h2>
          <SwitchPlan plan={review.plan} />
          {starterOf(themes, review.id) > 0 ? (
            <p>
              <label>
                <input
                  type="checkbox"
                  checked={addStarter}
                  onChange={(event) => setAddStarter(event.target.checked)}
                />{" "}
                {`Add the ${plural(starterOf(themes, review.id), "sample page", "sample pages")} as drafts`}
              </label>
              <br />
              <small>They are new drafts. None of your pages is changed.</small>
            </p>
          ) : null}
          <div className="oks-detail-actions">
            <Button
              color="primary"
              onPress={() =>
                void run(async () => {
                  const { id, plan } = review;
                  const body = (await post(
                    id,
                    "use",
                    "The theme could not be used.",
                    id !== "default" && addStarter ? { starter: true } : {},
                  )) as { starterAdded?: number } | null;
                  setReview(null);
                  const added = body?.starterAdded ?? 0;
                  const extra =
                    added > 0
                      ? ` ${plural(added, "sample page was", "sample pages were")} added as drafts.`
                      : "";
                  return id === "default"
                    ? "Your site uses the built-in design now."
                    : `Your site uses ${plan.to.name} now.${extra}`;
                })
              }
            >
              {review.id === "default"
                ? "Yes, switch to the built-in design"
                : `Yes, switch to ${review.plan.to.name}`}
            </Button>
            <Button onPress={() => setReview(null)}>Not now</Button>
          </div>
        </section>
      ) : null}

      {active ? null : (
        <section aria-labelledby="themes-in-use" className="oks-theme-card oks-theme-active">
          <div className="oks-theme-shot" aria-hidden="true" />
          <div className="oks-theme-about">
            <div className="oks-theme-title">
              <h2 id="themes-in-use">The built-in design</h2>
              <span className="oks-chip" data-status="published">
                Active
              </span>
            </div>
            <p>Your site has no theme in use.</p>
            <div className="oks-detail-actions">
              <a className="oks-link-button oks-link-main" href="/admin/settings/look">
                Customise
              </a>
              <a className="oks-link-button" href="/admin/menus">
                Menus
              </a>
            </div>
          </div>
        </section>
      )}

      <section aria-labelledby="themes-installed">
        <h2 id="themes-installed" className="oks-themes-heading">
          Installed themes
        </h2>
        {themes.length === 0 ? <p>No themes are installed yet.</p> : null}
        <ul className="oks-theme-grid">
          {ordered.map((theme) => (
            <li
              key={theme.id}
              className={`oks-theme-card${theme.isActive ? " oks-theme-active" : ""}`}
            >
              <div className="oks-theme-shot" aria-hidden="true">
                {theme.name.charAt(0).toUpperCase()}
              </div>
              <div className="oks-theme-about">
                <div className="oks-theme-title">
                  <h3>
                    {theme.name} <span>{theme.version}</span>
                  </h3>
                  {theme.isActive ? (
                    <span className="oks-chip" data-status="published">
                      Active
                    </span>
                  ) : null}
                </div>
                {theme.description ? <p>{theme.description}</p> : null}
                <p className="oks-theme-small">
                  {theme.author ? `By ${theme.author}. ` : ""}
                  {theme.license ? `Licence: ${theme.license}. ` : ""}
                  {theme.rtl === "supported"
                    ? "Tested for right-to-left languages."
                    : "Not tested for right-to-left languages."}
                </p>
                {rtlSite && theme.rtl !== "supported" ? (
                  <Alert
                    color="warning"
                    title="Check this theme first"
                    description={`Your site is written from right to left, and ${theme.name} was not tested for that. Use "Try ${theme.name} with my content" to look at your pages before you use it.`}
                  />
                ) : null}
                <p className="oks-theme-small">{whatIsInside(theme)}.</p>
                {theme.presets.length > 0 || theme.starterPages > 0 ? (
                  <p className="oks-theme-small">
                    {theme.presets.length > 0
                      ? `Looks to start from: ${theme.presets.map((p) => p.name).join(", ")}. `
                      : ""}
                    {theme.starterPages > 0
                      ? `${plural(theme.starterPages, "sample page", "sample pages")} you can add as drafts.`
                      : ""}
                  </p>
                ) : null}
                <div className="oks-detail-actions">
                  {theme.isActive ? (
                    <>
                      <a className="oks-link-button oks-link-main" href="/admin/settings/look">
                        Customise
                      </a>
                      <a className="oks-link-button" href="/admin/settings/site-editor">
                        Site editor
                      </a>
                      <a className="oks-link-button" href="/admin/menus">
                        Menus
                      </a>
                      <Button onPress={() => void looksAt("default")}>
                        Use the built-in design
                      </Button>
                    </>
                  ) : (
                    <Button color="primary" onPress={() => void looksAt(theme.id)}>
                      {`Use ${theme.name}`}
                    </Button>
                  )}
                  <a className="oks-link-button" href={`/admin/themes/${theme.id}/preview`}>
                    {`Try ${theme.name} with my content`}
                  </a>
                  {theme.previousVersion ? (
                    <Button
                      onPress={() =>
                        void run(async () => {
                          await post(theme.id, "roll-back", "It could not go back.");
                          return `${theme.name} is back to version ${theme.previousVersion}.`;
                        })
                      }
                    >
                      {`Go back to version ${theme.previousVersion}`}
                    </Button>
                  ) : null}
                  {theme.isActive ? null : removing === theme.id ? (
                    <>
                      <Button
                        color="danger"
                        onPress={() =>
                          void run(async () => {
                            setRemoving(null);
                            const response = await fetch(
                              `/api/admin/themes/${encodeURIComponent(theme.id)}`,
                              { method: "DELETE" },
                            );
                            const body: unknown = await response.json().catch(() => null);
                            if (!response.ok)
                              throw new Error(failure(body, "The theme could not be removed."));
                            return `${theme.name} is removed.`;
                          })
                        }
                      >
                        {`Yes, remove ${theme.name}`}
                      </Button>
                      <Button onPress={() => setRemoving(null)}>Keep it</Button>
                    </>
                  ) : (
                    <Button onPress={() => setRemoving(theme.id)}>{`Remove ${theme.name}`}</Button>
                  )}
                </div>
                <details>
                  <summary style={SUMMARY}>{`Export ${theme.name} as a theme`}</summary>
                  <p>
                    A theme file of {theme.name} as your site shows it now: your layout changes, the
                    layouts you made, your saved sections, your colors, fonts and CSS. Drafts are
                    left out. It installs on another site; here it would be a new theme.
                  </p>
                  <form
                    method="get"
                    action={`/api/admin/themes/${encodeURIComponent(theme.id)}/export`}
                  >
                    <label htmlFor={`export-name-${theme.id}`}>Name of the new theme</label>
                    <br />
                    <input
                      id={`export-name-${theme.id}`}
                      name="name"
                      defaultValue={`${theme.name} (custom)`}
                      maxLength={60}
                      style={{ minBlockSize: "32px" }}
                    />{" "}
                    <Button type="submit">Download the theme file</Button>
                  </form>
                </details>
                <details>
                  <summary style={SUMMARY}>{`Report for ${theme.name} ${theme.version}`}</summary>
                  <Report title={`What was checked in ${theme.name}`} report={theme.report} />
                </details>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <Modal
        isOpen={installing}
        onClose={() => setInstalling(false)}
        title="Install a theme from a file"
      >
        {installing ? alerts : null}
        <form onSubmit={(event) => void upload(event)} className="oks-add-plugin">
          <label className="oks-field-block" htmlFor="theme-file">
            <span>Theme file (.tgz)</span>
          </label>
          <input
            id="theme-file"
            type="file"
            accept=".tgz,.gz,application/gzip"
            aria-describedby="theme-file-hint"
            style={{ minBlockSize: "36px" }}
            ref={fileField}
          />
          <p id="theme-file-hint" className="oks-theme-small">
            Every file is checked before anything is stored, and you see a report. A new theme is
            not used until you choose it. A new version of the theme in use is used at once, and you
            can go back to the version before.
          </p>
          <Button color="primary" type="submit">
            Upload and check
          </Button>
        </form>
        {report && installing ? <Report title={report.title} report={report.report} /> : null}
      </Modal>
    </div>
  );
}
