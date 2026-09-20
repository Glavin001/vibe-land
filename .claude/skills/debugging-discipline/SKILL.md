---
name: debugging-discipline
description: Patterns for debugging a system you cannot single-step — measuring the right entity, separating cause from victim, proving a negative, and not shipping fixes that measure as nothing. Each rule is anchored to a specific occasion it was learned on this project. Use when a fault resists explanation, when a theory keeps surviving on plausibility, or before reporting a root cause.
---

# Debugging discipline

Every rule here cost something to learn. The example after each one is the
occasion, kept short — the rule is the point, not the anecdote.

## Measuring

**Instrument the cause, not the victim.** When an effect has a thing that
suffers and a thing that acts, the suffering thing is easier to detect and
tells you almost nothing. Ask explicitly: is the entity I am measuring the one
I am trying to explain?

> A detector reported the age of every body that got ejected. All were old, so
> "created overlapping something" was declared dead — twice. The detector was
> measuring the victim. The cause was whatever *arrived*, and only a second
> detector, asking what was created nearby, actually settled it.

**Check the denominator carries the same population as the numerator.** A
derived metric silently mixes populations, and the mix can invert the result.

> `error_per_byte` divided total error by *all* of a cell's bytes, including
> records whose error is unmeasurable by construction. The cell full of those
> looked 18% worse than it was, and that artefact was reported as a finding.

**Verify your instrument samples faster than the phenomenon.** An instrument
slower than what it measures will confidently report absence.

> A per-frame pose trace was placed inside a block that runs one frame in
> thirty. It sampled at 2 Hz while claiming 60, and the artefact under
> investigation was a jump between consecutive frames.

**Record the inputs of a computation, not just its output.** An output that
moved says only that something upstream moved. Log the terms and which code
path last wrote each one.

> `chunk_world = body_pose ∘ local_offset`. Logging the result gave "a slab
> jumped". Logging both terms plus the writer gave "body position moved, local
> offset did not, writer was `presented`" — which is one function to read.

**Attribute by writer.** If N code paths can set a value, record which one did.
It collapses the search from N to 1 for free.

> Six paths can set a body pose. Every one of nine slab jumps named the same
> writer, which eliminated five subsystems in a single line of output.

**Prefer the exact measurement you already have over the clever inferred one.**

> A plan to infer how long a chunk hung in the air from its first-record jump
> distance (`t = sqrt(2d/g)`) was abandoned once it was noticed the packet log
> already contained both ticks. Measured beats derived.

## Reasoning

**A negative result is a deliverable. Write it down with its evidence.**
Otherwise it is re-derived, and the next person will believe the same wrong
thing for the same good reasons.

> One hypothesis had been believed for months and was in the code comments.
> Nobody had recorded what had been tested against it.

**Say why a disproof is sufficient, not just that it happened.** A weak
disproof recorded as strong is worse than none.

> "Ages are old, so not created-at-fault" felt conclusive and was not. The
> record now states why that reasoning fails, because it is the mistake that
> will be made again.

**Read the structure of a signal, not only its magnitude.** How things move
together identifies the mechanism; how far they moved does not.

> 393 chunks moving is a collapse. 393 chunks moving by *one identical vector*
> — coherence 1.00, with the exact inverse applied later — is a coordinate
> frame changing, which physics cannot do. The magnitude was unremarkable; the
> coherence was the entire diagnosis.

**Work the tail, not the mean, when the complaint is visual.** A fault a person
notices is usually rare and extreme.

> Fall-notification p50 was **0 ticks** while max was **1,538 ticks**. Every
> mean-based reading said the system was healthy. The artefact was entirely in
> the tail.

**Partition by regime before averaging.** One aggregate over unlike situations
reports the average of opposite effects, which is the least actionable number
available.

> On one scenario a fix looked complete. On two others the same build still had
> twenty-second stragglers, and on two more the cause was a different gate
> entirely. Four regimes, three distinct causes, one misleading average.

## Proving

**Establish the noise floor before measuring an effect.** If run-to-run
variation exceeds the effect, no comparison between runs means anything.

> Three runs of an identical scripted scenario differed by **25%** on the
> headline count. Nothing could be A/B'd until the variable input was recorded
> once and replayed.

**Hold the expensive, non-deterministic half fixed and iterate on the cheap
half.** Record it once, replay it many times.

> Recording the physics once and replaying only the encoder took an experiment
> from ~60 s on a GPU to **0.3 s** on a CPU, and made results exact. Verify the
> replay reproduces the live path cell-for-cell before trusting it.

**Assert that your buckets partition the whole.** A funnel whose categories do
not sum to the total is decoration.

> A six-gate drop attribution has a test asserting the gates partition the
> candidates, so the cross-tab reconciles against a number computed
> independently.

**A fix with a good argument and no measurement is still a hypothesis.** Ship
the measurement, not the argument.

> Three well-reasoned changes measured as: +5–8% cost and zero benefit; zero
> occurrences of the condition it guarded; and no change at all. Two were
> reverted, one kept explicitly labelled as no improvement.

**Re-measure the exact numbers you used to state the problem.** Not adjacent
ones, not "it looks better".

## Traps around the work itself

**The fixture is code and can be wrong.** A harness defect is indistinguishable
from a product defect in the output, and you will chase the product.

> Two fixture bugs in one evening: a scenario that aimed at a different target
> each run because ties were broken by hash order, and a random-number range of
> `[0, 0.5)` that made one parameter mean twice what it said and silently do
> nothing above 0.5.

**A fix in the failure-handling path is untested code with a large blast
radius.** Handling for a rare condition runs exactly when things are worst.

> A log-rotation fix, written to stop a full disk, held an fd on the file it
> rotated. Truncating a file another process holds open recreates it sparse at
> its old offset. It grew to 17.5 GB in eight minutes and took the disk to
> 319 MB free — worse than the problem.

**Confirm what is deployed, not what is committed.** They diverge silently.

> "Is it fixed?" was answered from the git log twice. The running binary
> predated three of the fixes.

**When the person watching the system contradicts your explanation, they are
usually right.** They have perceptual information your instruments do not.

> "Does that make sense though? The whole body is in my view." "The building
> appears to entirely move." Both overruled a confident wrong explanation, and
> both turned out to be precise descriptions of real, distinct bugs.

**Build the reporter's repro recipe rather than your own.** Theirs reproduces;
yours tests what you already believe.

## Reporting

**Separate what is measured from what is inferred, every time.** State the
number, then the interpretation, and let them be judged apart.

**Correct a reported finding as prominently as it was reported.** A wrong
number that was used to justify a direction has to be retracted in the place
the direction was set, not in a footnote.

**Name what a fix does not claim.** A change that improves four of five
symptoms should say which fifth it leaves, or the next person will assume it
was covered.
