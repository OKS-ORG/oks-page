"use client";
// The consent notice (spec 18, section 2). It asks the site whether anything needs consent; when nothing does, it draws
// nothing at all (no notice, no link, no cookie, no storage). When something does, it shows Accept all and Refuse all with
// the same weight and a choice for each purpose, remembers the choice in the visitor's browser for six months, keeps a
// record of it on the site (nothing that points to a person), and leaves a "Privacy choices" button so the visitor can
// change it at any time. Videos set to load at once load only after "videos and maps" were accepted.
import { useEffect, useRef, useState } from "react";
import { loadConsentedVideos } from "./block-behaviour";
import { readChoice, STORE_KEY, writeChoice } from "./consent-choice";

interface Info {
  needed: boolean;
  purposes: string[];
  version: string;
}

const WORDS: Record<string, { name: string; what: string }> = {
  statistics: { name: "Statistics", what: "Counts and measures how the site is used." },
  media: {
    name: "Videos and maps",
    what: "Shows content from other companies, such as videos and maps. They learn that you visited.",
  },
  marketing: {
    name: "Marketing",
    what: "Lets other companies show or measure advertising.",
  },
};

// The same style for every button, so that no answer is made to look like the better one.
const BUTTON: React.CSSProperties = {
  minBlockSize: "44px",
  minInlineSize: "44px",
  paddingInline: "1rem",
  font: "inherit",
  cursor: "pointer",
  color: "inherit",
  background: "transparent",
  border: "2px solid currentColor",
  borderRadius: "0.4rem",
};

function remember(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** What the page does with a choice: videos set to load at once may load, and anything listening is told. */
function apply(accepted: string[]): void {
  if (accepted.includes("media")) document.documentElement.dataset["consentMedia"] = "1";
  else delete document.documentElement.dataset["consentMedia"];
  loadConsentedVideos();
  window.dispatchEvent(new CustomEvent("oks-consent", { detail: { accepted } }));
}

export function ConsentNotice() {
  const [info, setInfo] = useState<Info | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const reopened = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch("/api/privacy/consent", { credentials: "same-origin" });
        if (!response.ok) return;
        const found = (await response.json()) as Info;
        if (!alive || !found.needed) return;
        const stored = readChoice(
          remember()?.getItem(STORE_KEY) ?? null,
          found.version,
          Date.now(),
        );
        setInfo(found);
        if (stored) {
          setPicked(stored.accepted);
          apply(stored.accepted);
        } else setOpen(true);
      } catch {
        // No answer (a static copy of the site, or no connection): nothing is loaded that needs consent, so nothing is asked.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (open && reopened.current) heading.current?.focus();
  }, [open]);

  if (!info?.needed) return null;

  function save(accepted: string[]) {
    if (!info) return;
    const before = picked;
    try {
      remember()?.setItem(STORE_KEY, writeChoice(accepted, info.version, Date.now()));
    } catch {
      // The browser does not let the page remember: the choice holds for this page only.
    }
    void fetch("/api/privacy/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accepted, version: info.version }),
      keepalive: true,
    }).catch(() => undefined);
    setPicked(accepted);
    setOpen(false);
    apply(accepted);
    // Taking back something that was accepted reloads the page, so what it loaded is gone.
    if (before.some((p) => !accepted.includes(p))) window.location.reload();
  }

  if (!open)
    return (
      <p style={{ margin: "1rem" }}>
        <button
          type="button"
          style={BUTTON}
          onClick={() => {
            reopened.current = true;
            setOpen(true);
          }}
        >
          Privacy choices
        </button>
      </p>
    );

  return (
    <section
      role="region"
      aria-labelledby="oks-consent-title"
      style={{
        position: "fixed",
        insetInline: 0,
        insetBlockEnd: 0,
        zIndex: 2147483000,
        maxBlockSize: "80vh",
        overflowY: "auto",
        padding: "1rem",
        background: "Canvas",
        color: "CanvasText",
        borderBlockStart: "2px solid currentColor",
        boxShadow: "0 -2px 12px rgba(0,0,0,.25)",
      }}
    >
      <h2 id="oks-consent-title" ref={heading} tabIndex={-1} style={{ marginBlock: "0 .5rem" }}>
        Your privacy choices
      </h2>
      <p style={{ marginBlock: "0 .75rem" }}>
        This site would like to use the following. Nothing in this list is used unless you agree,
        and you can change your mind at any time with the “Privacy choices” button.
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 .75rem" }}>
        {info.purposes.map((p) => (
          <li key={p} style={{ marginBlockEnd: ".5rem" }}>
            <label style={{ display: "flex", gap: ".5rem", alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={picked.includes(p)}
                onChange={(event) =>
                  setPicked(event.target.checked ? [...picked, p] : picked.filter((x) => x !== p))
                }
                style={{ inlineSize: "1.25rem", blockSize: "1.25rem", marginBlockStart: ".15rem" }}
              />
              <span>
                <strong>{WORDS[p]?.name ?? p}</strong>
                <br />
                {WORDS[p]?.what ?? ""}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", flexWrap: "wrap", gap: ".75rem" }}>
        <button type="button" style={BUTTON} onClick={() => save(info.purposes)}>
          Accept all
        </button>
        <button type="button" style={BUTTON} onClick={() => save([])}>
          Refuse all
        </button>
        <button
          type="button"
          style={BUTTON}
          onClick={() => save(info.purposes.filter((p) => picked.includes(p)))}
        >
          Save my choices
        </button>
      </div>
    </section>
  );
}
