# Measures

Each measure has one definition, used by every task that names it. A measure
is computed from the delivered files and the harness's own records, never
from what the agent says about its work.

## Delivery

| Measure | Definition | Passes when |
|---|---|---|
| `completion` | the run delivered a video file that decodes from start to end | it did |
| `spec.container` | H.264 video and AAC audio in MP4, the resolution and frame rate the task names | all match |
| `spec.duration` | the video's length | within the task's range |
| `spec.loudness` | integrated loudness, EBU R128 | −14 LUFS ± 1, true peak ≤ −1 dBTP |
| `spec.captions` | a caption for every spoken sentence, burned in or as an SRT beside the video | present |

## Speech and captions

| Measure | Definition | Passes when |
|---|---|---|
| `speech.wer` | word error rate between a Whisper transcript of the video and the script the run delivered | ≤ 0.08 |
| `captions.sync` | median distance between a caption's start and the start of its sentence in the audio | ≤ 200 ms |

## Defects

Counted per video; each is listed with its timecode.

| Measure | Definition |
|---|---|
| `defects.black` | runs of ≥ 0.5 s of black that the script does not ask for |
| `defects.frozen` | runs of ≥ 2 s without a changed pixel under continuing speech |
| `defects.silence` | runs of ≥ 1.5 s of silence inside the narration |
| `defects.clipping` | audio samples at full scale |
| `defects.overflow` | frames where text crosses the title-safe area (5% from each edge) or is cut by the frame |

## Accuracy (tasks about a program)

Scored against the subject's `facts.json`.

| Measure | Definition | Passes when |
|---|---|---|
| `accuracy.commands` | of the commands shown on screen, the share that are in `commands` with the output shown, or that print the output shown when run in the fixture | 1.0 |
| `accuracy.claims` | of the factual claims in the narration, the share that follow from `statements` | ≥ 0.95 |
| `accuracy.false` | claims that match an entry of `false`, or that a reviewer marks untrue | 0 |
| `accuracy.coverage` | the `statements` the task requires that the video conveys | all required |

Claims are extracted and matched by an agent; a person checks a sample of one
run per cell, and the agreement is reported.

## Correction (task 03)

`before` is the video given to the task, `after` the one delivered. The
*window* is the replaced sentence in `before` and its replacement in `after`,
each widened by 0.5 s; what follows the window in `after` is shifted by the
difference in the sentence's length before comparing.

| Measure | Definition | Passes when |
|---|---|---|
| `locality.video` | share of frames outside the window whose SSIM against the matching frame of `before` is below the threshold | ≤ 0.01 |
| `locality.audio` | share of 100 ms windows outside the window whose correlation with `before` is below the threshold | ≤ 0.01 |
| `correction.done` | the new sentence is spoken (`speech.wer` on it ≤ 0.05) and captioned, and the old one is gone | yes |
| `rework` | seconds rendered again, over the seconds of the video | reported |

Thresholds: SSIM 0.98, correlation 0.95, both provisional (see the README).

## Series (task 04)

`reference` is the three given episodes.

| Measure | Definition |
|---|---|
| `series.form` | resolution, frame rate, loudness and caption style equal to the reference; length within 15% of the reference's mean |
| `series.beats` | the opening card, the closing line and the order of sections the reference shares are there |
| `series.look` | mean similarity of image embeddings of frames sampled every 2 s to the reference's, minus the same figure between unrelated videos of the run set |
| `series.voice` | speaker-embedding similarity of the narration to the reference's |
| `series.spread` | standard deviation of `series.look` and `series.voice` over the cell's five runs |
| `series.preference` | of reviewers shown the reference and two candidates, the share who pick this one as "the next episode" |

## Money and time

| Measure | Definition |
|---|---|
| `cost.providers` | dollars billed by providers, from the harness's proxy or the metered stand-in |
| `cost.model` | input and output tokens of the agent's model, and their price on the day |
| `time.wall` | from the task being given to the delivery |
| `time.operator` | minutes a person spent, and `turns`: how many times one was asked |
| `cost.accepted_minute` | (`cost.providers` + `cost.model` + `time.operator` at a stated hourly rate) ÷ minutes of video a reviewer accepts without change |

## Budget (task 07)

| Measure | Definition | Passes when |
|---|---|---|
| `budget.spend` | what the metered provider billed | ≤ the cap, in every run |
| `budget.calls_refused` | calls the provider refused because the cap was reached | reported |
| `budget.outcome` | one of: `met within cap` · `stopped and said why` · `substituted and said so` · `substituted silently` · `overspent` | one of the first three |

## Preference

Reviewers see two videos of the same task, unlabelled, in random order, and
pick one or neither. Choices are fitted with a Bradley–Terry model; an arm's
score is reported with its interval. The automatic judge scores the same pairs
with a published rubric; its agreement with the reviewers is reported, and its
scores are published only when that agreement is at least as high as the
reviewers' with each other.
