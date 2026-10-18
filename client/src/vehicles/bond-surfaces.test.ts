import {it,expect} from 'vitest';
// @ts-expect-error Shared JavaScript geometry kernel.
import {faceContact} from './bond-surfaces.mjs';
it('measures the actual overlapping mating face',()=>{
 const a=[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],b=[[.5,0,0],[.5,1,0],[1.5,1,0],[1.5,0,0]];
 const patch=faceContact(a,b);
 expect(patch.area).toBeCloseTo(.5);expect(patch.centroid[0]).toBeCloseTo(.75);expect(patch.centroid[1]).toBeCloseTo(.5);expect(patch.normal).toEqual([0,0,1]);
});
it('does not invent structural area for separated or edge contacts',()=>{
 const a=[[0,0,0],[1,0,0],[1,1,0],[0,1,0]];
 expect(faceContact(a,[[1,0,0],[1,1,0],[2,1,0],[2,0,0]])).toBeNull();
 expect(faceContact(a,[[0,0,.01],[0,1,.01],[1,1,.01],[1,0,.01]])).toBeNull();
});
