// Reset the destructible city: rebuild every structure, clear the rubble and
// park the cars again. The R key on foot (input/keyboardMouse.ts) and the
// RESET CITY buttons all come here: in the native app's single-player the
// match is in this process (its link resets it), elsewhere the game server's
// POST /city-reset does.

import { getActiveSession } from '../app/connectPhase';
import { inProcessLink } from '../net/inProcessClient';

/** True once the reset was handed to the server. */
export async function requestCityReset(matchId = getActiveSession()?.matchId, baseUrl = getActiveSession()?.statsBaseUrl): Promise<boolean> {
  const link = inProcessLink();
  if (link?.reset) {
    link.reset();
    return true;
  }
  // A server whose HTTP port this page cannot reach (statsBaseUrl null) has no reset to call.
  if (!matchId || baseUrl === null || baseUrl === undefined) return false;
  try {
    const response = await fetch(`${baseUrl}/city-reset/${encodeURIComponent(matchId)}`, { method: 'POST' });
    return response.ok;
  } catch {
    return false;
  }
}
