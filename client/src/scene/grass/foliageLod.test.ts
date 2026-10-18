import { describe, expect, it } from 'vitest';
import { InstancedBufferGeometry, Mesh, PerspectiveCamera } from 'three';
import { GrassPaint, GRASS_BRUSHES } from './GrassPaint';
import { GrassField } from './GrassField';
import { foliageHandoff, grassCanopyDensity } from './foliageLod';

describe('foliage silhouette LOD',()=>{
  it('keeps full close detail and reduces dense narrow-blade submissions without changing canopy height',()=>{
    const paint=new GrassPaint();paint.paint(4,4,12,GRASS_BRUSHES.vehicle);
    const field=new GrassField('pretty',[],paint),camera=new PerspectiveCamera(60,1.6,.1,300);
    try {
      camera.position.set(4,2,4);camera.lookAt(4,1,0);camera.updateMatrixWorld();
      for(let i=0;i<100;i++)field.update(camera,i/60);
      const patch=field.group.children.find(c=>c.name==='Grass patch 0,0')!;
      const plant=patch.children.find(c=>(c as Mesh<InstancedBufferGeometry>).geometry.getAttribute('grassBirth').getY(0)===1) as Mesh<InstancedBufferGeometry>;
      expect(plant).toBeDefined();
      const geometry=plant.geometry,roots=geometry.getAttribute('grassRoot'),count=roots.count;
      const heights=Array.from({length:count},(_,i)=>roots.getZ(i));
      expect(geometry.instanceCount).toBe(count);
      camera.position.set(4,2,24);camera.lookAt(4,1,4);camera.updateMatrixWorld();field.update(camera,2);
      expect(geometry.instanceCount).toBeLessThan(count*.8);
      expect(Array.from({length:count},(_,i)=>roots.getZ(i))).toEqual(heights);
      expect(field.stats.canopyClumps).toBeGreaterThan(100);
      expect(grassCanopyDensity(8)).toBe(1);
      expect(grassCanopyDensity(100)).toBeCloseTo(.4);
    }finally{field.dispose();paint.dispose();}
  });
  it('does not merge sparse grass or broad-leaf plants',()=>{
    for(const brush of [{...GRASS_BRUSHES.vehicle,density:.1},GRASS_BRUSHES.corn,GRASS_BRUSHES.ferns]) {
      const paint=new GrassPaint();paint.paint(4,4,12,brush);
      const field=new GrassField('pretty',[],paint),camera=new PerspectiveCamera(60,1.6,.1,300);
      camera.position.set(4,2,24);camera.lookAt(4,1,4);camera.updateMatrixWorld();
      try {
        for(let i=0;i<100;i++)field.update(camera,i/60);
        field.group.traverse(o=>{
          if(o instanceof Mesh && o.geometry.hasAttribute('grassBirth'))expect(o.geometry.getAttribute('grassBirth').getY(0)).toBe(0);
        });
      }finally{field.dispose();paint.dispose();}
    }
  });
  it('hands off gradually with complementary coverage',()=>{
    for(const quality of ['fast','pretty'] as const) {
      let previous=0;
      for(let distance=0;distance<150;distance+=0.5) {
        const far=foliageHandoff(distance,quality);
        expect(far).toBeGreaterThanOrEqual(previous);
        expect(far+(1-far)).toBe(1);previous=far;
      }
      expect(previous).toBe(1);
    }
  });
  it('keeps tall canopies at long range and directly overhead on both tiers',()=>{
    const paint=new GrassPaint();paint.paint(4,4,12,GRASS_BRUSHES.vehicle);
    const camera=new PerspectiveCamera(60,1.6,0.1,500);
    let counts:number[]=[];
    for(const quality of ['fast','pretty'] as const) {
      const field=new GrassField(quality,[],paint);
      camera.position.set(4,8,140);camera.lookAt(4,2,4);camera.updateMatrixWorld();
      for(let i=0;i<40;i++)field.update(camera,i/60);
      expect(field.group.children.some(c=>c.name==='Grass patch 0,0')).toBe(false);
      expect(field.stats.canopyClumps).toBeGreaterThan(100);
      counts.push(field.stats.canopyClumps);
      camera.position.set(4,100,4);camera.lookAt(4,0,4);camera.updateMatrixWorld();field.update(camera,1);
      expect(field.stats.blades).toBe(0);
      expect(field.stats.canopyClumps).toBeGreaterThan(100);
      field.dispose();
    }
    expect(counts[0]).toBe(counts[1]);paint.dispose();
  });
  it('keeps broad corn leaves nondegenerate in the cheapest mesh',()=>{
    const paint=new GrassPaint();paint.paint(4,4,8,GRASS_BRUSHES.corn);
    const field=new GrassField('fast',[],paint);
    const camera=new PerspectiveCamera(60,1.6,0.1,500);
    camera.position.set(4,2,28);camera.lookAt(4,1,4);camera.updateMatrixWorld();
    for(let i=0;i<40;i++)field.update(camera,i/60);
    const patch=field.group.children.find(c=>c.name==='Grass patch 0,0')!;
    const corn=patch.children.find(c=>(c as any).geometry.getAttribute('grassTraits').array[3]===3) as any;
    const geometry=corn.geometry, position=geometry.getAttribute('position');
    const indices=geometry.index.array;
    let broadVertices=0;
    for(let i=geometry.drawRange.start;i<geometry.drawRange.start+geometry.drawRange.count;i++) {
      const index=indices[i];
      if(position.getZ(index)>0 && position.getY(index)>0.1 && position.getY(index)<0.9) broadVertices++;
    }
    expect(broadVertices).toBeGreaterThan(0);
    field.dispose();paint.dispose();
  });
  it('respects bare paint and building exclusions, and rebuilds distant edits',()=>{
    const paint=new GrassPaint();paint.paint(4,4,12,GRASS_BRUSHES.corn);
    const field=new GrassField('fast',[{minX:0,minZ:0,maxX:8,maxZ:8}],paint);
    const camera=new PerspectiveCamera(60,1.6,0.1,500);
    camera.position.set(4,10,100);camera.lookAt(4,0,4);camera.updateMatrixWorld();
    for(let i=0;i<30;i++)field.update(camera,i/60);
    expect(field.stats.canopyClumps).toBeGreaterThan(0);
    for(const child of field.canopy.group.children) {
      const geometry=(child as any).geometry;
      const roots=geometry.getAttribute('canopyRoot');
      for(let i=0;i<roots.count;i++) {
        const x=roots.getX(i)+child.position.x,z=roots.getY(i)+child.position.z;
        expect(x>=0 && x<=8 && z>=0 && z<=8).toBe(false);
      }
    }
    paint.clear();for(let i=30;i<60;i++)field.update(camera,i/60);
    expect(field.stats.canopyClumps).toBe(0);
    field.dispose();paint.dispose();
  });
});
