import {expect,it} from 'vitest';
import {usesTownKitScene} from './townKitState';

it('loads the furnished town details and controls on its city deployment',()=>{
 for(const path of ['/city','/city/'])expect(usesTownKitScene(path,'bayline-town-with-gardens-and-market')).toBe(true);
});
it('keeps ordinary city deployments and other pages independent',()=>{
 expect(usesTownKitScene('/city')).toBe(false);
 expect(usesTownKitScene('/city','unknown-scene')).toBe(false);
 expect(usesTownKitScene('/practice','bayline-town-with-gardens-and-market')).toBe(false);
});
it('preserves the standalone town-kit playground',()=>{
 expect(usesTownKitScene('/town-kit')).toBe(true);
 expect(usesTownKitScene('/town-kit/')).toBe(true);
});
