/**
 * Minimal dependency-free Base64 encoder for binary attachment payloads.
 *
 * Works identically in Deno (Edge Function) and Node (vitest) without relying
 * on `btoa` (which chokes on large Uint8Arrays when spread into arguments).
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const length = bytes.length;
  for (let index = 0; index < length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < length ? bytes[index + 1] : 0;
    const third = index + 2 < length ? bytes[index + 2] : 0;
    out += BASE64_ALPHABET[first >> 2];
    out += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    out += index + 1 < length ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '=';
    out += index + 2 < length ? BASE64_ALPHABET[third & 0x3f] : '=';
  }
  return out;
}
