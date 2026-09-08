# Optimized native integration: browser check

The deployed server uses engine `69fe462a`, with Direct GPU API **off**, native
sleep **on**, one correction and at most two stress evaluations. The production
Cargo dependency graph excludes the diagnostic profiling feature.

Browser join, physical shooting, movement, settling and reset passed. Workload:
**444 chunks / 896 bonds**, six 18,000 kg rounds at 40 m/s; 310 bonds broke and
74 fragment groups were published. Thirty one-second settling samples remained
above the ground (minimum COM y 0.479996 m). Reset returned to zero broken bonds
and detached groups. The inspected [screenshot](after.png) shows the opened wall
with the main structure standing.

Inputs are browser-timed and differ from earlier browser runs. These numbers are
not a physical-output comparison or performance qualification. Six resource-load
errors remain (one COEP, five 404); no clean-resource claim is made. Public-network
browser connectivity is not independently verified by this local WebTransport
check. The service is left running on the single-building scene.

The SDK's generated large-scene comparison is
`qualification/vibe-consumer-local-report-repair-20260908/report.md`; it archives
one baseline and two 600-step runs at 256 buildings / 113,664 chunks / 229,376
bonds / 768 rounds. The observed fracture-peak improvement is 21.2% using the worse
candidate. This is not an every-step 60 Hz or endurance pass.
