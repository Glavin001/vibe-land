import {Builder} from './geometry.mjs';
import {M} from './materials.mjs';
/** Three loose hardbacks: each book has two covers and a single paper block. */
export function buildBookStack({palette='sage'}={}){
 const b=new Builder('book-stack',{palette,group:'prop-books'}),covers=['#8c4540','#52695c','#b2945e'].map((color,i)=>b.table.push({...b.table[M.oak],name:`book-cover-${i}`,color,textureKey:null,density:600})-1);
 const paper=b.table.push({...b.table[M.oak],name:'book-paper',color:'#dfd5b5',textureKey:null,density:750})-1;
 for(let i=0;i<3;i++){
  // Each book is a separate group so stacked books rest through contact.
  b.group=`prop-book-${i}`;const y=i*.058,x=i===1?.02:0,lo=x-.225,hi=x+.225;
  for(const yy of [y,y+.053])b.box({min:[lo,yy,-.14],max:[hi,yy+.005,.14],material:covers[i],type:'book-cover'});
  b.box({min:[lo+.008,y+.005,-.132],max:[hi-.008,y+.053,.132],material:paper,type:'book-pages'});
 }
 return {pack:b.build(),metadata:{kind:'prop',type:'book-stack',route:[],shots:{furniture:[{from:[0,.9,0],to:[0,.1,0],momentum:3000,radius:.09,speed:8,tick:0}]},shotGroups:{furniture:'prop-book-1'}}};
}
