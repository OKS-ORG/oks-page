// Light and dark mode of the public pages (spec 05, section 5). The owner chooses one of three modes, and may show the
// visitors a switch. oks-ui draws dark only when `data-theme="dark"` is on `<html>`, so a small fixed script sets it
// before the page is painted (no flash). The script is the same text on every site, so a content security policy can
// allow it by its hash; the settings reach it as `data-` attributes of its own tag, never inside the text.

/** "light": always light (the default, as before). "dark": always dark. "system": the visitor's device decides. */
export const COLOR_MODES = ["light", "dark", "system"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const isColorMode = (value: unknown): value is ColorMode =>
  typeof value === "string" && (COLOR_MODES as readonly string[]).includes(value);

/** The name under which a visitor's own choice is kept in their browser (never sent anywhere). */
export const COLOR_MODE_STORAGE_KEY = "oks-color-mode";

/** Whether the pages need the script at all: a site that is always light and has no switch is exactly as before. */
export const needsColorMode = (mode: ColorMode, switchShown: boolean): boolean =>
  mode !== "light" || switchShown;

/**
 * The script. It reads `data-mode` ("light", "dark" or "system") and `data-switch` ("1") from its own tag. With the
 * switch on, a choice the visitor made earlier wins. For "system" it also follows the device when that changes and the
 * visitor has made no choice.
 */
export const COLOR_MODE_SCRIPT =
  '(function(){var s=document.currentScript,m=s.dataset.mode,w=s.dataset.switch==="1",k="' +
  COLOR_MODE_STORAGE_KEY +
  '",r=document.documentElement,q=matchMedia("(prefers-color-scheme: dark)");' +
  'function c(){if(w)try{var v=localStorage.getItem(k);if(v==="light"||v==="dark")return v}catch(e){}return m}' +
  'function a(){var v=c();r.setAttribute("data-theme",v==="dark"||(v==="system"&&q.matches)?"dark":"light")}' +
  'a();if(m==="system")q.addEventListener("change",a)})()';

/**
 * The few rules that make a public page readable in dark: the dark page color and text of oks-ui (or the theme's own
 * values when it gives them), a link color from the dark scale, and the browser's own dark form controls and scroll bars.
 */
export function colorModeCss(mode: ColorMode, switchShown: boolean): string {
  if (!needsColorMode(mode, switchShown)) return "";
  return [
    ':root[data-theme="dark"]{color-scheme:dark}',
    ':root[data-theme="dark"] body{background-color:var(--oks-site-background,var(--oks-color-surface));color:var(--oks-site-text,var(--oks-palette-neutral-900))}',
    ':root[data-theme="dark"] a{color:var(--oks-site-link,var(--oks-color-primary-700))}',
  ].join("\n");
}
