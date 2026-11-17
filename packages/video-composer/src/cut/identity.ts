// ---------------------------------------------------------------------------
// Which file this is, without reading it
// ---------------------------------------------------------------------------
// A piece of a render is kept and used again while the files it read are the
// ones it read. Size and modification time do not say that: a file replaced
// by other bytes of the same length, with its date put back, has both.
//
// The change time and the file id are the kernel's. Nothing a writer does to
// the bytes leaves them as they were: a write moves the change time even when
// the modification time is then set back, and a file renamed over another has
// another id. So this names the file as it is now, at the cost of one stat.
// It is not the file's content: the same bytes copied elsewhere, or restored
// from a store, are another file to it, and what was rendered from them is
// rendered again. (The Remotion composer's render cache names files the same
// way before it hashes them.)
// ---------------------------------------------------------------------------

import { statSync, type BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";

function identityOf(file: string, s: BigIntStats): string {
  // Without a file id (some filesystems give 0) the path names the file.
  return `${s.ino !== 0n ? `${s.dev}:${s.ino}` : path.resolve(file)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}

/** The file's identity, through a link to what it points at. Throws when it is not there. */
export async function fileIdentity(file: string): Promise<string> {
  return identityOf(file, await stat(file, { bigint: true }));
}

/** The same, read synchronously; null when the path is not a file. */
export function fileIdentitySync(file: string): string | null {
  try {
    const s = statSync(file, { bigint: true });
    return s.isFile() ? identityOf(file, s) : null;
  } catch {
    return null;
  }
}
