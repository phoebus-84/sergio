// ---------------------------------------------------------------------------
// Which Chrome renders the music. Any recent Chrome, Chromium or
// chrome-headless-shell will do: the engine only needs Web Audio.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StrudelError } from "./errors.js";

const ENVIRONMENT = ["STRUDEL_CHROME_PATH", "CHROME_PATH", "PUPPETEER_EXECUTABLE_PATH"];
const BINARIES = new Set([
  "chrome-headless-shell", "chrome-headless-shell.exe", "headless_shell",
  "chrome", "chrome.exe", "chromium", "Chromium", "Google Chrome for Testing", "Google Chrome",
]);
const ON_PATH = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "chrome-headless-shell"];

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Every browser binary under a directory. */
function binariesUnder(dir: string, depth = 6): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const here = entries.filter((e) => !e.isDirectory() && BINARIES.has(e.name) && isFile(join(dir, e.name))).map((e) => join(dir, e.name));
  if (depth === 0) return here;
  return [...here, ...entries.filter((e) => e.isDirectory()).flatMap((e) => binariesUnder(join(dir, e.name), depth - 1))];
}

/** A browser binary under a directory, a headless shell before a full browser: it starts faster and needs no display. */
function binaryUnder(dir: string): string | null {
  const found = binariesUnder(dir).sort();
  return found.find((path) => /headless/.test(path.slice(dir.length))) ?? found[0] ?? null;
}

function ancestors(from: string): string[] {
  const out: string[] = [];
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    out.push(dir);
    if (dirname(dir) === dir) return out;
  }
}

/** Playwright's browsers: the newest headless shell, else the newest Chromium. */
function playwrightBrowser(): string | null {
  const home = homedir();
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(home, ".cache", "ms-playwright"),
    join(home, "Library", "Caches", "ms-playwright"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : undefined,
  ].filter((root): root is string => Boolean(root) && existsSync(root!));
  for (const root of roots) {
    const revision = (name: string) => Number(name.split("-").pop()) || 0;
    const dirs = readdirSync(root).sort((a, b) => revision(b) - revision(a));
    for (const prefix of ["chromium_headless_shell-", "chromium-"]) {
      for (const name of dirs.filter((d) => d.startsWith(prefix))) {
        const binary = binaryUnder(join(root, name));
        if (binary) return binary;
      }
    }
  }
  return null;
}

function systemBrowser(): string | null {
  const fixed = platform() === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : platform() === "win32"
      ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
          .filter((dir): dir is string => Boolean(dir))
          .map((dir) => join(dir, "Google", "Chrome", "Application", "chrome.exe"))
      : [];
  for (const path of fixed) if (isFile(path)) return path;
  const extensions = platform() === "win32" ? [".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ON_PATH) {
      for (const extension of extensions) {
        if (dir && isFile(join(dir, name + extension))) return join(dir, name + extension);
      }
    }
  }
  return null;
}

export interface ChromeSearch {
  /** Use this binary, or fail. */
  chromePath?: string;
  /** Further directories to look under for a downloaded browser (for instance another node_modules/.remotion). */
  searchDirs?: string[];
}

/**
 * The browser to render with, in this order:
 * 1. `chromePath`, then `STRUDEL_CHROME_PATH`, `CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH`;
 * 2. the headless shell Remotion downloaded (`node_modules/.remotion`), from the working directory or this package up;
 * 3. Playwright's browsers;
 * 4. a Chrome or Chromium installed on the machine.
 */
export function findChrome(search: ChromeSearch = {}): string {
  if (search.chromePath) {
    if (!isFile(search.chromePath)) throw new StrudelError("no-browser", `there is no browser at ${search.chromePath}`);
    return search.chromePath;
  }
  for (const name of ENVIRONMENT) {
    const path = process.env[name];
    if (!path) continue;
    if (!isFile(path)) throw new StrudelError("no-browser", `${name} is ${path}, and there is no browser there`);
    return path;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const downloaded = [
    ...(search.searchDirs ?? []),
    ...[...ancestors(process.cwd()), ...ancestors(here)].map((dir) => join(dir, "node_modules", ".remotion")),
  ];
  for (const dir of downloaded) {
    const binary = existsSync(dir) ? binaryUnder(dir) : null;
    if (binary) return binary;
  }
  const found = playwrightBrowser() ?? systemBrowser();
  if (found) return found;
  throw new StrudelError(
    "no-browser",
    "no Chrome to render music with: set STRUDEL_CHROME_PATH to a Chrome, Chromium or chrome-headless-shell binary, " +
      "or get one with `npx remotion browser ensure` or `npx playwright install chromium-headless-shell`",
  );
}
