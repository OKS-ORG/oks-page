// Sealing a plugin's secret settings (spec 04, section 9; security, "Secrets"; PL-39). A secret is encrypted with a key
// made from the site's own OKS_SECRET, which lives in the environment and never in the database, so a copy of the
// database alone does not reveal it. The key is made with fixed labels, never the product name, so renaming the
// product can never make saved secrets unreadable. Each sealed value is bound to one plugin and one setting: moved to another
// plugin or another setting, it no longer opens.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBox {
  private readonly key: Buffer;

  /** `siteSecret` is the site's OKS_SECRET. A short one is refused rather than used weakly. */
  constructor(siteSecret: string) {
    if (typeof siteSecret !== "string" || siteSecret.length < 32)
      throw new Error("OKS_SECRET must be at least 32 characters long to protect plugin secrets");
    this.key = Buffer.from(
      hkdfSync("sha256", siteSecret, "site-secret-kdf", "plugin-settings:v1", 32),
    );
  }

  /** Encrypts `plain` for one place, for example "<extension id>:<setting key>". */
  seal(plain: string, place: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(place));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
  }

  /** Decrypts a value sealed for the same place. Throws when it was changed, made with another key, or sealed for
   * another place. */
  open(sealed: string, place: string): string {
    const [version, data] = String(sealed).split(":", 2);
    if (version !== VERSION || !data) throw new Error("not a sealed value");
    const raw = Buffer.from(data, "base64");
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("not a sealed value");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(place));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  }
}

/** What the admin shows for a saved secret: never the secret, at most its last four characters, and only when it is
 * long enough that those four give nothing away. */
export const secretHint = (plain: string): string =>
  plain.length >= 16 ? `••••${plain.slice(-4)}` : "••••";
