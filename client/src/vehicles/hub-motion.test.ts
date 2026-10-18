import {describe, expect, it} from 'vitest';
import {Matrix4, Vector3} from 'three';
import {defaultConfiguration, modelParameters} from './configuration.mjs';
import {VisualRig} from './dune/visual-rig.mjs';
import {neutralPose} from './dune/vehicle-rig.mjs';

describe('separate rotating hub visuals', () => {
  it('shares the wheel rotation and suspension pose while the caliper only steers', () => {
    const rig = new VisualRig({parameters:modelParameters(defaultConfiguration()), parts:[]});
    const matrix = new Matrix4().makeTranslation(-.94,.515,-1.31);
    const part = (role: string) => ({motion:{role,corner:'fl'},matrix});
    const point = (role: string) => new Vector3().setFromMatrixPosition(rig.matrixFor(part(role)));
    const pose = neutralPose();
    pose.wheels.fl.travelM = .06;
    pose.wheels.fl.steeringRad = .2;
    rig.applyPose(pose);
    const beforeHub = point('hub'), beforeCaliper = point('knuckle');
    pose.wheels.fl.rotationRad = Math.PI / 2;
    rig.applyPose(pose);
    expect(point('hub').distanceTo(point('wheel'))).toBeLessThan(1e-10);
    expect(point('hub').distanceTo(beforeHub)).toBeGreaterThan(.1);
    expect(point('knuckle').distanceTo(beforeCaliper)).toBeLessThan(1e-10);
    rig.applyPose(neutralPose());
    expect(point('hub').distanceTo(new Vector3().setFromMatrixPosition(matrix))).toBeLessThan(1e-10);
  });
});
