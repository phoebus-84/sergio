// A file is named by what the kernel says of it, not by its size and date.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity, fileIdentitySync } from "../src/index.js";

describe("which file a render read", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cut-identity-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const sizeAndDate = (file: string): [number, number] => [statSync(file).size, Math.round(statSync(file).mtimeMs)];
  const wait = () => new Promise((done) => setTimeout(done, 20));

  it("is the same while the file is left alone, and the same read either way", async () => {
    const file = join(dir, "still.bin");
    writeFileSync(file, "aaaa");
    expect(fileIdentitySync(file)).toBe(fileIdentitySync(file));
    expect(await fileIdentity(file)).toBe(fileIdentitySync(file));
  });

  it("changes when other bytes of the same length are written and the date is put back", async () => {
    const file = join(dir, "rewritten.bin");
    writeFileSync(file, "aaaa");
    const before = { identity: fileIdentitySync(file), state: sizeAndDate(file), at: statSync(file) };
    await wait();
    writeFileSync(file, "bbbb");
    utimesSync(file, before.at.atime, before.at.mtime);
    expect(sizeAndDate(file), "size and date cannot tell").toEqual(before.state);
    expect(fileIdentitySync(file)).not.toBe(before.identity);
  });

  it("changes when another file is put in its place", async () => {
    const file = join(dir, "replaced.bin");
    writeFileSync(file, "aaaa");
    const before = { identity: fileIdentitySync(file), at: statSync(file) };
    await wait();
    writeFileSync(join(dir, "other.bin"), "bbbb");
    utimesSync(join(dir, "other.bin"), before.at.atime, before.at.mtime);
    renameSync(join(dir, "other.bin"), file);
    expect(fileIdentitySync(file)).not.toBe(before.identity);
  });

  it("is null for what is not a file, and the promise is refused", async () => {
    expect(fileIdentitySync(join(dir, "nobody.bin"))).toBeNull();
    expect(fileIdentitySync(dir)).toBeNull();
    await expect(fileIdentity(join(dir, "nobody.bin"))).rejects.toThrow();
  });
});
