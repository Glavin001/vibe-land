export const VIBE_JAM_PORTAL_URL = 'https://vibejam.cc/portal/2026';

export const FORWARDED_PORTAL_KEYS = [
  'username',
  'color',
  'speed',
  'avatar_url',
  'team',
  'hp',
  'speed_x',
  'speed_y',
  'speed_z',
  'rotation_x',
  'rotation_y',
  'rotation_z',
] as const;

export type PortalParams = {
  isFromPortal: boolean;
  ref: string | null;
  forwarded: Record<string, string>;
};

export function readPortalParams(search: string): PortalParams {
  const params = new URLSearchParams(search);
  const isFromPortal = params.get('portal') === 'true';
  const refRaw = params.get('ref');
  const ref = refRaw && refRaw.length > 0 ? refRaw : null;
  const forwarded: Record<string, string> = {};
  for (const key of FORWARDED_PORTAL_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== '') {
      forwarded[key] = value;
    }
  }
  return { isFromPortal, ref, forwarded };
}

export function buildPortalRedirectUrl(
  base: string,
  forwarded: Record<string, string>,
  selfRef: string | null,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(forwarded)) {
    url.searchParams.set(key, value);
  }
  if (selfRef) {
    url.searchParams.set('ref', selfRef);
  }
  return url.toString();
}

export function buildReturnPortalUrl(
  ref: string,
  forwarded: Record<string, string>,
  selfRef: string | null,
): string {
  const target = ref.startsWith('http://') || ref.startsWith('https://') ? ref : `https://${ref}`;
  const url = new URL(target);
  for (const [key, value] of Object.entries(forwarded)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('portal', 'true');
  if (selfRef) {
    url.searchParams.set('ref', selfRef);
  }
  return url.toString();
}
