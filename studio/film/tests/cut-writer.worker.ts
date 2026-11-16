// A process that writes a unit's cut, for cut-lock.test.ts. It waits for the
// `go` file so that every writer starts in the same instant.
//   edit  <root> <film> <scene> <shot> <name> <count>    count edits, each adding one marker, naming no revision
//   write <root> <film> <scene> <shot> <name> <revision> one whole-cut write that names the revision it read

import { existsSync } from "node:fs";
import { join } from "node:path";
import { FilmError, cutOrEmpty, editCut, shotUnit, writeCut } from "../src/index.js";

const [mode, root, film, scene, shot, name, number] = process.argv.slice(2) as [string, string, string, string, string, string, string];
const ref = shotUnit(film, scene, shot);
const cut = cutOrEmpty(root, ref);

const wait = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(join(root, "go"))) Atomics.wait(wait, 0, 0, 2);

const refused: string[] = [];
let written = 0;
const attempt = (work: () => void): void => {
  try {
    work();
    written += 1;
  } catch (error) {
    refused.push(error instanceof FilmError ? error.code : String(error));
  }
};

if (mode === "edit") {
  for (let i = 0; i < Number(number); i += 1) {
    attempt(() => editCut(root, ref, [{ op: "set-marker", marker: { id: `${name}-${i}`, at: i } }], { editor: "agent" }));
  }
} else {
  attempt(() => writeCut(root, ref, { ...cut, markers: [{ id: name, at: 0 }] }, { expectedRevision: Number(number) }));
}
process.stdout.write(JSON.stringify({ name, written, refused }));
