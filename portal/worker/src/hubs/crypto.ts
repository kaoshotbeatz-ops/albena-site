const enc = new TextEncoder();

export function b64decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}
export function b64encode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : (data as BufferSource));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Canonical string a hub signs: METHOD \n PATH(+query) \n TIMESTAMP \n sha256hex(body) */
export async function signingString(method: string, path: string, ts: string, body: Uint8Array): Promise<string> {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${await sha256Hex(body)}`;
}

export async function verifyEd25519(pubB64: string, sigB64: string, message: string): Promise<boolean> {
  const pub = b64decode(pubB64);
  const sig = b64decode(sigB64);
  if (!pub || !sig || pub.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pub as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig as BufferSource, enc.encode(message));
  } catch {
    return false;
  }
}

// no 0/O/1/I/L
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newPairCode(): string {
  const out: string[] = [];
  const limit = 256 - (256 % CODE_ALPHABET.length); // rejection sampling, no modulo bias
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < 8) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
    }
  }
  return out.join("");
}
export function normalizeCode(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const c = s.replace(/[\s-]/g, "").toUpperCase();
  return c.length === 8 && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}
