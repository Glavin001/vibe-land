import { CanvasTexture, DataTexture, LinearMipmapLinearFilter, RGBAFormat, Texture } from 'three';

/** Original procedural silhouettes, used ONLY for distant clumps. No downloaded assets.
 * Five families × side/overhead views; opaque cutouts keep depth and real gaps. */
export function createFoliageAtlas(): Texture {
  if (typeof document === 'undefined') return new DataTexture(new Uint8Array([255,255,255,255]),1,1,RGBAFormat);
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 512;
  const c = canvas.getContext('2d')!;
  let seed = 71891;
  const random = () => { seed = (Math.imul(seed,1664525)+1013904223)|0; return (seed>>>0)/4294967296; };
  for (let species=0;species<5;species++) for (let top=0;top<2;top++) {
    c.save(); c.translate(species*256,top*256);
    c.beginPath(); c.rect(0,0,256,256); c.clip();
    const count = species>=3 ? 9 : species===0 ? 85 : 45;
    for (let i=0;i<count;i++) {
      const x=10+random()*236, tip=10+random()*65, lean=(random()-0.5)*34;
      const shade=Math.round(175+random()*80); c.fillStyle=`rgb(${shade},${shade},${shade})`;
      if (top) {
        const z=15+random()*226;
        const leaves=species>=3 ? 6 : 4;
        for(let leaf=0;leaf<leaves;leaf++) {
          c.save();c.translate(x,z);c.rotate(random()*Math.PI*2);
          const length=species>=3 ? 42+random()*34 : 15+random()*25;
          const width=species>=3 ? 10 : 3;
          c.beginPath();c.moveTo(0,0);c.quadraticCurveTo(width,length*0.5,0,length);
          c.quadraticCurveTo(-width,length*0.5,0,0);c.fill();c.restore();
        }
      } else {
        const width=species===0 ? 3+random()*3 : 2;
        c.beginPath();c.moveTo(x-width,252);c.quadraticCurveTo(x+lean,110,x+lean,tip);
        c.quadraticCurveTo(x+lean+width,130,x+width,252);c.fill();
        if(species===1 || species===2) {
          c.beginPath();c.ellipse(x+lean,tip+12,species===2?4:3,15,0,0,Math.PI*2);c.fill();
        }
        if(species>=3) for(let leaf=0;leaf<6;leaf++) {
          const y=80+leaf*24, direction=leaf%2 ? 1 : -1;
          c.beginPath();c.moveTo(x,y+12);c.quadraticCurveTo(x+direction*28,y-22,x+direction*48,y+6);
          c.quadraticCurveTo(x+direction*24,y-7,x,y+12);c.fill();
        }
      }
    }
    c.restore();
  }
  const texture = new CanvasTexture(canvas);
  texture.name = 'Distant foliage silhouettes · five families, two views';
  texture.minFilter = LinearMipmapLinearFilter;
  return texture;
}
