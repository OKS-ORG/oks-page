// The rules that hide a block on phone, tablet or desktop (spec 06). Kept in a file of their own so the page can link
// to them (`/site-style/<fingerprint>.css`) and carry no inline style element.
export const HIDE_CSS =
  ".oks-hide{display:contents}.oks-hide-phone{display:none}" +
  "@media (min-width:768px){.oks-hide-phone{display:contents}.oks-hide-tablet{display:none}}" +
  "@media (min-width:1025px){.oks-hide-tablet{display:contents}.oks-hide-desktop{display:none}}";
