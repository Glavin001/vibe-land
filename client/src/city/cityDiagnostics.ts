// Is anyone actually looking at the city's diagnostics?
//
// The city layer runs a 2 Hz sweep that composes the world pose of EVERY chunk
// to derive ground penetration, floating settled islands, the deepest chunk and
// the drawn-vs-ledger delta. At downtown's 33,221 chunks that is 3.1 ms, and it
// ran unconditionally -- for every player, whether or not the panel existed on
// their screen. On a touch device the panel defaults to hidden, so a phone was
// paying a 3.1 ms hitch twice a second for numbers it never displayed.
//
// Amortised it is only ~0.1 ms a frame, which is why it never showed up in an
// average. It is a SPIKE, and spikes are what frame-pacing and p95 measure.
//
// Ref-counted rather than a boolean: the panel, the netlab recorder and the e2e
// bridge can all want diagnostics at once, and whichever releases first must
// not switch them off underneath the others.

let holders = 0;

/**
 * Claim diagnostics for as long as the returned function is uncalled.
 *
 * Idempotent per call site by construction -- each acquire owns exactly one
 * release, and a double release is ignored so a React strict-mode double
 * unmount cannot drive the count negative.
 */
export function acquireCityDiagnostics(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
  };
}

/** Whether the expensive per-chunk sweeps are worth running this frame. */
export function cityDiagnosticsWanted(): boolean {
  return holders > 0;
}

/** Test seam: current holder count, so a unit test can assert the balance. */
export function cityDiagnosticsHolders(): number {
  return holders;
}
