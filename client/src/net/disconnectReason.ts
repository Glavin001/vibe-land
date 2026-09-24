// How a server's own close reason travels from the transport to the UI:
// netcodeClient describes the close with this marker, the app extracts it.
export const SERVER_CLOSE_MARKER = 'closed by server: ';

/** The server's own words when it closed the session, else null. */
export function serverCloseReason(description: string | undefined): string | null {
  if (!description) return null;
  const at = description.indexOf(SERVER_CLOSE_MARKER);
  return at < 0 ? null : description.slice(at + SERVER_CLOSE_MARKER.length);
}
