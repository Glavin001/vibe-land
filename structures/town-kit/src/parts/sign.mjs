import {M} from '../materials.mjs';
const letters={B:['110','101','110','101','110'],D:['110','101','101','101','110'],F:['111','100','110','100','100'],H:['101','101','111','101','101'],I:['111','010','010','010','111'],L:['100','100','100','100','111'],N:['101','111','111','111','101'],P:['110','101','110','100','100'],U:['101','101','101','101','111'],V:['101','101','101','101','010'],Y:['101','101','010','010','010'],C:['111','100','100','100','111'],A:['010','101','111','101','101'],E:['111','100','110','100','111'],G:['111','100','101','101','111'],K:['101','110','100','110','101'],M:['101','111','111','101','101'],O:['111','101','101','101','111'],R:['110','101','110','101','101'],S:['111','100','111','001','111'],T:['111','010','010','010','010'],W:['101','101','111','111','101']};
/** Physical lettering on a front-facing sign. Every glyph cell touches its backing. */
export function addSign(builder,text,{centerX,y,faceZ,pixelX=.11,pixelY=.06,material=M.trim,mirrored=false}){
 const width=(text.length*4-1)*pixelX;
 for(const [i,c] of [...text].entries()){
  const glyph=letters[c];if(!glyph)throw Error(`Unsupported sign letter ${c}`);
  for(let row=0;row<5;row++)for(let col=0;col<3;col++)if(glyph[row][col]==='1'){
   const x1=centerX+width/2-(i*4+col)*pixelX;
   const x0=x1-pixelX,lo=mirrored?2*centerX-x1:x0,hi=mirrored?2*centerX-x0:x1;
   builder.box({min:[lo,y+(4-row)*pixelY,faceZ-.018],max:[hi,y+(5-row)*pixelY,faceZ],material,type:'sign-letter'});
  }
 }
}
