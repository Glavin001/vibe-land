# Vehicle Mode Contracts

These invariants should hold unless we intentionally redesign the vehicle netcode.

## Local Preview Practice Mode

- `LocalPreviewTransport` may reuse `InputCmd`, snapshot, and ack structures, but only in memory.
- Practice mode must not send vehicle input over WebTransport or WebSocket.
- The local practice vehicle pose must come from authoritative `WasmLocalSession` snapshots.
- `VehiclePredictionManager` in local preview is input and ack bookkeeping only. It must not activate a second local vehicle physics sim or own the rendered chassis pose.

## Multiplayer Play Mode

- The local driven vehicle pose comes from `VehiclePredictionManager` prediction and reconciliation.
- Remote vehicles come from `VehicleInterpolator`.
- Multiplayer local vehicle rendering should not add a second chassis smoothing layer on top of the predicted pose. Camera smoothing may remain separate.

## Regression Guardrail

- If a change makes `/practice` require `setLocalVehicle`, `tickVehicle`, or `reconcileVehicle` for the local car to look correct, that change has violated the practice-mode contract.
