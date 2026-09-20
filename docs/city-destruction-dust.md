# Destruction dust on /city

Dust and smoke for building destruction, proportional to what broke, at
any distance the player can see, within a fixed GPU budget. Added
2026-09-20. Modelled on the Ember VFX lab's map-scale parcel layer, not its
WebGPU fluid solver (our client is three 0.170 / WebGL2).

## Where the dust comes from

No server or wire change. `PKT_CITY_TOPOLOGY` names broken bonds and born
islands; the binary manifest carries every bond's centroid, normal, area
and material, which `manifestBinary.ts` now keeps as views instead of
skipping (zero extra bytes: the buffer was already pinned).

- `client/src/city/destructionEvents.ts` — joins an applied topology
  message to the manifest and ledger: fractures at the bonds (through
  whichever chunk carries them now), sheds at a born island's centre of
  mass, impacts where a fast island came to rest. Clustered into 4 m cells,
  largest first, capped per message, ordinals fixed by cell so a replay
  numbers itself the same way.
- `client/src/city/dustPolicy.ts` — sources to parcels: count `∝ m^0.5`
  (≤ 8), radius `∝ m^⅓`, thickness from material, thrown out along the face
  normal, 32 parcels per tick, a smoulder that keeps a broken cell puffing
  while breaks keep arriving. Seeded by hash; never random.
- `client/src/city/cityClient.ts` — `extractDust` after each apply (stamped
  a playout delay into the future on wire v2 so the puff appears with the
  crack), `drainDustSources` per frame.

## How it is drawn

- `client/src/vfx/dustParcelStore.ts` — the ring of immutable births;
  centre, size and fade are pure functions of age.
- `client/src/graphics/FramePipeline.tsx` — the offscreen frame (scene →
  beauty with depth → SSAO → stages → composite with ACES + sRGB). Replaced
  `AmbientOcclusion.tsx`; mounted when SSAO or volumetric dust is on.
- `client/src/vfx/DustVolumeRenderer.ts` — the pipeline stage: cull, tier,
  stable thinning, sample budget (scale steps → demote to half-res → shed),
  two instanced BackSide-box raymarches through one baked 128³ cloud
  (`dustFieldBake.ts`, GPU-baked over the first eight frames), scene-depth
  terminated, half-res layer brought up through a depth-weighted tent.
- `client/src/vfx/fluid/` — the near-camera fluid brick: Ember's stable
  fluids on a 2D slice atlas, 16×12×16 m, placed at the first source of
  magnitude ≥ 20 within 60 m, fed by every source inside it, colliding with
  the standing city, retired after 9 s quiet or 100 m away. Parcels inside
  it fade as it takes over.
- `client/src/vfx/DustSprites.tsx` — soft lit discs for FAST, touch, or a
  GL without highp / render-to-3D.
- `client/src/vfx/DustLayer.tsx` — the React glue, mounted after the city
  layer in `GameWorld.tsx`.

## Knobs

- Render quality (`app/renderQuality.ts`, persisted, F9 panel, e2e
  `setRenderQuality`): `dust` = off | sprites | volumetric (desktop default
  volumetric; FAST draws volumetric as sprites); `dustFluid` = off | fast |
  balanced (desktop default balanced, touch off; needs volumetric).
- Data side (`city/dustSettings.ts`): `?dust=0|1`, `?dustCap=N`,
  `?dustTick=N`, localStorage `vibe.city.dust`.
- Live look (`graphics/lookTuning.ts`, e2e `setLook`): `dustDensity`,
  `dustSize`, `dustLifetime`, `dustExtinction`, `dustPhaseG`,
  `dustSunBoost`, `dustBudgetM` (the per-frame sample ceiling, 12 M).

## Measuring

F9 shows `dust live/drawn`, `dust samples` against the budget, and
`dust dropped`. `renderStats` carries `dustParcelsLive/Drawn/DrawnHalf/
SamplesEstM/CpuMs/EmitMs/Emitted/Dropped/PassSkipped/FluidActive`. The
perf sweep has steps `dust off`, `dust sprites`, `dust fluid off`, `dust
fluid fast`. `__VIBE_E2E__.dustBurst({x,y,z,magnitude,kind})` spawns dust
without a server shot; `e2e/specs/city-dust.spec.ts` covers a real fracture
and a bridge burst (E2E_CITY=1).

Measured 2026-09-20 on an RTX 4090 shared with the PhysX server, 1080p,
vsync off, 300-frame samples: base frame p50 1.8 ms; parcels at the 12 M
budget +0.0–0.1 ms; fluid brick balanced +0.0 ms GPU, +0.1 ms CPU. The
Apple-laptop number is still to be taken; `dustBudgetM` and `dustFluid` are
the levers if it is over 2 ms.

## Limits and notes

- The player camera's far plane is 200 m and the fog is tuned to the 80 m
  area of interest, so nothing — dust or building — is visible beyond
  ~170 m from the player. The dust culls at the fog distance and scales to
  the aerial camera's 4 km / thin fog; seeing a collapse at 300 m needs a
  fog/far decision outside this feature.
- Parcels do not collide; the brick does, with static geometry only.
- The half-res layer's grain is smoothed by the upsample; native parcels
  keep the jittered march's fine grain, as SSAO does.
- ANGLE's Vulkan backend logs "Running out of reserved outsideRenderPass
  queueSerial" during a heavy collapse with the brick on (~20 render
  targets a frame). It is a performance note, not an error; not measured
  as a cost here.
