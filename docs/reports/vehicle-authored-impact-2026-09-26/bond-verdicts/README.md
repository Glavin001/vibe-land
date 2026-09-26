# Joint observation and unequal-mass regression

The native diagnostic now includes the bending contribution when reporting
compression, tension and material utilisation. Raw normal/bending stress,
remaining area, damage and broken state are also exposed with an explicit
availability flag (the legacy Blast query does not supply these fields).
These changes observe native verdicts; they do not alter simulated damage.

The new supported-cantilever regression checks both fibre-bending modes,
individual readout values and the sampled aggregate. It passes with the prior
12 bridge tests: [report](bridge-report.json), [log](bridge-tests.log).
The six unchanged full-model shots now retain their complete contact-time
verdicts: [frames and joints](impact.json.gz), [output](impact.log).

These observations exposed a separate physical error: native GPU stress
preparation sets every dynamic mass/inertia weight to one. A three-node
cantilever with a support, a 1 kg part and a 100 kg part reports **196.2 N** at
its root instead of the independently known **990.81 N** gravity reaction.
See the [failing unequal-mass test](mass-balance-before.log). This is not a
tolerance failure: the solve converges for the wrong equalized-mass problem.

The unequal-mass regression is deliberately red until native preparation honors
authored masses. The verifier now requires that test as well (14 total bridge
tests). Do not lower joint strengths to compensate for this load error.
