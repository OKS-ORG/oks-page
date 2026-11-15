// The browser side of passkeys, for the sign-in and account screens (spec 02). Browser-safe: nothing from the server
// parts of this package is imported here, so a screen can import it without pulling them into the page.
export {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
