// Lightweight shape-check for incoming world documents. The client already
// validates with parseWorldDocument before publishing; this is a server-side
// sanity check to reject obviously malformed input without pulling the full
// validator into the serverless runtime.

export type ValidatedWorldShape = {
  version: number;
  name: string;
  description: string;
  raw: unknown;
};

export function validateWorldShape(raw: unknown): ValidatedWorldShape {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('World document must be a JSON object.');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.version !== 'number') {
    throw new ValidationError('World document is missing a numeric version.');
  }
  const meta = doc.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') {
    throw new ValidationError('World document is missing meta.');
  }
  const name = typeof meta.name === 'string' && meta.name.trim().length > 0 ? meta.name.trim() : 'Untitled World';
  const description = typeof meta.description === 'string' ? meta.description : '';
  if (!doc.terrain || typeof doc.terrain !== 'object') {
    throw new ValidationError('World document terrain is missing.');
  }
  if (!Array.isArray(doc.staticProps) || !Array.isArray(doc.dynamicEntities)) {
    throw new ValidationError('World document entity arrays are missing.');
  }
  return {
    version: doc.version,
    name,
    description,
    raw,
  };
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
