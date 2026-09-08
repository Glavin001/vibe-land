# Embedded downtown idle fix deployed

The existing demo now uses the qualified native coarse-row CUDA schedule,
Direct GPU disabled and native sleeping enabled. The scene remains 27 groups,
24,105 chunks and 74,543 bonds; material and correction settings are unchanged.

[Generated paired idle/impact report](../../../physx-2/qualification/vibe-downtown-idle-fix-20260908/report.md)
contains all samples, startup/impact peaks, test evidence and runtime hashes.
[Browser verification](../../../physx-2/qualification/vibe-downtown-idle-fix-20260908/browser-summary.json)
covers movement, physical shooting, native correction, rendering membership,
settling/sleep and reset. Timing remains above real-time during destruction;
this fixes the severe pristine-idle bottleneck, not the entire scaling goal.

The consumer benchmark accepts an optional recorded command tape after its
scene argument, so authored downtown idle and impact runs share identical
physical settings. Tapes require the frozen projectile mass/radius/velocity;
recorded insertion occurs inside the complete-step timer.
