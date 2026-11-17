import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findChrome } from "../src/index.js";

const NAMES = ["STRUDEL_CHROME_PATH", "CHROME_PATH", "PUPPETEER_EXECUTABLE_PATH"];
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function fakeBrowser(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("findChrome", () => {
  it("takes the browser it is given, and says so when there is none there", () => {
    const dir = mkdtempSync(join(tmpdir(), "strudel-chrome-"));
    const path = fakeBrowser(dir, "chrome");
    expect(findChrome({ chromePath: path })).toBe(path);
    expect(() => findChrome({ chromePath: join(dir, "nothing") })).toThrow(/no browser at/);
  });

  it("reads the environment before looking anywhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "strudel-chrome-"));
    const path = fakeBrowser(dir, "my-chrome");
    for (const name of NAMES) delete process.env[name];
    process.env.STRUDEL_CHROME_PATH = path;
    expect(findChrome()).toBe(path);
    process.env.STRUDEL_CHROME_PATH = join(dir, "gone");
    expect(() => findChrome()).toThrow(/STRUDEL_CHROME_PATH is .*gone, and there is no browser there/);
  });

  it("finds a downloaded headless shell under the directories it is told to search", () => {
    for (const name of NAMES) delete process.env[name];
    const dir = mkdtempSync(join(tmpdir(), "strudel-chrome-"));
    const shell = fakeBrowser(join(dir, ".remotion", "chrome-headless-shell", "linux64", "chrome-headless-shell-linux64"), "chrome-headless-shell");
    fakeBrowser(join(dir, ".remotion", "chrome-for-testing"), "chrome");
    expect(findChrome({ searchDirs: [join(dir, ".remotion")] })).toBe(shell);
  });
});
