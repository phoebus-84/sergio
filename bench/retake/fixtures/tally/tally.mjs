#!/usr/bin/env node
// tally: count the words of text files. The subject of the Retake benchmark's
// tasks: small enough to explain in a minute, real enough to get wrong.
//
//   tally <file>...            words per file, and a total when there are several
//   tally --top N <file>...    the N most frequent words across the files
//   tally --min L ...          count only words of at least L letters (default 1)
//   tally --json ...           the same answer as JSON
//
// A word is a run of letters (any script), digits and apostrophes, compared
// in lower case. Standard input is read when no file is named.

import { readFileSync } from "node:fs";

const USAGE = "usage: tally [--top N] [--min L] [--json] [file...]";

export function words(text, min = 1) {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((word) => [...word].length >= min);
}

export function top(list, n) {
  const counts = new Map();
  for (const word of list) counts.set(word, (counts.get(word) ?? 0) + 1);
  // Most frequent first; words that tie are in alphabetical order.
  return [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)).slice(0, n).map(([word, count]) => ({ word, count }));
}

export function parse(argv) {
  const options = { top: null, min: 1, json: false, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--top" || arg === "--min") {
      const value = Number(argv[(i += 1)]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} needs a whole number of at least 1`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    process.stderr.write(`tally: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  const sources = options.files.length > 0 ? options.files : ["-"];
  const read = [];
  for (const file of sources) {
    try {
      read.push({ file, list: words(readFileSync(file === "-" ? 0 : file, "utf-8"), options.min) });
    } catch {
      process.stderr.write(`tally: cannot read ${file}\n`);
      return 1;
    }
  }
  if (options.top !== null) {
    const ranked = top(read.flatMap((entry) => entry.list), options.top);
    process.stdout.write(options.json ? `${JSON.stringify(ranked)}\n` : ranked.map(({ word, count }) => `${String(count).padStart(6)}  ${word}\n`).join(""));
    return 0;
  }
  const rows = read.map(({ file, list }) => ({ file, words: list.length }));
  const total = rows.reduce((sum, row) => sum + row.words, 0);
  if (options.json) process.stdout.write(`${JSON.stringify(rows.length > 1 ? { files: rows, total } : rows[0])}\n`);
  else {
    for (const row of rows) process.stdout.write(`${String(row.words).padStart(6)}  ${row.file}\n`);
    if (rows.length > 1) process.stdout.write(`${String(total).padStart(6)}  total\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) process.exitCode = main(process.argv.slice(2));
