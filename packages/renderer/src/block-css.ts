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
    ".gallery{display:grid;gap:.75rem;margin:0;padding:0;list-style:none}.gallery figure{margin:0}.gallery img{display:block;inline-size:100%;block-size:auto}.gallery-1{grid-template-columns:1fr}.gallery-2{grid-template-columns:repeat(2,minmax(0,1fr))}.gallery-3{grid-template-columns:repeat(3,minmax(0,1fr))}.gallery-4{grid-template-columns:repeat(4,minmax(0,1fr))}.gallery-5{grid-template-columns:repeat(5,minmax(0,1fr))}.gallery-6{grid-template-columns:repeat(6,minmax(0,1fr))}.oks-lightbox{max-inline-size:min(95vw,70rem);max-block-size:95vh;padding:1rem;border:0;border-radius:.5rem;text-align:center}.oks-lightbox::backdrop{background:rgba(0,0,0,.8)}.oks-lightbox img{display:block;max-inline-size:100%;max-block-size:75vh;margin-inline:auto}.oks-lightbox button{min-block-size:44px;min-inline-size:44px;margin:.5rem .25rem 0;font:inherit;cursor:pointer}",
  video:
    ".video-load{position:relative;max-inline-size:48rem;aspect-ratio:16/9;background:#111;color:#fff;overflow:hidden}.video-load iframe{position:absolute;inset:0;inline-size:100%;block-size:100%;border:0}.video-open{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;padding:1rem;color:inherit;text-align:center;text-decoration:none}.video-open img{position:absolute;inset:0;inline-size:100%;block-size:100%;object-fit:cover;opacity:.55}.video-open span{position:relative}.video-title{font-weight:700;font-size:1.25rem}.video-note{display:inline-block;padding:.4rem .8rem;border:2px solid currentColor;border-radius:.4rem;background:rgba(0,0,0,.6)}.video-open:focus-visible{outline:3px solid #fff;outline-offset:-6px}",
  map: ".map a{display:block}.map img{display:block;max-inline-size:100%;block-size:auto;margin-block-end:.25rem}",
  audio: ".audio audio{inline-size:100%}",
  icon: ".icon{display:inline-flex;vertical-align:middle;color:inherit}",
  socialLinks:
    ".social-links{display:flex;flex-wrap:wrap;gap:.75rem;margin:0;padding:0;list-style:none}",
  form: ".oks-form{display:grid;gap:1rem;max-inline-size:40rem}.oks-form-field{display:grid;gap:.25rem;margin:0;padding:0;border:0}.oks-form label,.oks-form legend{font-weight:600}.oks-form input:not([type=checkbox]):not([type=radio]),.oks-form select,.oks-form textarea{min-block-size:44px;padding:.5rem .75rem;border:1px solid currentColor;border-radius:.3rem;background:inherit;color:inherit;font:inherit;inline-size:100%;box-sizing:border-box}.oks-form-choice{display:flex;align-items:center;gap:.5rem;min-block-size:44px;font-weight:400!important}.oks-form-help,.oks-form-note{margin:0;font-size:.9em;opacity:.8}.oks-form :focus-visible{outline:3px solid var(--oks-color-primary-700,#1d4ed8);outline-offset:2px}.oks-form-trap{position:absolute!important;inset-inline-start:-10000px;inline-size:1px;block-size:1px;overflow:hidden}",
  accordion:
    ".accordion details{border-block-end:1px solid currentColor;padding-block:.5rem}.accordion summary{cursor:pointer;font-weight:600}",
  tab: ".tabs .tab+.tab{margin-block-start:1.5rem}.tabs[data-ready] .tab+.tab{margin-block-start:0}.tabs[data-ready]>.tab>h3{display:none}.tabs>.tab[hidden]{display:none!important}.tablist{display:flex;flex-wrap:wrap;gap:.25rem;border-block-end:1px solid currentColor;margin-block-end:1rem}.tab-button{min-block-size:44px;padding:.5rem 1rem;border:0;border-block-end:3px solid transparent;background:none;color:inherit;font:inherit;font-weight:600;cursor:pointer}.tab-button[aria-selected=true]{border-block-end-color:var(--oks-color-primary-700,#1d4ed8)}.tab-button:focus-visible,.slider-button:focus-visible,.slider-dot:focus-visible{outline:3px solid var(--oks-color-primary-700,#1d4ed8);outline-offset:2px}",
  slider:
    '.slider{display:flex;gap:1rem;overflow-x:auto;scroll-snap-type:x mandatory}.slider .slide{flex:0 0 100%;scroll-snap-align:start}.slider-controls{display:flex;align-items:center;justify-content:center;gap:.5rem;margin-block-start:.75rem}.slider-button{min-inline-size:44px;min-block-size:44px;border:1px solid currentColor;border-radius:50%;background:none;color:inherit;font-size:1.5rem;line-height:1;cursor:pointer}.slider-button:disabled{opacity:.4;cursor:default}.slider-dot{inline-size:24px;block-size:24px;padding:0;border:0;background:none;cursor:pointer;position:relative}.slider-dot::before{content:"";position:absolute;inset:6px;border:2px solid currentColor;border-radius:50%}.slider-dot[aria-current=true]::before{background:currentColor}',
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
