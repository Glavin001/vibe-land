// Cloudflare Turnstile server-side verification.
//
// When TURNSTILE_SECRET_KEY is set, endpoints call verifyTurnstileToken()
// to validate the token the client obtained from the Turnstile widget.
// When the env var is unset the helper returns { ok: true } unconditionally
// so local development and unconfigured deploys keep working without changes.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: string };

/** True when TURNSTILE_SECRET_KEY is configured. */
export function isTurnstileEnabled(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());
}

/**
 * Verify a Turnstile response token against Cloudflare's siteverify API.
 *
 * Graceful degradation: returns `{ ok: true }` when TURNSTILE_SECRET_KEY is
 * not set, so endpoints behave normally without Turnstile configured.
 *
 * Fails closed: if the siteverify request itself fails (network error), the
 * token is rejected.
 */
export async function verifyTurnstileToken(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<TurnstileResult> {
  const secretKey = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secretKey) {
    return { ok: true };
  }

  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return { ok: false, reason: 'Missing Turnstile token.' };
  }

  const params = new URLSearchParams();
  params.append('secret', secretKey);
  params.append('response', token);
  if (remoteIp) {
    params.append('remoteip', remoteIp);
  }

  let body: { success?: boolean; 'error-codes'?: string[] };
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: 'Turnstile verification request failed.' };
  }

  if (body.success) {
    return { ok: true };
  }

  const codes = body['error-codes']?.join(', ') ?? 'unknown';
  return { ok: false, reason: `Turnstile verification failed (${codes}).` };
}

/** Extract the client IP from a Node.js IncomingMessage. */
export function extractClientIp(headers: Record<string, string | string[] | undefined>): string | null {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim() || null;
  }
  return null;
}
