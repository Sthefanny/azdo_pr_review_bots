const secretPatterns = [
  /Bearer\s+[A-Za-z0-9._+/=-]+/gi,
  /xox[bapqr]-[\w-]{10,}/gi,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const p of secretPatterns) {
    out = out.replaceAll(p, "[REDACTED]");
  }
  return out;
}

/** Simple stable hash for change detection — not cryptographic. */
export function fnv1aHex(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i) & 0xff);
    h = (h * 0x100000001b3n) % 2n ** 64n;
  }
  return h.toString(16).padStart(16, "0");
}
