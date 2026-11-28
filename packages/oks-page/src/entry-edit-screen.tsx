"use client";
// The edit screen: title, address, status and the editor. Saving sends everything and learns the new revision.
import { EntryEditor, LayoutEditor, Modal } from "@oks-page/admin";
import type { FieldDef, InsertableSection } from "@oks-page/core";
import { utcToZonedLocal, zonedLocalToUtc } from "@oks-page/core/timezone";
import { Alert, Button, RadioGroupField, TextField } from "oks-ui";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { Block } from "oks-ui";
import {
  AutosaveStatus,
  EditingNotice,
  UnsavedCopyBanner,
  useAutosave,
  useEditingNotice,
  useUnsavedCopy,
} from "./entry-editing";
import { allIds, copyWithNewIds, newBlockId, type LayoutBlock } from "./layout-tree";
import { EntryAccessibility } from "./entry-accessibility";
import { EntryRevisions } from "./entry-revisions";
import { EntryPreview } from "./entry-preview";
import { EntryLayoutPanel } from "./entry-layout-panel";
import { EntrySeoPanel } from "./entry-seo-panel";
import { EntryTermsPanel } from "./entry-terms-panel";
import { uploadForEditor } from "./media-client";
import { MediaPicker } from "./media-picker";
import { PictureField } from "./picture-field";
import { RelationField } from "./relation-field";
import { useInBrowser } from "./time-format";

export interface EntryEditScreenProps {
  id: string;
  title: string;
  slugPart: string;
  prefix: string;
  status: string;
  /** When a scheduled entry goes live (ISO time), or null. */
  scheduledAt: string | null;
  revision: number;
  blocks: Block[];
  /** The saved sections that page content can hold. */
  savedSections?: InsertableSection[];
  canPublish: boolean;
  /** The page is live and this person may change it but not publish or unpublish: it stays live, and saving is final. */
  liveEdit?: boolean;
  canTrash: boolean;
  /** Which editor this entry opens in (spec 06, section 13). */
  editor?: "writing" | "layout";
  /** Whether this person may lock parts of a page (a designer). */
  canLock?: boolean;
  /** The screen sizes that are on for the site (Settings > Screen sizes). */
  screens?: string[];
  /** The blocks that plugins add (spec 04, section 8), for the layout editor's list. */
  pluginBlocks?: ComponentProps<typeof LayoutEditor>["pluginBlocks"];
  /** Posts have categories and tags; pages do not. */
  showTerms?: boolean;
  /** Where the list this entry belongs to is ("/admin/pages"). */
  listHref: string;
  /** The custom fields of this entry's type, and the values saved in them (a custom content type). */
  fieldDefs?: FieldDef[];
  fieldValues?: Record<string, unknown>;
  /** The site's time zone, or null when it is automatic (each person's own browser). */
  timeZone?: string | null;
}

interface SaveReply {
  revision?: number;
  repairs?: string[];
  slug?: string;
  error?: {
    message: string;
    code?: string;
    problems?: { rule: string; message: string }[];
    canPublishAnyway?: boolean;
  };
}

/**
 * An ISO time as the value of a datetime-local box, and back. The box is in the site's time zone; a site that has not
 * chosen one ("automatic") uses this browser's own zone.
 */
const zoneOf = (timeZone: string | null): string =>
  timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
function toLocalInput(iso: string | null, timeZone: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : utcToZonedLocal(ms, zoneOf(timeZone));
}
function fromLocalInput(value: string, timeZone: string | null): string | null {
  const ms = zonedLocalToUtc(value, zoneOf(timeZone));
  return ms === null ? null : new Date(ms).toISOString();
}

/** "Saved section": choose one, then place a copy (changed here only) or a link (the same everywhere). */
function InsertSection({
  sections,
  insertBlocks,
}: {
  sections: InsertableSection[];
  insertBlocks: (blocks: Block[]) => void;
}) {
  const [id, setId] = useState("");
  if (sections.length === 0) return null;
  const chosen = sections.find((s) => s.id === id);
  const copy = () => {
    if (!chosen) return;
    const taken = allIds(chosen.blocks as unknown as LayoutBlock[]);
    insertBlocks(
      (chosen.blocks as unknown as LayoutBlock[]).map(
        (b) => copyWithNewIds(b, taken) as unknown as Block,
      ),
    );
  };
  const link = () => {
    if (!chosen) return;
    insertBlocks([
      {
        id: newBlockId(),
        type: "linked-section",
        props: { id: chosen.id },
        content: null,
        children: [],
      },
    ] as unknown as Block[]);
  };
  return (
    <span role="group" aria-label="Insert a saved section">
      <label>
        Saved section{" "}
        <select value={id} onChange={(event) => setId(event.target.value)}>
          <option value="">Choose one…</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>{" "}
      <Button isDisabled={!chosen} onPress={copy}>
        Insert as a copy
      </Button>{" "}
      <Button isDisabled={!chosen} onPress={link}>
        Insert linked
      </Button>
      <small>
        {" "}
        Copy: change it here only. Linked: the same everywhere; to change it, go to Design.
      </small>
    </span>
  );
}

/**
 * The "Insert image from the library" button and its window. A picture that has no description
 * yet first asks for one, so the publish check has nothing to stop later.
 */
function InsertFromLibrary({ insertImage }: { insertImage: (src: string, alt: string) => void }) {
  const [open, setOpen] = useState(false);
  const [needs, setNeeds] = useState<{ url: string } | null>(null);
  const [words, setWords] = useState("");
  const finish = (alt: string) => {
    if (needs) insertImage(needs.url, alt.trim());
    setNeeds(null);
    setWords("");
  };
  return (
    <>
      <Button onPress={() => setOpen(true)}>Insert image from the library</Button>
      <MediaPicker
        isOpen={open}
        onClose={() => setOpen(false)}
        onPick={(item) => {
          setOpen(false);
          if (item.alt.trim()) insertImage(item.url, item.alt);
          else setNeeds({ url: item.url });
        }}
      />
      <Modal isOpen={needs !== null} onClose={() => finish("")} title="Describe this picture">
        <p>
          A short description lets people who cannot see the picture know what it shows. You can
          also leave it empty and add it later; the page cannot go live with a picture that has
          none, unless an administrator allows it.
        </p>
        <TextField label="Describe the picture" value={words} onChange={setWords} />
        <p>
          <Button color="primary" isDisabled={!words.trim()} onPress={() => finish(words)}>
            Insert picture
          </Button>{" "}
          <Button onPress={() => finish("")}>Insert without a description</Button>
        </p>
      </Modal>
    </>
  );
}

/** The blocks with one picture marked as decoration (found at any depth). */
function markDecorative(blocks: { id: string }[], blockId: string): unknown[] {
  return blocks.map((b) => {
    const block = b as { id: string; props?: Record<string, unknown>; children?: { id: string }[] };
    const children = block.children ? markDecorative(block.children, blockId) : block.children;
    return block.id === blockId
      ? { ...block, props: { ...block.props, decorative: true }, children }
      : { ...block, children };
  });
}

type LayoutBlocks = ComponentProps<typeof LayoutEditor>["initialBlocks"];

/**
 * The switch between the two editors. It saves what is on the screen first, then asks the server; going to the writing
 * editor lists in plain words what would be lost and waits for a yes.
 */
function EditorSwitch({
  id,
  to,
  save,
}: {
  id: string;
  to: "writing" | "layout";
  save: () => Promise<unknown>;
}) {
  const [lost, setLost] = useState<string[] | null>(null);
  const [problem, setProblem] = useState("");
  async function go(anyway: boolean) {
    setProblem("");
    try {
      await save();
    } catch {
      return; // the screen shows why it did not save
    }
    const response = await fetch(`/api/admin/entries/${id}/editor`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editor: to, ...(anyway ? { anyway: true } : {}) }),
    });
    const body = (await response.json()) as {
      error?: { code?: string; message: string; lost?: string[] };
    };
    if (response.ok) return window.location.reload();
    if (body.error?.code === "would_lose" && body.error.lost) return setLost(body.error.lost);
    setProblem(body.error?.message ?? "It could not be switched.");
  }
  return (
    <>
      <Button onPress={() => void go(false)}>
        {to === "layout" ? "Switch to the layout editor" : "Switch to the writing editor"}
      </Button>
      {problem ? <span role="alert"> {problem}</span> : null}
      <Modal
        isOpen={lost !== null}
        onClose={() => setLost(null)}
        role="alertdialog"
        title="Switch to the writing editor?"
        actions={
          <>
            <Button onPress={() => setLost(null)}>Keep the layout</Button>
            <Button color="danger" onPress={() => void go(true)}>
              Switch anyway
            </Button>
          </>
        }
      >
        <p>The writing editor has no layout. If you switch:</p>
        <ul>
          {(lost ?? []).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p>A copy of the page as it is now is kept in its revisions, so you can bring it back.</p>
      </Modal>
    </>
  );
}

export function EntryEditScreen(props: EntryEditScreenProps) {
  const [title, setTitle] = useState(props.title);
  const [slugPart, setSlugPart] = useState(props.slugPart);
  const [status, setStatus] = useState(
    props.status === "published" || props.status === "scheduled" || props.status === "pending"
      ? props.status
      : "draft",
  );
  // What the person typed; until then the box shows the saved time. Without a zone of the site that time is only known in
  // the browser.
  const [typedAt, setScheduledAt] = useState<string | null>(null);
  const inBrowser = useInBrowser();
  const scheduledAt =
    typedAt ??
    (props.timeZone || inBrowser ? toLocalInput(props.scheduledAt, props.timeZone ?? null) : "");
  const defs = props.fieldDefs ?? [];
  const [values, setValues] = useState<Record<string, unknown>>(props.fieldValues ?? {});
  const revision = useRef(props.revision);
  const [revisionNo, setRevisionNo] = useState(props.revision);
  const [trashing, setTrashing] = useState(false);
  // Autosave: a counter that goes up with every change, and the latest content to send.
  const [changes, setChanges] = useState(0);
  const blocksNow = useRef(props.blocks);
  // The editor's way to replace its content, kept for the buttons outside it (the accessibility check).
  const replaceBlocksNow = useRef<((blocks: Block[]) => void) | null>(null);
  const typed = useRef({ title, slugPart });
  typed.current = { title, slugPart };
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setChanges((n) => n + 1);
  }, [title, slugPart]);
  const keptAt = useAutosave(
    props.id,
    () => ({ ...typed.current, blocks: blocksNow.current, revision: revision.current }),
    changes,
  );
  const [unsaved, forgetUnsaved] = useUnsavedCopy(props.id);
  const otherEditor = useEditingNotice(props.id);

  async function moveToTrash() {
    setProblem(null);
    try {
      const response = await fetch(`/api/admin/entries/${props.id}`, { method: "DELETE" });
      if (response.ok) {
        window.location.assign(props.listHref);
        return;
      }
      const body = (await response.json()) as { error?: { message: string } };
      setProblem(body.error?.message ?? "It could not be moved to the trash.");
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
    }
    setTrashing(false);
  }
  const [problem, setProblem] = useState<string | null>(null);
  // What is missing before the page may go live (the publish check), and whether this person may go on anyway.
  const [check, setCheck] = useState<{
    problems: { rule: string; message: string }[];
    canPublishAnyway: boolean;
  } | null>(null);
  const [note, setNote] = useState("");

  async function send(blocks: Block[], publishAnyway: boolean) {
    setProblem(null);
    const response = await fetch(`/api/admin/entries/${props.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        slugPart,
        status,
        scheduledAt:
          status === "scheduled" ? fromLocalInput(scheduledAt, props.timeZone ?? null) : null,
        blocks,
        revision: revision.current,
        ...(defs.length > 0 ? { fields: values } : {}),
        ...(publishAnyway ? { publishAnyway: true } : {}),
      }),
    });
    const body = (await response.json()) as SaveReply;
    if (!response.ok) {
      if (body.error?.code === "publish_check" && body.error.problems) {
        setCheck({
          problems: body.error.problems,
          canPublishAnyway: body.error.canPublishAnyway === true,
        });
        throw new Error("it needs a few things before it goes live; see the list above");
      }
      const message = body.error?.message ?? "Saving did not work.";
      setProblem(message);
      throw new Error(message);
    }
    setCheck(null);
    revision.current = body.revision ?? revision.current;
    setRevisionNo(revision.current);
    return { repairs: body.repairs ?? [] };
  }

  return (
    <>
      <EditingNotice name={otherEditor} />
      {problem ? <Alert color="danger" title="Not saved" description={problem} /> : null}
      {check ? (
        <div role="alert" aria-label="Before this goes live">
          <strong>Before this goes live</strong>
          <ul>
            {check.problems.map((p) => (
              <li key={p.rule + p.message}>{p.message}</li>
            ))}
          </ul>
          {check.canPublishAnyway ? (
            <p>
              <Button
                color="danger"
                onPress={() =>
                  void send(blocksNow.current, true).then(
                    () => setNote("Published anyway. This was written to the log."),
                    () => undefined,
                  )
                }
              >
                Publish anyway
              </Button>{" "}
              <small>Only administrators can. It is written to the log.</small>
            </p>
          ) : (
            <p>
              <small>Fix these, or keep it as a draft. An administrator can publish anyway.</small>
            </p>
          )}
        </div>
      ) : null}
      {note ? <p role="status">{note}</p> : null}
      <div className="oks-edit">
        <div className="oks-edit-main">
          <TextField name="title" label="Title" required value={title} onChange={setTitle} />
          {props.editor === "layout" ? (
            <LayoutEditor
              label="Content"
              initialBlocks={props.blocks as unknown as LayoutBlocks}
              canLock={props.canLock === true}
              {...(props.screens ? { screens: props.screens } : {})}
              {...(props.pluginBlocks ? { pluginBlocks: props.pluginBlocks } : {})}
              onChange={(next) => {
                blocksNow.current = next as unknown as Block[];
                setChanges((n) => n + 1);
              }}
              registerReplace={(replace) => {
                replaceBlocksNow.current = (blocks) => replace(blocks as unknown as LayoutBlocks);
              }}
              onSave={(blocks) => send(blocks as unknown as Block[], false)}
              toolbar={
                <>
                  <EditorSwitch
                    id={props.id}
                    to="writing"
                    save={() => send(blocksNow.current, false)}
                  />
                  <UnsavedCopyBanner
                    copy={unsaved}
                    timeZone={props.timeZone ?? null}
                    onBringBack={(copy) => {
                      setTitle(copy.title);
                      replaceBlocksNow.current?.(copy.blocks);
                      blocksNow.current = copy.blocks;
                      forgetUnsaved();
                    }}
                    onThrowAway={() => {
                      forgetUnsaved();
                      void fetch(`/api/admin/entries/${props.id}/autosave`, { method: "DELETE" });
                    }}
                  />
                </>
              }
            />
          ) : (
            <>
              <p>
                <small>Simple page: written in the writing editor. </small>
                <EditorSwitch
                  id={props.id}
                  to="layout"
                  save={() => send(blocksNow.current, false)}
                />
              </p>
              <EntryEditor
                label="Content"
                initialBlocks={props.blocks}
                onImageUpload={uploadForEditor}
                onFileUpload={uploadForEditor}
                onVideoUpload={uploadForEditor}
                onBlocksChange={(next) => {
                  blocksNow.current = next;
                  setChanges((n) => n + 1);
                }}
                savedSections={(props.savedSections ?? []).map(({ id, name }) => ({ id, name }))}
                toolbar={({ insertImage, insertBlocks, replaceBlocks }) => {
                  replaceBlocksNow.current = replaceBlocks;
                  return (
                    <>
                      <InsertFromLibrary insertImage={insertImage} />
                      <InsertSection
                        sections={props.savedSections ?? []}
                        insertBlocks={insertBlocks}
                      />
                      <UnsavedCopyBanner
                        copy={unsaved}
                        timeZone={props.timeZone ?? null}
                        onBringBack={(copy) => {
                          setTitle(copy.title);
                          replaceBlocks(copy.blocks);
                          forgetUnsaved();
                        }}
                        onThrowAway={() => {
                          forgetUnsaved();
                          void fetch(`/api/admin/entries/${props.id}/autosave`, {
                            method: "DELETE",
                          });
                        }}
                      />
                    </>
                  );
                }}
                onSave={(blocks) => send(blocks, false)}
              />
            </>
          )}
          {defs.length > 0 ? (
            <fieldset aria-label="Details" style={{ margin: "1rem 0" }}>
              <legend>
                <strong>Details</strong>
              </legend>
              {defs.map((d) => (
                <p key={d.key}>
                  {d.type === "true / false" ? (
                    <label>
                      <input
                        type="checkbox"
                        checked={values[d.key] === true}
                        onChange={(event) =>
                          setValues({ ...values, [d.key]: event.target.checked })
                        }
                      />{" "}
                      {d.label}
                    </label>
                  ) : d.type === "relation" ? (
                    <span role="group" aria-label={d.label}>
                      {d.label}
                      {d.required ? " (required)" : ""}
                      <br />
                      <RelationField
                        label={d.label}
                        target={d.target ?? ""}
                        value={typeof values[d.key] === "string" ? (values[d.key] as string) : ""}
                        onChange={(id) => setValues({ ...values, [d.key]: id })}
                      />
                    </span>
                  ) : d.type === "picture" ? (
                    <span role="group" aria-label={d.label}>
                      {d.label}
                      {d.required ? " (required)" : ""}
                      <br />
                      <PictureField
                        label={d.label}
                        value={typeof values[d.key] === "string" ? (values[d.key] as string) : ""}
                        onChange={(id) => setValues({ ...values, [d.key]: id })}
                      />
                    </span>
                  ) : (
                    <label>
                      {d.label}
                      {d.required ? " (required)" : ""}
                      <br />
                      {d.type === "long text" ? (
                        <textarea
                          rows={4}
                          style={{ inlineSize: "100%", maxInlineSize: "40rem" }}
                          value={typeof values[d.key] === "string" ? (values[d.key] as string) : ""}
                          onChange={(event) =>
                            setValues({ ...values, [d.key]: event.target.value })
                          }
                        />
                      ) : (
                        <input
                          type={
                            d.type === "number" ? "number" : d.type === "date" ? "date" : "text"
                          }
                          step={d.type === "number" ? "any" : undefined}
                          value={
                            typeof values[d.key] === "string" || typeof values[d.key] === "number"
                              ? String(values[d.key])
                              : ""
                          }
                          onChange={(event) =>
                            setValues({ ...values, [d.key]: event.target.value })
                          }
                        />
                      )}
                    </label>
                  )}
                </p>
              ))}
            </fieldset>
          ) : null}
          <EntryAccessibility
            blocks={blocksNow.current}
            onMarkDecorative={(blockId) =>
              replaceBlocksNow.current?.(
                markDecorative(blocksNow.current as { id: string }[], blockId) as Block[],
              )
            }
          />
          <EntryPreview id={props.id} />
        </div>
        <aside className="oks-edit-side" aria-label="Settings for this page">
          <section className="oks-side-card">
            <h2>Status and visibility</h2>
            {props.liveEdit ? (
              <p>
                <strong>This page is live.</strong> When you save, your changes go live at once, and
                the people who look after the site are told. They can put the earlier version back.
              </p>
            ) : props.canPublish ? (
              <RadioGroupField
                name="status"
                label="Status"
                options={[
                  { label: "Draft (only you see it)", value: "draft" },
                  { label: "Waiting for review (an editor looks at it)", value: "pending" },
                  { label: "Scheduled (goes live at the time you choose)", value: "scheduled" },
                  { label: "Published (everyone sees it)", value: "published" },
                ]}
                value={status}
                onChange={(value: string) => setStatus(value)}
              />
            ) : (
              <RadioGroupField
                name="status"
                label="Status"
                options={[
                  { label: "Draft (only you see it)", value: "draft" },
                  {
                    label: "Waiting for review (an editor looks at it, and publishes it)",
                    value: "pending",
                  },
                ]}
                value={status === "pending" ? "pending" : "draft"}
                onChange={(value: string) => setStatus(value)}
              />
            )}
            {props.canPublish && status === "scheduled" ? (
              <div>
                <label htmlFor="scheduled-at">Publish at</label>
                <input
                  id="scheduled-at"
                  name="scheduledAt"
                  type="datetime-local"
                  required
                  value={scheduledAt}
                  onChange={(event) => setScheduledAt(event.target.value)}
                  aria-describedby="scheduled-at-help"
                />
                <p id="scheduled-at-help">
                  {props.timeZone
                    ? `The time in ${props.timeZone.replace(/_/g, " ")}.`
                    : "The time on your own clock."}{" "}
                  The page goes live then, with your permission.
                </p>
              </div>
            ) : null}
          </section>
          <section className="oks-side-card">
            <h2>Address</h2>
            <TextField
              name="slug"
              label="Address"
              description={`The address of this page: /${props.prefix}${slugPart}`}
              required
              value={slugPart}
              onChange={setSlugPart}
            />
          </section>
          {props.showTerms ? <EntryTermsPanel id={props.id} /> : null}
          <EntryLayoutPanel id={props.id} />
          <EntrySeoPanel id={props.id} />
          <AutosaveStatus savedAt={keptAt} timeZone={props.timeZone ?? null} />
          <EntryRevisions id={props.id} revision={revisionNo} timeZone={props.timeZone ?? null} />
          {props.canTrash ? (
            <p>
              <Button color="danger" onPress={() => setTrashing(true)}>
                Move to trash
              </Button>
            </p>
          ) : null}
        </aside>
      </div>
      <Modal
        isOpen={trashing}
        onClose={() => setTrashing(false)}
        role="alertdialog"
        title="Move to the trash?"
        actions={
          <>
            <Button onPress={() => setTrashing(false)}>Cancel</Button>
            <Button color="danger" onPress={() => void moveToTrash()}>
              Move to trash
            </Button>
          </>
        }
      >
        <p>
          “{title}” leaves the site at once. It stays in the trash for 30 days, and you can restore
          it from there.
        </p>
      </Modal>
    </>
  );
}
