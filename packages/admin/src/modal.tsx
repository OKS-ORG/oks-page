// A dialog that opens inside the admin's own wrapper. oks-ui puts a dialog at the end of the page, outside the wrapper, where the
// look's colours (CSS variables) and the admin's field and button rules do not reach; here the dialog is drawn inside it.
import { Modal as OksModal } from "oks-ui";
import type { ComponentProps } from "react";

export function Modal(props: ComponentProps<typeof OksModal>) {
  // Found while drawing, not after it: a dialog that first opened at the end of the page and then moved would be drawn twice
  // and could be clicked at the very moment it is replaced. A dialog is only drawn once someone has opened it, in the browser.
  const host =
    props.isOpen && typeof document !== "undefined" ? document.querySelector(".oks-admin") : null;
  return <OksModal {...props} {...(host ? { container: host } : {})} />;
}
