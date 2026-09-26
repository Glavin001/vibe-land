import {expect,it} from 'vitest';
import {Group} from 'three';
import {VehiclesRenderer} from './netEntityRenderers';
import {defaultConfiguration} from '../vehicles/configuration.mjs';
import type {VehicleStateMeters} from '../net/protocol';

it('retains vehicle meshes and instance buffers when a live tune changes asset identity',()=>{
  const renderer=new VehiclesRenderer(),group=new Group();
  const car:VehicleStateMeters={id:1,vehicleType:0,flags:0,driverId:10,
    position:[1,2,3],quaternion:[0,0,0,1],linearVelocity:[0,0,12],angularVelocity:[0,0,0],wheelData:[0,0,0,0],
    customVehicle:{assetHash:'a',geometryHash:'same-geometry',configuration:defaultConfiguration()}};
  const cars=new Map([[1,car]]);
  const pose=()=>({position:car.position,quaternion:car.quaternion,localDebug:null});
  try {
    renderer.update(group,cars,1/60,pose);
    const mesh=renderer.meshes.get(1)!;
    const batches=mesh.children[0].children.slice();
    car.customVehicle={...car.customVehicle!,assetHash:'b',configuration:{...car.customVehicle!.configuration,
      driving:{...car.customVehicle!.configuration.driving,topSpeed:12}}};
    renderer.update(group,cars,1/60,pose);
    expect(renderer.meshes.get(1)).toBe(mesh);
    expect(mesh.children[0].children).toEqual(batches);
    expect(mesh.userData.assetHash).toBe('b');
    expect(mesh.position.toArray()).toEqual([1,2,3]);
  } finally {renderer.dispose();}
});
