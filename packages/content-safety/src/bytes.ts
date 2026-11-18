// Size of a text in bytes (UTF-8). Works in the browser too, so the editor can use the same checks.
const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).length;
