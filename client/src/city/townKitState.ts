export type TownKitStatus={ready:boolean;assets:number;attachments:number;error:string|null;title?:string;description?:string};
let status:TownKitStatus={ready:false,assets:0,attachments:0,error:null};
const listeners=new Set<()=>void>();
export const townKitSnapshot=()=>status;
export const subscribeTownKit=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};
export function updateTownKitStatus(next:TownKitStatus){status=next;for(const listener of listeners)listener();}
/** The launcher binds this client preset to the matching server scene pack. */
export function usesTownKitScene(pathname:string,preset?:string){
 const path=pathname.replace(/\/$/,'');
 return path==='/town-kit'||(path==='/city'&&preset==='bayline-town-with-gardens-and-market');
}
export const isTownKitPage=()=>usesTownKitScene(window.location.pathname,import.meta.env.VITE_TOWN_KIT_SCENE);
