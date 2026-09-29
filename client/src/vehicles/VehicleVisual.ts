import * as THREE from 'three';
import { LiveGeometry, LiveAssembly } from './dune/live-geometry.mjs';
import { VisualRig } from './dune/visual-rig.mjs';
import { materials } from './dune/buggy.mjs';
import { geometryKey, modelParameters, normalizeConfiguration, resolveVehicleGeometry, sourceCornerForWheel, type VehicleConfiguration } from './configuration.mjs';

/** One renderer for workshop, live sessions, and replays. Owns all GPU resources. */
export class VehicleVisual {
  readonly group = new THREE.Group();
  private source = new LiveGeometry();
  private palette = Object.fromEntries(Object.entries(materials).map(([key, value]) => [key,
    new THREE.MeshStandardMaterial({ color: value.color, roughness: value.roughness, metalness: value.metalness })]));
  private bodyPaint = this.palette.frame.clone();
  private wheelPaint = this.palette.alloy.clone();
  private assembly = new LiveAssembly(this.group, this.palette);
  private model: any;
  private rig: VisualRig | null = null;
  private key = '';
  private configuration!: VehicleConfiguration;
  private hidden = new Set<string>();
  /** Visual part ids per native fracture part index (metadata.json parts[].visualIds). */
  private fractureGroups: string[][] | null = null;
  private readonly partMatrix = new Map<string, THREE.Matrix4>();
  /** Visual ids drawn loose last frame, so a part back on the car is restored. */
  private detachedIds = new Set<string>();
  private explosion = 0;
  constructor(configuration: VehicleConfiguration, private readonly actorSpace = false) {
    this.configure(configuration);
    if (actorSpace) {
      this.group.rotation.y = Math.PI;
      this.group.position.y = -resolveVehicleGeometry(configuration).originHeight;
    }
  }
  get partCount(): number { return this.model.parts.length; }
  get parts(): {id: string; name: string; system: string}[] { return this.model.parts; }
  configure(value: VehicleConfiguration): void {
    const config = normalizeConfiguration(value), key = geometryKey(config);
    this.palette.frame.color.set(config.finish);
    this.bodyPaint.color.set(config.appearance.body);
    this.palette.orange.color.set(config.appearance.accent);
    this.palette.belt.color.set(config.appearance.accent);
    this.palette.race.color.set(config.appearance.accent);
    this.wheelPaint.color.set(config.appearance.wheels);
    this.palette.seat.color.set(config.appearance.seats);
    const roughness = {matte:.85,satin:.36,gloss:.16}[config.appearance.paint];
    this.palette.frame.roughness = this.bodyPaint.roughness = roughness;
    this.configuration = config;
    if (this.actorSpace) this.group.position.y = -resolveVehicleGeometry(config).originHeight;
    if (key === this.key) return;
    this.rig?.restore();
    // Dimension-specific template keys must not accumulate while dragging sliders.
    this.assembly.dispose();
    this.source.dispose();
    this.source = new LiveGeometry();
    this.model = this.source.build(modelParameters(config));
    this.rig = new VisualRig(this.model);
    this.assembly.update(this.model, this.explosion, this.hidden);
    this.assembly.bindMotion();
    this.applyPaint();
    this.key = key;
  }
  inspect(explosion: number, wireframe: boolean, hidden = this.hidden, explosionCenters?: Map<string, number[]>): void {
    this.explosion = explosion; this.hidden = hidden;
    [...Object.values(this.palette),this.bodyPaint,this.wheelPaint].forEach(m => { m.wireframe = wireframe; });
    this.assembly.update(this.model, explosion, hidden, explosionCenters);
    this.assembly.bindMotion();
    this.applyPaint();
  }
  private applyPaint(): void {
    for (const mesh of this.assembly.meshes) {
      if (mesh.userData.system === "Body" && mesh.userData.material === "frame") mesh.material = this.bodyPaint;
      if (mesh.userData.system === "Wheels" && mesh.userData.material === "alloy") mesh.material = this.wheelPaint;
    }
  }
  setFractureGroups(groups: string[][]): void { this.fractureGroups = groups; }
  hasFractureGroups(): boolean { return !!this.fractureGroups; }
  /** Draw parts that broke off at their server world poses. Call after setWheelState. */
  setDetached(detached: {part:number; position:[number,number,number]; rotation:[number,number,number,number]}[]): void {
    if (!this.fractureGroups || (!detached.length && !this.detachedIds.size)) return;
    this.group.updateWorldMatrix(true, false);
    const toLocal = this.group.matrixWorld.clone().invert(), actor = this.group.matrix;
    if (!this.partMatrix.size) for (const part of this.model.parts) this.partMatrix.set(part.id, part.matrix);
    const world = new THREE.Matrix4(), quat = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const matrices = new Map<string, THREE.Matrix4>();
    for (const d of detached) {
      const ids = this.fractureGroups[d.part]; if (!ids) continue;
      world.compose(pos.set(...d.position), quat.set(...d.rotation), one);
      const base = toLocal.clone().multiply(world).multiply(actor);
      for (const id of ids) { const m = this.partMatrix.get(id); if (m) matrices.set(id, base.clone().multiply(m)); }
    }
    // Parts back on the car (a respawned car): their rest matrices again.
    const loose = new Set(matrices.keys());
    for (const id of this.detachedIds) if (!loose.has(id)) { const m = this.partMatrix.get(id); if (m) matrices.set(id, m.clone()); }
    this.detachedIds = loose;
    this.assembly.setDetached(matrices);
  }
  setWheelState(wheels: {travelM: number; steeringRad: number; rotationRad: number; grounded: boolean}[]): void {
    if (wheels.length !== 4) return;
    const pose = { chassis: { position: [0,0,0], rotation: [0,0,0,1] },
      wheels: Object.fromEntries(sourceCornerForWheel.map((id, i) => [id, {
        // A wheel the server no longer simulates arrives at neutral travel;
        // clamp anyway so a bad value can never throw parts metres away.
        ...wheels[i], travelM: Math.max(-1, Math.min(1, Number.isFinite(wheels[i].travelM) ? wheels[i].travelM : 0)), rotationRad: -wheels[i].rotationRad,
      }])) };
    this.rig!.applyPose(pose);
    this.assembly.applyMotion(this.rig);
  }
  dispose(): void {
    this.assembly.dispose(); this.source.dispose();
    Object.values(this.palette).forEach(m => m.dispose());
    this.bodyPaint.dispose(); this.wheelPaint.dispose();
    this.group.removeFromParent();
  }
}
