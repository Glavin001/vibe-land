import * as THREE from 'three';
import { LiveGeometry, LiveAssembly } from './dune/live-geometry.mjs';
import { VisualRig } from './dune/visual-rig.mjs';
import { materials } from './dune/buggy.mjs';
import { geometryKey, modelParameters, normalizeConfiguration, resolveVehicleGeometry, sourceCornerForWheel, type VehicleConfiguration } from './configuration.mjs';
import { LooseParts, type BodyPose } from './looseParts';

/** What drives a car's visual: its wheels and its broken-off bodies (a PKT_VEHICLE_RIG). */
export interface VehicleRigState {
  wheels: readonly { travelM: number; steeringRad: number; rotationRad: number; grounded: boolean }[];
  detached?: readonly BodyPose[];
}

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
  /** The parts that broke off: bodies of their own, drawn in world space. */
  private readonly loose = new LooseParts(this.assembly);
  /** The rig last applied, and the wheel state last posed: work only on change. */
  private appliedRig: VehicleRigState | null = null;
  private readonly wheelState = new Float64Array(16).fill(Number.NaN);
  private explosion = 0;
  constructor(configuration: VehicleConfiguration, private readonly actorSpace = false) {
    this.configure(configuration);
    if (actorSpace) {
      this.group.rotation.y = Math.PI;
      this.group.position.y = -resolveVehicleGeometry(configuration).originHeight;
    }
  }
  /**
   * The car's broken-off parts, in world space. The caller places it in the
   * world beside the car's group, not under it: a loose part does not move
   * with the car.
   */
  get debris(): THREE.Group { return this.loose.group; }
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
    // A new model: its parts start on the car, and the next rig is drawn in full.
    this.loose.discard();
    this.partMatrix.clear();
    this.appliedRig = null;
    this.wheelState.fill(Number.NaN);
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
  /**
   * Apply a rig: pose the wheels and draw the broken-off bodies. Work is done
   * only for what changed since the last rig -- the wheel state, and each body
   * whose pose moved -- so a parked car or a settled wreck costs nothing, and
   * the same rig applied again (every frame until the next one) is free.
   */
  applyRig(rig: VehicleRigState): void {
    if (rig === this.appliedRig) return;
    this.setWheelState(rig.wheels);
    const bodies = rig.detached ?? [];
    if (!bodies.length) {
      if (this.loose.size) this.loose.reset(id => this.restingMatrix(id));
    } else if (this.fractureGroups) {
      this.group.updateMatrix();
      if (!this.partMatrix.size) for (const part of this.model.parts) this.partMatrix.set(part.id, part.matrix);
      this.loose.apply(bodies, this.fractureGroups, this.group.matrix, id => this.partMatrix.get(id));
    } else {
      // Which visual parts a body carries is not known yet (metadata.json):
      // apply this rig again once it is.
      return;
    }
    this.appliedRig = rig;
  }
  /** A part's pose back on the car: its motion pose, or its authored one. */
  private restingMatrix(id: string): THREE.Matrix4 {
    const part = this.model.parts.find((p: { id: string }) => p.id === id);
    return part?.motion && this.rig ? this.rig.matrixFor(part).clone() : (part?.matrix ?? new THREE.Matrix4());
  }
  /**
   * Diagnostics: where the first `max` loose parts are DRAWN (world
   * position of each part's instance), in a stable order. Read by the opt-in
   * vehicle trace to catch parts flickering between two places.
   */
  drawnLooseParts(max = 16): { id: string; position: [number, number, number]; center: [number, number, number]; rotation: [number, number, number, number] }[] {
    return this.loose.drawn(max);
  }
  setWheelState(wheels: readonly {travelM: number; steeringRad: number; rotationRad: number; grounded: boolean}[]): void {
    if (wheels.length !== 4) return;
    // The suspension is solved only when the wheels moved.
    let same = true;
    wheels.forEach((w, i) => {
      const at = i * 4, grounded = w.grounded ? 1 : 0;
      if (this.wheelState[at] !== w.travelM || this.wheelState[at + 1] !== w.steeringRad
        || this.wheelState[at + 2] !== w.rotationRad || this.wheelState[at + 3] !== grounded) same = false;
      this.wheelState[at] = w.travelM; this.wheelState[at + 1] = w.steeringRad;
      this.wheelState[at + 2] = w.rotationRad; this.wheelState[at + 3] = grounded;
    });
    if (same) return;
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
    this.loose.dispose();
    this.assembly.dispose(); this.source.dispose();
    Object.values(this.palette).forEach(m => m.dispose());
    this.bodyPaint.dispose(); this.wheelPaint.dispose();
    this.group.removeFromParent();
  }
}
