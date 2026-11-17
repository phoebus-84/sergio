# tally

Counts the words of text files. One file, no dependencies, Node 22 or later.

```console
$ node tally.mjs sample.txt notes.txt
    21  sample.txt
    12  notes.txt
    33  total

$ node tally.mjs --top 3 sample.txt
     5  the
     2  counts
     2  keeper

$ node tally.mjs --json sample.txt
{"file":"sample.txt","words":21}
```

| | |
|---|---|
| `tally <file>...` | words in each file, and a total when there are several |
| `--top N` | the N most frequent words across all the files, most frequent first; ties in alphabetical order |
| `--min L` | count only words of at least L letters |
| `--json` | the same answer as JSON |
| no file | standard input is read |

A word is a run of letters, digits and apostrophes, compared in lower case:
`The` and `the` are one word, `keeper's` is one word and is not `keeper`.

It exits 0 when it answered, 1 when a file could not be read, 2 when it was
asked wrongly.

This program exists to be explained: it is the subject of the
[Retake benchmark](../../README.md). `facts.json` lists what is true of it.
