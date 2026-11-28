// The picture an authenticator app scans, made in the browser so that the key never leaves it.
import qrcode from "qrcode-generator";

export function qrOf(uri: string): string {
  const code = qrcode(0, "M");
  code.addData(uri);
  code.make();
  return code.createDataURL(5, 8);
}
