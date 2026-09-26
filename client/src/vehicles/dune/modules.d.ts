declare module '*dune/live-geometry.mjs' {
 export class LiveGeometry { build(parameters: any): any; dispose(): void; }
 export class LiveAssembly { constructor(group: any, materials: any); meshes: any[]; update(model: any, explosion: number, hidden: Set<string>, explosionCenters?: Map<string, number[]>): void; bindMotion(): void; applyMotion(rig: any): void; dispose(): void; }
}
declare module '*dune/visual-rig.mjs' { export class VisualRig { constructor(model: any); definition: any; applyPose(pose: any): void; restore(): void; } }
declare module '*dune/buggy.mjs' { export const materials: Record<string, {color: string; roughness: number; metalness: number; density: number}>; }
