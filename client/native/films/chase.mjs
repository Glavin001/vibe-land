// The chase on its own (scripts/native-mac.sh film chase --scene town): the
// monster truck weaving east through Elm Park as the houses either side are
// blown apart, then caught by a meteor that throws it -- films/chase-shots.mjs,
// as in the trailer; films/chase-trace.mjs measures its run.
import { shoot } from '../film/film.mjs';
import { chaseShots } from './chase-shots.mjs';

// CHASE_TRACE: the truck's position every 0.1 s in the log, to see where the hit throws it.
/* global CHASE_TRACE */
const trace = typeof CHASE_TRACE === 'boolean' ? CHASE_TRACE : true;
shoot({ scene: 'town', shake: { strength: 0.5, radius: 90 } }, ({ place }) => chaseShots(place, { trace }));
