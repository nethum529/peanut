const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

// The unguessable link is the only access gate, so the id must carry real
// entropy: 22 chars over a 57-symbol alphabet is ~128 bits. Rejection
// sampling keeps the distribution uniform; byte % 57 would skew low symbols.
const LIMIT = 256 - (256 % ALPHABET.length);

export function randomId(length = 22): string {
  let out = "";
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= LIMIT) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}
