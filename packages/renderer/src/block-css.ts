// The base look of the layout blocks (spec 06, section 14): written with start/end (logical) properties so right-to-left
// sites mirror, and with the theme's colour variables. Only the rules of the blocks a page really uses are sent.
const RULES: Record<string, string> = {
  section:
    ".section{padding-block:2rem}.section-boxed{max-inline-size:72rem;margin-inline:auto;padding-inline:1rem}",
  container: ".container{display:flex;flex-direction:column;gap:1rem}",
  columns:
    ".columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:1rem}",
  spacer:
    ".spacer-xs{block-size:.5rem}.spacer-sm{block-size:1rem}.spacer-md{block-size:2rem}.spacer-lg{block-size:4rem}.spacer-xl{block-size:6rem}",
  button:
    ".button{display:inline-block;padding:.6rem 1.2rem;border:2px solid var(--oks-color-primary-700,#1d4ed8);border-radius:.4rem;font-weight:600;text-decoration:none;color:var(--oks-color-primary-700,#1d4ed8)}.button-solid{background:var(--oks-color-primary-700,#1d4ed8);color:#fff}.button-link{border-color:transparent;text-decoration:underline}",
  buttonGroup: ".button-group{display:flex;flex-wrap:wrap;gap:.75rem}",
  gallery:
    ".gallery{display:grid;gap:.75rem;margin:0;padding:0;list-style:none}.gallery figure{margin:0}.gallery img{display:block;inline-size:100%;block-size:auto}.gallery-1{grid-template-columns:1fr}.gallery-2{grid-template-columns:repeat(2,minmax(0,1fr))}.gallery-3{grid-template-columns:repeat(3,minmax(0,1fr))}.gallery-4{grid-template-columns:repeat(4,minmax(0,1fr))}.gallery-5{grid-template-columns:repeat(5,minmax(0,1fr))}.gallery-6{grid-template-columns:repeat(6,minmax(0,1fr))}",
  audio: ".audio audio{inline-size:100%}",
  icon: ".icon{display:inline-flex;vertical-align:middle;color:inherit}",
  socialLinks:
    ".social-links{display:flex;flex-wrap:wrap;gap:.75rem;margin:0;padding:0;list-style:none}",
  accordion:
    ".accordion details{border-block-end:1px solid currentColor;padding-block:.5rem}.accordion summary{cursor:pointer;font-weight:600}",
  tab: ".tabs .tab+.tab{margin-block-start:1.5rem}",
  slider:
    ".slider{display:flex;gap:1rem;overflow-x:auto;scroll-snap-type:x mandatory}.slider .slide{flex:0 0 100%;scroll-snap-align:start}",
};

/** The base rules for the given block types, in a fixed order. */
export function layoutCss(types: Iterable<string>): string {
  const used = new Set(types);
  if (used.has("column")) used.add("columns");
  if (used.has("tabs")) used.add("tab");
  return Object.keys(RULES)
    .filter((t) => used.has(t))
    .map((t) => RULES[t])
    .join("\n");
}
