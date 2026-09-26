import type { AcousticMaterial,SoundKind } from './model';
export const PALETTE_SLOTS=['masonryImpact','masonryCollapse','metalImpact','metalCollapse','projectileFlyby','debrisFlyby','massiveFlyby'] as const;
export type PaletteSlot=typeof PALETTE_SLOTS[number];
export type PaletteChoice='original'|'natural'|'designed';
export type PaletteChoices=Record<PaletteSlot,PaletteChoice>;
export const DEFAULT_PALETTE:PaletteChoices={masonryImpact:'original',masonryCollapse:'original',metalImpact:'original',metalCollapse:'original',projectileFlyby:'designed',debrisFlyby:'designed',massiveFlyby:'designed'};
export interface PaletteClip {url:string;duration:number;loop:boolean;sha256:string;origin:'recorded'|'hybrid'|'synth';sources:string[];description?:string;passAtSeconds?:number;}
export interface PaletteCatalog {clips:Record<string,PaletteClip>;sources:{id:string;title:string;url:string;license:string;creator:string}[];}
export function sanitizePalette(raw:unknown):PaletteChoices {
  const result={...DEFAULT_PALETTE};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return result;
  for(const slot of PALETTE_SLOTS){const value=(raw as Record<string,unknown>)[slot];if(value==='original'||value==='natural'||value==='designed')result[slot]=value;}
  return result;
}
export function paletteClipId(slot:PaletteSlot,choice:PaletteChoice):string {
  if(choice!=='original')return `${slot}-${choice}`;
  return {masonryImpact:'heavy-concrete',masonryCollapse:'debris-concrete',metalImpact:'heavy-metal',metalCollapse:'debris-metal',projectileFlyby:'flyby-0',debrisFlyby:'flyby-1',massiveFlyby:'flyby-2'}[slot];
}
export function paletteSlotFor(kind:SoundKind,material:AcousticMaterial,size:number):PaletteSlot|null {
  if(kind==='flyby')return size>=2.8?'massiveFlyby':material==='metal'&&size<.9?'projectileFlyby':'debrisFlyby';
  if(material==='concrete'||material==='stone'||material==='earth')return kind==='collapse'?'masonryCollapse':'masonryImpact';
  if(material==='metal'||material==='sheet')return kind==='collapse'?'metalCollapse':'metalImpact';
  return null;
}
