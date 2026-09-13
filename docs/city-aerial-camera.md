# City aerial camera

On `/city`, select **Fly camera** or press **N** after joining. Click the scene
to capture the mouse, then use the normal movement bindings to fly in the
viewing direction. Defaults:

- **W/A/S/D**: move; **mouse**: look.
- **Space**: rise; **C**: descend; **Shift**: 3× speed boost.
- **Esc**: release the mouse to use the panel. Set **Flight speed** between
  5 and 100 m/s (default 30).
- **N** or **Return to player**: move your character to the flying camera
  position, keep its facing direction, and drop under normal gravity.

The shared input system also supplies touch/gamepad movement, look,
jump/crouch, and sprint. Desktop controls are covered by the browser check;
physical gamepad and touch devices have not been checked.

This is a public inspection camera, not an authenticated administrator role.
While flying, it passes through geometry without moving the player or granting
invulnerability. Returning explicitly moves the player body to the camera
position, clears velocity, and resumes normal gravity and collision. Health
and energy are preserved; a seated player exits their vehicle. While active it sends neutral gameplay
input: movement, shooting, interaction, and agent-drive commands cannot act
through the grounded player. Existing physical forces can still affect the
player or their vehicle. Flight resets on network disconnect/rejoin; only the explicit Return action
(or N toggle) requests a drop.

For the aerial view, the camera's far plane expands to 4 km and fog density is
capped at 0.001 before the weather intensity multiplier. Normal view distance
and saved fog settings return on exit. The complete static city manifest is
available for inspection. Other players and moving debris still use the
server's existing interest region around the grounded player; this feature
adds no remote spectator streaming protocol.

## Implementation and validation

`client/src/scene/aerialFlight.ts` implements camera movement independently
from player prediction. It normalizes combined axes, retains analog input,
uses elapsed frame time, and caps a stalled frame at 100 ms. `GameWorld`
keeps aerial look angles separate from grounded aim and neutralizes both
ordinary and automated gameplay input. Return copies the aerial facing
direction and holds the view briefly until an authoritative snapshot confirms
the new position, then follows the falling body. Interactive controls must not trigger
document-level pointer lock, and the flight shortcut must ignore editable UI.

Run the focused checks:

```sh
npm run test --prefix client -- src/net/cityCameraDrop.test.ts src/scene/aerialFlight.test.ts src/input/resolver.test.ts
npm run lint --prefix client
```

The non-destructive browser check accepts an HTTPS client origin, the server's
local WebTransport port, and a private report path:

```sh
timeout 240 node client/tools/city-flight-smoke.mjs https://127.0.0.1:18483 4433 /tmp/city-flight.json
```

It checks city rendering, independent camera/player positions, rise, forward
flight, boost, descent, relative look input, suppressed firing/agent movement,
speed controls, return, shortcut, and resumed walking. It does not reset or
shoot the city. It overwrites the result as incomplete before starting; require
successful process exit and `ok: true`, and bind the report to the candidate
client hash before promotion. The screenshot uses the disposable FAST render
profile and is not a visual-quality or performance certification.

Headless Chromium's absolute mouse movements while pointer-locked can emit
paired opposite deltas due to pointer recentering. The check therefore sends
explicit relative `MouseEvent` deltas through the normal DOM input listener;
it does not establish physical OS mouse behavior. Keyboard movement and UI
controls use browser automation. The loopback WebTransport rewrite preserves
the path and certificate pin; it does not prove external UDP reachability.

## Deployment lessons

For a client-only change in a shared dirty checkout, a generic combined build
may pick up someone else's unfinished backend changes. On September 13 the
helper encountered a concurrently added `equilibrium` module before its file
was written. The aerial update instead built the client into the helper's
staging directory and retained the previously qualified, immutable Blast
executable. Do not fix, revert, or deploy another task's changes just to make
a combined command pass.

Record frontend and backend provenance separately in this situation. The
initial aerial deployment retained game `b72d3e5` plus the documented standalone HTTPS fixes and
preserved local changes, using solver `7c09837e` plus its recorded local changes.
That initial executable SHA-256 was
`41c7906de1d7135bdb5adfb33885c375257b3f8ad836255fc82b5e46acd39df9`.
No `physx-2` native destruction integration is introduced. See
[the Blast deployment report](blast-return-deployment-2026-09-13.md) for original
source and runtime details.

Keep the previous client and immutable server executable for rollback. Copy
hashed assets before replacing the entry document, retain old hashed assets
for open tabs, and verify the served bytes and browser behavior after
publication. Disconnecting an active player requires session authorization;
the user explicitly authorized disconnecting their own session for this update.

## Returning from flight: server contract

Client packet `PKT_CITY_CAMERA_DROP` (10) contains five little-endian float32
values: body position x/y/z and camera yaw/pitch. It has no target player ID;
the sending connection selects its own player. The server
only accepts it in city matches for a living player, validates finite bounded
coordinates and pitch, and limits repeated drops to one per 500 ms. It clears
queued movement before resuming normal simulation. Existing packet IDs and
payloads are unchanged. The client keeps the WT control stream open and sends
the one-shot drop reliably; movement still uses datagrams where available.

Rapier relocates its player collider. PhysX recreates the capsule controller
at the requested position through the existing bridge APIs, preserving player
identity/state and clearing vehicle ownership. No native destruction behavior
changes. If creating the replacement controller fails, the old controller is
restored. A request rejected by the server times out back to the normal view;
a browser console warning records the missing confirmation.

`client/tools/city-camera-drop-smoke.mjs` uses the same three arguments as the
flight smoke check. It checks horizontal relocation in authoritative snapshots,
negative vertical velocity, camera following the falling body, and landing at
the new location without shooting, losing chunks, or state divergence. Run
with an outer 240-second timeout. Shared physics tests cover gravity, player
state preservation, rejection, and vehicle exit; server decoder tests cover
both inbound transports, malformed lengths, and invalid coordinates. The
client test checks all packet IDs for uniqueness: city resync already uses 9.

For the drop deployment, build in an isolated checkout from the published
aerial revision and solver `7c09837e`, then copy only the requested changes.
Set both Cargo's solver dependency and `BLAST_ROOT` to that isolated solver.
This permits a new server build without picking up another task's unfinished
stress/bridge changes in the shared checkout. Retain the saved scene and
settings, previous executable/client, and exact candidate hashes in the
private deployment receipt before restarting.

The pre-deployment executable check also detected a newer live diagnostic
build (`3c68760d…`) than the initial aerial release. Its completed stress
telemetry additions and equilibrium module were copied into the isolated
candidate, with per-file hashes recorded privately, so the drop update does
not revert them. They remain uncommitted work owned by the other task; only
the camera-drop changes belong in this feature commit. Always compare the
current executable before stopping it instead of trusting an older receipt
or the release hash inherited in its environment.

Vehicle exit must restore collision filtering as well as clear ownership.
Rapier disables the player collider's groups while seated; the drop method
restores the standard capsule groups before gravity resumes. The regression
test checks both ownership and collision groups to prevent a player falling
through the floor after leaving a vehicle.
