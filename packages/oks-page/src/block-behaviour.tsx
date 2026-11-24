"use client";
// The behaviour of three layout blocks (spec 06, 14): tabs show one panel at a time, a slider gets arrows and dots, and a
// gallery picture opens larger. The page is complete without any of this (tabs one under another, slides that scroll,
// pictures in a grid); the script only adds to it, so a visitor without script loses nothing. It adds no other script to
// the page and sends nothing anywhere.
import { useEffect } from "react";

const READY = "data-ready";

/** Tabs: a row of buttons (made from the tab headings), one visible panel, arrow keys to move. */
export function enhanceTabs(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".tabs").forEach((tabs, n) => {
    if (tabs.hasAttribute(READY)) return;
    const panels = Array.from(tabs.querySelectorAll<HTMLElement>(":scope > .tab"));
    if (panels.length === 0) return;
    tabs.setAttribute(READY, "");
    const list = document.createElement("div");
    list.className = "tablist";
    list.setAttribute("role", "tablist");
    const buttons = panels.map((panel, i) => {
      const heading = panel.querySelector(":scope > h3");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab-button";
      button.setAttribute("role", "tab");
      button.id = `oks-tab-${n}-${i}`;
      button.textContent = heading?.textContent || `Tab ${i + 1}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", button.id);
      list.appendChild(button);
      return button;
    });
    const show = (at: number, focus: boolean) => {
      panels.forEach((panel, i) => {
        panel.hidden = i !== at;
        buttons[i]!.setAttribute("aria-selected", i === at ? "true" : "false");
        buttons[i]!.tabIndex = i === at ? 0 : -1;
      });
      if (focus) buttons[at]!.focus();
    };
    buttons.forEach((button, i) => {
      button.addEventListener("click", () => show(i, false));
      button.addEventListener("keydown", (event) => {
        // In a right-to-left page the arrows point the other way.
        const rtl = getComputedStyle(list).direction === "rtl";
        const next = event.key === (rtl ? "ArrowLeft" : "ArrowRight");
        const previous = event.key === (rtl ? "ArrowRight" : "ArrowLeft");
        if (!next && !previous && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const at =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (i + (next ? 1 : -1) + buttons.length) % buttons.length;
        show(at, true);
      });
    });
    tabs.insertBefore(list, tabs.firstChild);
    show(0, false);
  });
}

/** Sliders: previous and next buttons, and one dot for each slide. */
export function enhanceSliders(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".slider").forEach((slider) => {
    if (slider.hasAttribute(READY)) return;
    const slides = Array.from(slider.querySelectorAll<HTMLElement>(":scope > .slide"));
    if (slides.length < 2) return;
    slider.setAttribute(READY, "");
    const controls = document.createElement("div");
    controls.className = "slider-controls";
    const make = (label: string, text: string) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slider-button";
      button.setAttribute("aria-label", label);
      button.textContent = text;
      return button;
    };
    const previous = make("Previous slide", "‹");
    const next = make("Next slide", "›");
    const dots = slides.map((_, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "slider-dot";
      dot.setAttribute("aria-label", `Slide ${i + 1} of ${slides.length}`);
      return dot;
    });
    controls.append(previous, ...dots, next);
    slider.after(controls);
    const current = () => {
      const width = slider.clientWidth || 1;
      return Math.min(
        slides.length - 1,
        Math.max(0, Math.round(Math.abs(slider.scrollLeft) / width)),
      );
    };
    const goTo = (at: number) => {
      const to = Math.min(slides.length - 1, Math.max(0, at));
      const rtl = getComputedStyle(slider).direction === "rtl";
      const left = to * slider.clientWidth * (rtl ? -1 : 1);
      const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      slider.scrollTo({ left, behavior: calm ? "auto" : "smooth" });
    };
    const mark = () => {
      const at = current();
      dots.forEach((dot, i) => {
        if (i === at) dot.setAttribute("aria-current", "true");
        else dot.removeAttribute("aria-current");
      });
      previous.disabled = at === 0;
      next.disabled = at === slides.length - 1;
    };
    previous.addEventListener("click", () => goTo(current() - 1));
    next.addEventListener("click", () => goTo(current() + 1));
    dots.forEach((dot, i) => dot.addEventListener("click", () => goTo(i)));
    slider.addEventListener("scroll", mark, { passive: true });
    mark();
  });
}

let box: HTMLDialogElement | null = null;

/** The larger view of one gallery picture, in a dialog (Escape closes it, arrows move between pictures). */
function openPicture(pictures: HTMLImageElement[], at: number): void {
  if (typeof HTMLDialogElement === "undefined") return;
  if (!box) {
    box = document.createElement("dialog");
    box.className = "oks-lightbox";
    box.setAttribute("aria-label", "Picture");
    box.addEventListener("click", (event) => {
      if (event.target === box) box?.close();
    });
    document.body.appendChild(box);
  }
  const dialog = box;
  let index = at;
  const draw = () => {
    const source = pictures[index]!;
    dialog.replaceChildren();
    const img = document.createElement("img");
    img.src = source.currentSrc || source.src;
    img.alt = source.alt;
    const caption = source.closest("figure")?.querySelector("figcaption")?.textContent;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "oks-lightbox-close";
    close.textContent = "Close";
    close.addEventListener("click", () => dialog.close());
    dialog.append(img);
    if (caption) {
      const text = document.createElement("p");
      text.textContent = caption;
      dialog.append(text);
    }
    if (pictures.length > 1) {
      const step = (by: number) => {
        index = (index + by + pictures.length) % pictures.length;
        draw();
      };
      const back = document.createElement("button");
      back.type = "button";
      back.textContent = "Previous";
      back.addEventListener("click", () => step(-1));
      const forward = document.createElement("button");
      forward.type = "button";
      forward.textContent = "Next";
      forward.addEventListener("click", () => step(1));
      dialog.append(back, forward);
    }
    dialog.append(close);
  };
  draw();
  if (!dialog.open) dialog.showModal();
}

function enhanceGalleries(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".gallery").forEach((gallery) => {
    if (gallery.hasAttribute(READY)) return;
    gallery.setAttribute(READY, "");
    const pictures = Array.from(gallery.querySelectorAll<HTMLImageElement>("img"));
    pictures.forEach((img, i) => {
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.style.cursor = "zoom-in";
      img.setAttribute("aria-label", img.alt ? `Enlarge: ${img.alt}` : `Enlarge picture ${i + 1}`);
      img.addEventListener("click", () => openPicture(pictures, i));
      img.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openPicture(pictures, i);
        }
      });
    });
  });
}

/** The only players a video block may open: the same two privacy-friendly addresses the page draws (spec 06, 14.3). */
const PLAYER =
  /^https:\/\/(www\.youtube-nocookie\.com\/embed|player\.vimeo\.com\/video)\/[\w-]{4,20}$/;

/** A click on a video's picture loads the player in its place; before that nothing is asked of the company. Without
 * script the same link opens the video on the company's own page. */
function openVideo(event: MouseEvent): void {
  const link = (event.target as Element | null)?.closest?.("a.video-open");
  if (!link || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const holder = link.closest<HTMLElement>(".video-load");
  if (!holder || !loadPlayer(holder, true)) return;
  event.preventDefault();
}

/** Puts the player in the place of a video's picture. Returns false (and changes nothing) for an address that is not allowed. */
function loadPlayer(holder: HTMLElement, clicked: boolean): boolean {
  const player = holder.dataset["player"] ?? "";
  if (!PLAYER.test(player)) return false;
  const frame = document.createElement("iframe");
  frame.src = clicked ? `${player}?autoplay=1` : player;
  frame.title = holder.dataset["title"] || "Video";
  frame.allow = "autoplay; fullscreen; picture-in-picture";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  holder.replaceChildren(frame);
  if (clicked) frame.focus();
  return true;
}

/** Videos the owner set to load at once load as soon as the visitor has accepted "videos and maps" (spec 18, section 2). */
export function loadConsentedVideos(root: ParentNode = document): void {
  if (document.documentElement.dataset["consentMedia"] !== "1") return;
  root.querySelectorAll<HTMLElement>('.video-load[data-consent="media"]').forEach((holder) => {
    if (holder.querySelector("iframe")) return;
    loadPlayer(holder, false);
  });
}

export function enhanceBlocks(root: ParentNode = document): void {
  // The click that loads a video is handled for the whole page; the mark only says the page has started.
  root
    .querySelectorAll(".video-load:not([data-ready])")
    .forEach((el) => el.setAttribute(READY, ""));
  loadConsentedVideos(root);
  enhanceTabs(root);
  enhanceSliders(root);
  enhanceGalleries(root);
}

/** Put once in the public frame: it adds the behaviour to what is on the page now and to pages that arrive later. */
export function BlockBehaviour() {
  useEffect(() => {
    enhanceBlocks();
    let waiting = false;
    const watch = new MutationObserver(() => {
      if (waiting) return;
      waiting = true;
      requestAnimationFrame(() => {
        waiting = false;
        enhanceBlocks();
      });
    });
    watch.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", openVideo);
    return () => {
      watch.disconnect();
      document.removeEventListener("click", openVideo);
    };
  }, []);
  return null;
}
