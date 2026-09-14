import type { Reader } from "../reader";

/**
 * Streaming string scanner for formats we cannot parse.
 *
 * Two passes matter. Windows binaries store paths as UTF-16LE, so
 * `C:\Users\Asus\` is `43 00 3A 00 5C 00 ...` and a latin1-only regex never
 * matches it — the tool would report "nothing found" on a file that leaks the
 * user's name. The 1 KB overlap exists because a string straddling a chunk
 * boundary is otherwise invisible.
 */

const CHUNK = 8 << 20; // 8 MB
const OVERLAP = 1024;

export type HitKind = "path" | "email" | "url" | "host" | "guid";

export interface StringHit {
  readonly kind: HitKind;
  readonly value: string;
  readonly offset: number;
  readonly encoding: "latin1" | "utf16le";
}

const PATTERNS: ReadonlyArray<readonly [HitKind, RegExp]> = [
  ["path", /[A-Za-z]:\\(?:Users|Documents and Settings)\\[A-Za-z0-9 ._-]{1,64}/g],
  ["path", /\/(?:home|Users)\/[A-Za-z0-9._-]{1,64}/g],
  ["path", /\\\\[A-Za-z0-9._-]{2,32}\\[A-Za-z0-9$._-]{1,64}/g],
  ["email", /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{2,64}\.[A-Za-z]{2,12}/g],
  ["url", /https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{4,200}/g],
  [
    "guid",
    /\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?/g,
  ],
];

function decodeLatin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : "\u0000";
  }
  return s;
}

/**
 * Collapse UTF-16LE to latin1 by dropping the high byte of each pair, keeping
 * an index map so a hit can be reported at its real byte offset.
 */
function decodeUtf16le(b: Uint8Array): { text: string; map: Int32Array } {
  const n = b.length >> 1;
  const map = new Int32Array(n);
  let s = "";
  for (let i = 0; i < n; i++) {
    const lo = b[i * 2]!;
    const hi = b[i * 2 + 1]!;
    map[i] = i * 2;
    s += hi === 0 && lo >= 0x20 && lo < 0x7f ? String.fromCharCode(lo) : "\u0000";
  }
  return { text: s, map };
}

function collect(
  text: string,
  base: number,
  encoding: StringHit["encoding"],
  map: Int32Array | null,
  out: Map<string, StringHit>,
  limit: number,
): void {
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (out.size >= limit) return;
      const value = m[0];
      if (value.includes("\u0000")) continue;
      const local = map ? (map[m.index] ?? m.index) : m.index;
      const key = `${kind}:${value}`;
      if (!out.has(key)) {
        out.set(key, { kind, value, offset: base + local, encoding });
      }
    }
  }
}

export async function scanStrings(src: Reader, limit = 200): Promise<StringHit[]> {
  const out = new Map<string, StringHit>();
  let pos = 0;

  while (pos < src.size && out.size < limit) {
    const end = Math.min(src.size, pos + CHUNK);
    const buf = await src.bytes({ start: pos, end });

    collect(decodeLatin1(buf), pos, "latin1", null, out, limit);

    const { text, map } = decodeUtf16le(buf);
    collect(text, pos, "utf16le", map, out, limit);
    // UTF-16LE strings can also start on an odd byte.
    if (buf.length > 1) {
      const odd = decodeUtf16le(buf.subarray(1));
      collect(odd.text, pos + 1, "utf16le", odd.map, out, limit);
    }

    if (end >= src.size) break;
    pos = end - OVERLAP;
  }

  return [...out.values()].sort((a, b) => a.offset - b.offset);
}
