import {it,expect} from 'vitest';
import {BoxGeometry} from 'three';
// @ts-expect-error Server worker module is dependency-free JS.
import {meshMassProperties,combineMassProperties,massPropertiesToActor} from './mass-properties.mjs';
function box(size:number[],center=[0,0,0],angle=0) {
 const g=new BoxGeometry(...size as [number,number,number]);g.rotateZ(angle);g.translate(...center as [number,number,number]);
 const result={positions:g.attributes.position.array,indices:g.index!.array};g.dispose();return result;
}
function properties(size:number[],mass:number,center=[0,0,0],angle=0){const b=box(size,center,angle);return meshMassProperties(b.positions,b.indices,mass);}
it('matches an analytic cuboid away from the origin',()=>{
 const p=properties([2,4,6],12,[100,-30,42]);expect(p.volume).toBeCloseTo(48,8);expect(p.center).toEqual([100,-30,42]);
 [52,40,20].forEach((v,i)=>expect(p.inertia[i][i]).toBeCloseTo(v,8));expect(p.inertia[0][1]).toBeCloseTo(0,8);
});
it('retains products of inertia for a rotated part',()=>{
 const p=properties([2,4,6],12,[3,2,-1],Math.PI/4);
 expect(p.inertia[0][0]).toBeCloseTo(46,4);expect(p.inertia[1][1]).toBeCloseTo(46,4);expect(p.inertia[0][1]).toBeCloseTo(6,4);
});
it('subtracts cavities and combines parts with the parallel-axis theorem',()=>{
 const outer=box([4,4,4]),inner=box([2,2,2]);const positions=[...outer.positions,...inner.positions],indices=[...outer.indices];
 for(let i=0;i<inner.indices.length;i+=3)indices.push(...[2,1,0].map(k=>inner.indices[i+k]+outer.positions.length/3));
 const shell=meshMassProperties(positions,indices,56);expect(shell.volume).toBeCloseTo(56,8);expect(shell.inertia[0][0]).toBeCloseTo(496/3,7);
 const combined=combineMassProperties([properties([2,2,2],3,[-2,0,0]),properties([2,2,2],3,[2,0,0])]);
 combined.center.forEach((v:number)=>expect(v).toBeCloseTo(0,10));expect(combined.mass).toBe(6);expect(combined.inertia[0][0]).toBeCloseTo(4,8);expect(combined.inertia[1][1]).toBeCloseTo(28,8);
});
it('transforms COM and tensor into the collider actor frame',()=>{
 const p={mass:2,volume:1,center:[2,3,4],inertia:[[4,1,2],[1,5,3],[2,3,6]]};const actor=massPropertiesToActor(p,.65);
 expect(actor.center).toEqual([-2,2.35,-4]);expect(actor.inertia).toEqual([[4,-1,2],[-1,5,-3],[2,-3,6]]);
});
it('rejects invalid data instead of inventing mass',()=>{
 expect(()=>meshMassProperties([0,0,0],[0,0,0],1)).toThrow();expect(()=>meshMassProperties([0,0,0],[0,1,2],1)).toThrow();expect(()=>properties([1,1,1],NaN)).toThrow();
});
