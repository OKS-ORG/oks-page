"use client";
// What the edit screen does besides saving: it keeps an unsaved copy about 10 seconds after the writer stops typing,
// offers that copy back when the page is opened again, and tells the writer when someone else has the page open.
import { Alert, Button } from "oks-ui";
import { useEffect, useRef, useState } from "react";
import type { Block } from "oks-ui";
import { formatWhen } from "./time-format";

export const AUTOSAVE_MS = 10_000;
const RENEW_MS = 30_000;

export interface UnsavedCopy {
  title: string;
  blocks: Block[];
  savedAt: string;
  revision: number;
}

const clock = (iso: string, timeZone: string | null) => formatWhen(iso, timeZone);

/** Sends the current content to the server 10 seconds after the last change. Returns the time of the last copy kept. */
export function useAutosave(
  id: string,
  current: () => { title: string; slugPart: string; blocks: Block[]; revision: number },
  changes: number,
): string | null {
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    if (changes === 0) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/admin/entries/${id}/autosave`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(latest.current()),
          });
          if (response.ok) setSavedAt(((await response.json()) as { savedAt: string }).savedAt);
        } catch {
          // The next change tries again; nothing is lost that the writer still has on the screen.
        }
      })();
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [id, changes]);
  return savedAt;
}

/** Looks once for an unsaved copy from an earlier visit. */
export function useUnsavedCopy(id: string): [UnsavedCopy | null, () => void] {
  const [copy, setCopy] = useState<UnsavedCopy | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch(`/api/admin/entries/${id}/autosave`);
        if (!response.ok) return;
        const body = (await response.json()) as { autosave: UnsavedCopy | null };
        if (live) setCopy(body.autosave);
      } catch {
        // No copy is offered; the saved page is still there.
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);
  return [copy, () => setCopy(null)];
}

/** Says "I am editing this" every 30 seconds while the screen is open; returns the name of someone else who is. */
export function useEditingNotice(id: string): string | null {
  const [other, setOther] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const renew = async () => {
      try {
        const response = await fetch(`/api/admin/entries/${id}/editing`, { method: "POST" });
        if (!response.ok || !live) return;
        setOther(((await response.json()) as { otherEditor: string | null }).otherEditor);
      } catch {
        // Offline for a moment: the next round tries again.
      }
    };
    void renew();
    const timer = setInterval(() => void renew(), RENEW_MS);
    const leave = () =>
      void fetch(`/api/admin/entries/${id}/editing`, { method: "DELETE", keepalive: true });
    window.addEventListener("pagehide", leave);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [id]);
  return other;
}

export function EditingNotice({ name }: { name: string | null }) {
  return name ? (
    <Alert
      color="warning"
      title={`${name} has this page open too`}
      description="You can both save. If you save second, you will be told if the page changed, and nothing is lost."
    />
  ) : null;
}

export function UnsavedCopyBanner({
  copy,
  onBringBack,
  onThrowAway,
  timeZone = null,
}: {
  copy: UnsavedCopy | null;
  /** The site time zone, or null for the browser own. */
  timeZone?: string | null;
  onBringBack: (copy: UnsavedCopy) => void;
  onThrowAway: () => void;
}) {
  if (!copy) return null;
  return (
    <Alert
      color="info"
      title="You have changes that were not saved"
      description={`We kept a copy from ${clock(copy.savedAt, timeZone)}. The page itself is as you last saved it.`}
      actions={
        <>
          <Button color="primary" size="sm" onPress={() => onBringBack(copy)}>
            Bring them back
          </Button>
          <Button size="sm" onPress={onThrowAway}>
            Throw them away
          </Button>
        </>
      }
    />
  );
}

export function AutosaveStatus({
  savedAt,
  timeZone = null,
}: {
  savedAt: string | null;
  timeZone?: string | null;
}) {
  return (
    <p role="status" id="autosave-status">
      {savedAt ? `Unsaved changes kept as a copy at ${clock(savedAt, timeZone)}.` : ""}
    </p>
  );
}
