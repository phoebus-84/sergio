# Retake

**Anyone can get a first take. This measures the second.**

A benchmark for systems that make video with an AI agent. It asks the
question the others leave out: not how good the first video is, but what
happens next — when one sentence has to change, when the series needs its
next episode, when the money runs out.

> **Status: specification, version 0.1.** The tasks, measures and thresholds
> below are written down before anything is run, on purpose. The harness that
> runs them does not exist yet; nothing here has produced a number. What is
> still open is listed under [Not settled](#not-settled).

## What is compared

Each **arm** is a way of working. Every arm gets the same model, the same
machine, the same tools on the PATH (Node 22, FFmpeg, Remotion, HyperFrames),
the same provider keys and the same task text.

| Arm | What the agent has | What it isolates |
|---|---|---|
| `bare` | Claude Code and the tools on the PATH | the model on its own |
| `skills` | `bare` + this studio's skills as text, no tools | what the instructions are worth |
| `tools` | `skills` + the studio's tools, no pipeline, no gates | what the tools are worth |
| `studio` | the studio as shipped | what the production state is worth |
| `other` | another open harness, set up as its README says | the nearest alternative |

`bare` → `skills` → `tools` → `studio` is an ablation ladder: it says which
layer a difference comes from. If `skills` does as well as `studio` on a task,
the runtime added nothing there, and the report says so.

**Models**: a small, a medium and a large Claude model and one open-weight
model through Pi; named with their exact ids in each report.
**Runs**: five per cell. The spread is a result, not noise to hide.

## The tasks

Version 0.1 has four. All are about one small program,
[`fixtures/tally`](fixtures/tally/README.md), whose every true statement and
every command's output is written down in `facts.json` and checked by a test.

| | Task | Asks | Headline measure |
|---|---|---|---|
| [01](tasks/01-first-take.yaml) | First take | explain `tally` in a 60–75 s narrated video | completion, accuracy, preference |
| [03](tasks/03-correction.yaml) | Correction | replace one sentence of that video, change nothing else | share of the video that changed outside the sentence |
| [04](tasks/04-next-episode.yaml) | Next episode | make episode 4 of a series that has three | closeness to the series, and its spread over five runs |
| [07](tasks/07-budget-cap.yaml) | Budget cap | illustrate four scenes without spending more than the cap allows | metered spend, and what the agent did at the limit |

The numbers leave room for the tasks that come next: explaining a repository
(02), a second language (05), an interruption (06), rights (08), a cut from
footage (09).

Every measure is defined once, in [`metrics.md`](metrics.md).

## Rules

1. **Written first.** A task, its measures and its thresholds are committed
   before the first run of that version. A change after that is a new version.
2. **Everything is published.** Every run's output, transcript and bill,
   including the ones that failed and the ones this studio loses.
3. **Anyone can run it.** The harness and the fixtures are in this
   repository; a result that cannot be reproduced from them is not a result.
4. **The other side checks its own set-up.** The configuration of the `other`
   arm is sent to that project's maintainers before publication, and their
   corrections are applied.
5. **A person is counted.** A run may ask its operator a question where the
   task allows it; every such turn is counted and reported.
6. **No tuning to the task.** No arm's skills or prompts may name `tally`,
   these tasks, or their wording.

## Reading a result

A cell is reported as the median and the range of five runs. The headline for
each task is in the table above; `cost per accepted minute` (provider dollars
plus operator minutes, over the minutes of video a reviewer accepts as they
are) is reported for every task, because it is the figure a producer asks for.

What would count against the studio, stated in advance:

- On 01, `bare` with the large model is preferred as often as `studio`. Then
  the studio is not for single videos, and says so.
- On 03, `studio` changes more than 1% of the video outside the sentence, or
  no less than `bare`. Then targeted correction is not delivered.
- On 04, the spread of `studio` is not clearly smaller than that of `bare`.
  Then a pinned format is not enough to hold a series.
- On 07, `studio` spends past the cap in any run. Then the ledger has a hole.
- On any task, `skills` matches `studio`. Then the value is in the text.

## Not settled

- **The harness**: starting an arm in a clean environment, giving it the
  task, collecting the output, the transcript and the bill.
- **The series of task 04**: three reference episodes have to be made once,
  reviewed by a person and frozen under `fixtures/series/`.
- **The metered provider of task 07**: a local stand-in with fixed prices
  whose log is the bill, so that no arm's own bookkeeping is trusted.
- **Noise floors**: the SSIM and audio-correlation thresholds of task 03 are
  provisional until the same timeline has been rendered twice on the bench
  machine and the difference measured.
- **The judges**: how many reviewers, how they are recruited, and the rubric
  of the automatic judge, which is published only if it agrees with them.
