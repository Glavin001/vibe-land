# Qualification and crash fix

The 256-building run crashed in three baseline attempts during the second wave.
Debugger captures locate `PxContactPair::extractContacts` inside the game callback,
with a null patch pointer and nonzero contact count. Engine commit `6ef3fd47`
invalidates both actor and shape contact-report stamps before reusing the trial
report allocator. It preserves accepted-tick timestamps and contact notifications.

The fixed build completes all three reported 600-step scenarios. Eight ordinary
native tests and the frozen penetration regression pass. The small callback
fixture passed before the fix too; the large game-consumer workload is the crash
reproducer. This is a correctness fix, not evidence of an equal-input speedup.

The rebuilt public server passes browser join/shoot/move/settle/reset: 444 chunks,
896 bonds, six physical rounds, 229 broken bonds and 44 fragment groups. Thirty
settling samples have minimum fragment COM y = 0.479998 m. Reset yields zero
broken bonds and zero detached groups. [Inspected screenshot](browser-after.png).
Six resource-loading errors (one COEP, five 404) remain in the browser capture;
this is not a claim of error-free asset loading or exhaustive gameplay coverage.

The capture receipt records the parent revisions and hashes of the tested WIP
sources/binaries. The server was stopped for isolated sequential physics runs and
restored automatically. The public deployment remains on the one-building scene.
No external-internet browser connectivity or large-scene browser rendering was
qualified by these local tests.
