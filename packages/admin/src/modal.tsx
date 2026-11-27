// A dialog that opens inside the admin's own wrapper. oks-ui puts a dialog at the end of the page, outside the wrapper, where the
// look's colours (CSS variables) and the admin's field and button rules do not reach; here the dialog is drawn inside it.
import { Modal as OksModal } from "oks-ui";
import { useEffect, useState, type ComponentProps } from "react";

export function Modal(props: ComponentProps<typeof OksModal>) {
  const [host, setHost] = useState<Element | null>(null);
  const { isOpen } = props;
  useEffect(() => {
    if (isOpen) setHost(document.querySelector(".oks-admin"));
  }, [isOpen]);
  return <OksModal {...props} {...(host ? { container: host } : {})} />;
}
