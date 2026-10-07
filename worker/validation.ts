// Request body schemas (zod v4). Every parse failure becomes a 400
// `validation_failed` ApiError whose details list each problem by field path.

import { z } from 'zod';
import { isConvexQuad } from '../shared/geometry';
import type { Region, RegionKind } from '../shared/types';
import { HttpError } from './http';

export const CAMERA_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const REGION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;
const REGION_KINDS = ['parking', 'restricted', 'ignore', 'roadway', 'sidewalk'] as const satisfies readonly RegionKind[];
const DEFAULT_LANE_CAPACITY = 6;

export interface ValidationDetail {
  path: string;
  message: string;
}

/** Parse `input` with `schema` or throw a 400 with readable details. */
export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details: ValidationDetail[] = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(body)',
    message: issue.message,
  }));
  const first = details[0]!;
  throw new HttpError(400, 'validation_failed', `${first.path}: ${first.message}`, details);
}

export const usefulnessBody = z.object({
  usefulness: z.enum(['yes', 'no', 'unknown'], { error: 'Must be "yes", "no" or "unknown"' }),
  /** Omitted = keep the stored value; null or "" = clear it. */
  notes: z.string().trim().max(500, 'At most 500 characters').nullable().optional(),
  streetLabel: z.string().trim().max(80, 'At most 80 characters').nullable().optional(),
});

const coordinate = z.number().min(0, 'Points must be normalized (0..1)').max(1, 'Points must be normalized (0..1)');
const point = z.tuple([coordinate, coordinate]);

const regionInput = z
  .object({
    id: z.string().regex(REGION_ID_PATTERN, 'Use 1-40 letters, digits, "_" or "-"'),
    kind: z.enum(REGION_KINDS, { error: `Must be one of ${REGION_KINDS.join(', ')}` }),
    points: z.array(point).min(3, 'At least 3 points').max(12, 'At most 12 points'),
    label: z.string().trim().max(80, 'At most 80 characters').optional(),
    streetLabel: z.string().trim().max(80, 'At most 80 characters').optional(),
    capacity: z.int('Must be a whole number').min(1, 'At least 1').max(40, 'At most 40').optional(),
    anchor: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).optional(),
    hydrantsM: z.array(z.number().min(0, 'At least 0').max(250, 'At most 250')).max(10, 'At most 10 hydrants').optional(),
  })
  .superRefine((r, ctx) => {
    if (r.kind !== 'parking') return;
    if (r.points.length !== 4) {
      ctx.addIssue({ code: 'custom', path: ['points'], message: 'A parking lane needs exactly 4 points: start-curb, start-traffic, end-traffic, end-curb' });
    } else if (!isConvexQuad(r.points)) {
      ctx.addIssue({ code: 'custom', path: ['points'], message: 'A parking lane must be a convex quadrilateral (points in order, edges not crossing)' });
    }
  });

/** Parking-only fields are dropped from other kinds; lanes get a default capacity. */
function normalizeRegion(r: z.output<typeof regionInput>): Region {
  const base: Region = { id: r.id, kind: r.kind, points: r.points };
  if (r.label) base.label = r.label;
  if (r.kind !== 'parking') return base;
  return {
    ...base,
    capacity: r.capacity ?? DEFAULT_LANE_CAPACITY,
    ...(r.streetLabel ? { streetLabel: r.streetLabel } : {}),
    ...(r.anchor ? { anchor: r.anchor } : {}),
    ...(r.hydrantsM?.length ? { hydrantsM: [...r.hydrantsM].sort((a, b) => a - b) } : {}),
  };
}

const pixelSize = z.int('Must be a whole number').min(16, 'At least 16').max(4096, 'At most 4096');

export const calibrationBody = z
  .object({
    regions: z.array(regionInput.transform(normalizeRegion)).max(20, 'At most 20 regions'),
    referenceWidth: pixelSize,
    referenceHeight: pixelSize,
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.regions.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: 'custom', path: ['regions', i, 'id'], message: `Duplicate region id "${r.id}"` });
      seen.add(r.id);
    });
  });

const httpsEndpoint = z
  .url({ protocol: /^https$/, error: 'Must be an https URL' })
  .max(1000, 'At most 1000 characters');

export const pushSubscriptionBody = z.object({
  endpoint: httpsEndpoint,
  keys: z.object({
    p256dh: z.string().regex(BASE64URL_PATTERN, 'Must be base64url').max(200, 'At most 200 characters'),
    auth: z.string().regex(BASE64URL_PATTERN, 'Must be base64url').max(100, 'At most 100 characters'),
  }),
});

export const pushUnsubscribeBody = z.object({ endpoint: httpsEndpoint });

export const spotBody = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  note: z.string().max(200, 'At most 200 characters').optional().catch(''),
  moveBy: z.coerce.number().int().positive().nullable().optional(),
  faceId: z.string().max(160).nullable().optional(),
});
