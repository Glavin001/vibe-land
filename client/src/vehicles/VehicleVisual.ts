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
  private assembly = new LiveAssembly(this.group, this.palette);
  private model: any;
  private rig: VisualRig | null = null;
  private key = '';
  private configuration!: VehicleConfiguration;
  private hidden = new Set<string>();
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
    this.key = key;
  }
  inspect(explosion: number, wireframe: boolean, hidden = this.hidden): void {
    this.explosion = explosion; this.hidden = hidden;
    Object.values(this.palette).forEach(m => { m.wireframe = wireframe; });
    this.assembly.update(this.model, explosion, hidden);
    this.assembly.bindMotion();
  }
  setWheelState(wheels: {travelM: number; steeringRad: number; rotationRad: number; grounded: boolean}[]): void {
    if (wheels.length !== 4) return;
    const pose = { chassis: { position: [0,0,0], rotation: [0,0,0,1] },
      wheels: Object.fromEntries(sourceCornerForWheel.map((id, i) => [id, {
        ...wheels[i], rotationRad: -wheels[i].rotationRad,
      }])) };
    this.rig!.applyPose(pose);
    this.assembly.applyMotion(this.rig);
  }
  dispose(): void {
    this.assembly.dispose(); this.source.dispose();
    Object.values(this.palette).forEach(m => m.dispose());
    this.group.removeFromParent();
  }
}
