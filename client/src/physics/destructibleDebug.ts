export type DestructibleDebugState = {
  impactSeq: number;
  impactProcessed: number;
  impactMaxForceN: number;
  impactMaxSpeedMs: number;
  impactMaxSplashNodes: number;
  impactMaxBodyNodeCount: number;
  impactMaxSplashWeightSum: number;
  impactMaxEstimatedInjectedForceN: number;
  impactInstanceId: number;
  fractureSeq: number;
  fractureInstanceId: number;
  fractureInstanceBodyCount: number;
  fractures: number;
  splitEvents: number;
  newBodies: number;
  activeBodies: number;
  postFractureMaxBodySpeedMs: number;
  postFractureFastBodyCount: number;
  sameInstanceDynamicCollisionStarts: number;
  fixedCollisionStarts: number;
  dynamicMinBodyY: number;
  parentlessStaticCollisionStarts: number;
  dynamicMinBodyInstanceId: number;
  dynamicMinBodySpeedMs: number;
  dynamicMinBodyLinvelY: number;
  dynamicMinBodyHasSupport: boolean;
  dynamicMinBodyActiveContactPairs: number;
  dynamicMinBodySameInstanceFixedContactPairs: number;
  dynamicMinBodyParentlessStaticContactPairs: number;
  currentMaxBodySpeedMs: number;
  currentMaxBodySpeedInstanceId: number;
  dynamicMinBodyX: number;
  dynamicMinBodyZ: number;
  dynamicMinBodyMaxLocalOffsetM: number;
  dynamicMinBodyCcdEnabled: boolean;
  contactEventsSeenTotal: number;
  contactEventsMatchingTotal: number;
  contactEventsOtherDestructibleSkippedTotal: number;
  contactEventsBelowForceSkippedTotal: number;
  contactEventsMissingPartnerBodySkippedTotal: number;
  contactEventsBelowSpeedSkippedTotal: number;
  contactEventsMissingBodyOrNodeSkippedTotal: number;
  contactEventsAcceptedTotal: number;
  contactEventsMaxRawForceN: number;
  contactEventsMaxPartnerSpeedMs: number;
  contactEventsCollisionGraceOverridesTotal: number;
  contactEventsCooldownSkippedTotal: number;
  contactEventsForceCappedTotal: number;
};

export type DestructibleDebugConfig = {
  contactSplashRadiusM: number;
  contactForceScale: number;
  minImpactForceN: number;
  minImpactSpeedMs: number;
  collisionImpactGraceSecs: number;
  wallMaterialScale: number;
  towerMaterialScale: number;
  maxFracturesPerFrame: number;
  maxNewBodiesPerFrame: number;
  applyExcessForces: boolean;
  debrisCollisionMode: 'all' | 'noDebrisPairs' | 'debrisGroundOnly' | 'debrisNone';
  impactCooldownSecs: number;
  maxInjectedImpactForceN: number;
};

export const EMPTY_DESTRUCTIBLE_DEBUG_STATE: DestructibleDebugState = Object.freeze({
  impactSeq: 0,
  impactProcessed: 0,
  impactMaxForceN: 0,
  impactMaxSpeedMs: 0,
  impactMaxSplashNodes: 0,
  impactMaxBodyNodeCount: 0,
  impactMaxSplashWeightSum: 0,
  impactMaxEstimatedInjectedForceN: 0,
  impactInstanceId: 0,
  fractureSeq: 0,
  fractureInstanceId: 0,
  fractureInstanceBodyCount: 0,
  fractures: 0,
  splitEvents: 0,
  newBodies: 0,
  activeBodies: 0,
  postFractureMaxBodySpeedMs: 0,
  postFractureFastBodyCount: 0,
  sameInstanceDynamicCollisionStarts: 0,
  fixedCollisionStarts: 0,
  dynamicMinBodyY: 0,
  parentlessStaticCollisionStarts: 0,
  dynamicMinBodyInstanceId: 0,
  dynamicMinBodySpeedMs: 0,
  dynamicMinBodyLinvelY: 0,
  dynamicMinBodyHasSupport: false,
  dynamicMinBodyActiveContactPairs: 0,
  dynamicMinBodySameInstanceFixedContactPairs: 0,
  dynamicMinBodyParentlessStaticContactPairs: 0,
  currentMaxBodySpeedMs: 0,
  currentMaxBodySpeedInstanceId: 0,
  dynamicMinBodyX: 0,
  dynamicMinBodyZ: 0,
  dynamicMinBodyMaxLocalOffsetM: 0,
  dynamicMinBodyCcdEnabled: false,
  contactEventsSeenTotal: 0,
  contactEventsMatchingTotal: 0,
  contactEventsOtherDestructibleSkippedTotal: 0,
  contactEventsBelowForceSkippedTotal: 0,
  contactEventsMissingPartnerBodySkippedTotal: 0,
  contactEventsBelowSpeedSkippedTotal: 0,
  contactEventsMissingBodyOrNodeSkippedTotal: 0,
  contactEventsAcceptedTotal: 0,
  contactEventsMaxRawForceN: 0,
  contactEventsMaxPartnerSpeedMs: 0,
  contactEventsCollisionGraceOverridesTotal: 0,
  contactEventsCooldownSkippedTotal: 0,
  contactEventsForceCappedTotal: 0,
});

export const EMPTY_DESTRUCTIBLE_DEBUG_CONFIG: DestructibleDebugConfig = Object.freeze({
  contactSplashRadiusM: 0,
  contactForceScale: 0,
  minImpactForceN: 0,
  minImpactSpeedMs: 0,
  collisionImpactGraceSecs: 0,
  wallMaterialScale: 0,
  towerMaterialScale: 0,
  maxFracturesPerFrame: 0,
  maxNewBodiesPerFrame: 0,
  applyExcessForces: false,
  debrisCollisionMode: 'all',
  impactCooldownSecs: 0,
  maxInjectedImpactForceN: 0,
});

export function parseDestructibleDebugState(raw: ArrayLike<number> | null | undefined): DestructibleDebugState {
  const values = Array.from(raw ?? []);
  const num = (index: number) => values[index] ?? 0;
  return {
    impactSeq: num(0),
    impactProcessed: num(1),
    impactMaxForceN: num(2),
    impactMaxSpeedMs: num(3),
    impactMaxSplashNodes: num(4),
    impactMaxBodyNodeCount: num(5),
    impactMaxSplashWeightSum: num(6),
    impactMaxEstimatedInjectedForceN: num(7),
    impactInstanceId: num(8),
    fractureSeq: num(9),
    fractureInstanceId: num(10),
    fractureInstanceBodyCount: num(11),
    fractures: num(12),
    splitEvents: num(13),
    newBodies: num(14),
    activeBodies: num(15),
    postFractureMaxBodySpeedMs: num(16),
    postFractureFastBodyCount: num(17),
    sameInstanceDynamicCollisionStarts: num(18),
    fixedCollisionStarts: num(19),
    dynamicMinBodyY: num(20),
    parentlessStaticCollisionStarts: num(21),
    dynamicMinBodyInstanceId: num(22),
    dynamicMinBodySpeedMs: num(23),
    dynamicMinBodyLinvelY: num(24),
    dynamicMinBodyHasSupport: num(25) !== 0,
    dynamicMinBodyActiveContactPairs: num(26),
    dynamicMinBodySameInstanceFixedContactPairs: num(27),
    dynamicMinBodyParentlessStaticContactPairs: num(28),
    currentMaxBodySpeedMs: num(29),
    currentMaxBodySpeedInstanceId: num(30),
    dynamicMinBodyX: num(31),
    dynamicMinBodyZ: num(32),
    dynamicMinBodyMaxLocalOffsetM: num(33),
    dynamicMinBodyCcdEnabled: num(34) !== 0,
    contactEventsSeenTotal: num(35),
    contactEventsMatchingTotal: num(36),
    contactEventsOtherDestructibleSkippedTotal: num(37),
    contactEventsBelowForceSkippedTotal: num(38),
    contactEventsMissingPartnerBodySkippedTotal: num(39),
    contactEventsBelowSpeedSkippedTotal: num(40),
    contactEventsMissingBodyOrNodeSkippedTotal: num(41),
    contactEventsAcceptedTotal: num(42),
    contactEventsMaxRawForceN: num(43),
    contactEventsMaxPartnerSpeedMs: num(44),
    contactEventsCollisionGraceOverridesTotal: num(45),
    contactEventsCooldownSkippedTotal: num(46),
    contactEventsForceCappedTotal: num(47),
  };
}

export function parseDestructibleDebugConfig(raw: ArrayLike<number> | null | undefined): DestructibleDebugConfig {
  const values = Array.from(raw ?? []);
  const num = (index: number) => values[index] ?? 0;
  const debrisCollisionModeCode = num(10);
  return {
    contactSplashRadiusM: num(0),
    contactForceScale: num(1),
    minImpactForceN: num(2),
    minImpactSpeedMs: num(3),
    collisionImpactGraceSecs: num(4),
    wallMaterialScale: num(5),
    towerMaterialScale: num(6),
    maxFracturesPerFrame: num(7),
    maxNewBodiesPerFrame: num(8),
    applyExcessForces: num(9) !== 0,
    debrisCollisionMode:
      debrisCollisionModeCode === 1 ? 'noDebrisPairs'
        : debrisCollisionModeCode === 2 ? 'debrisGroundOnly'
          : debrisCollisionModeCode === 3 ? 'debrisNone'
            : 'all',
    impactCooldownSecs: num(11),
    maxInjectedImpactForceN: num(12),
  };
}
