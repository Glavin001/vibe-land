// The chase's measuring run (scripts/native-mac.sh film chase-trace --scene
// town): its driving and house strikes, no last meteor, the truck's position
// logged every 0.1 s (`truck {t, x, y, z, speed}`) -- what chase-shots.mjs's
// RUN is measured from. Lockstep takes repeat it but for GPU physics.
import { shoot } from '../film/film.mjs';
import { chaseShots } from './chase-shots.mjs';

shoot({ scene: 'town' }, ({ place }) => chaseShots(place, { trace: true, final: false }));
