// Optional second opinion on a candidate space from a vision LLM
// (@cf/google/gemma-4-26b-a4b-it, ~5-13 neurons per call). Off by default
// (settings.vlmVerify). Experimental: at 352x240 a VLM can misjudge distance.
//
// We cannot crop JPEGs cheaply inside the 10 ms CPU budget of the Workers Free
// plan, so the model gets the whole frame plus a plain-words description of
// where the opening is.

import type { ParkingCandidate } from '../../shared/types';
import type { CandidateVerifier, Frame } from './detector';
import { bytesToBase64 } from './detectors';

export const VLM_MODEL = '@cf/google/gemma-4-26b-a4b-it';

type LooseAi = { run(model: string, input: unknown): Promise<unknown> };

/** "left side, lower part of the image (closer to the camera)" */
export function describeLocation(polygon: ParkingCandidate['polygon']): string {
  const cx = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const cy = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const h = cx < 0.33 ? 'left side' : cx > 0.67 ? 'right side' : 'middle';
  const v = cy > 0.66 ? 'lower part of the image (closer to the camera)' : cy < 0.4 ? 'upper part of the image (farther away)' : 'middle distance';
  return `${h}, ${v}`;
}

export function parseVerdict(raw: unknown): { emptySpace: boolean; confidence: number; reason: string } | null {
  const content = (raw as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  try {
    const v = JSON.parse(content) as { empty_space?: unknown; confidence?: unknown; reason?: unknown };
    if (typeof v.empty_space !== 'boolean') return null;
    const confidence = typeof v.confidence === 'number' ? Math.min(1, Math.max(0, v.confidence)) : 0.5;
    return { emptySpace: v.empty_space, confidence, reason: typeof v.reason === 'string' ? v.reason.slice(0, 200) : '' };
  } catch {
    return null;
  }
}

export class GemmaCandidateVerifier implements CandidateVerifier {
  readonly name = 'workers-ai/gemma-4-26b';
  private readonly ai: Ai;
  constructor(ai: Ai) {
    this.ai = ai;
  }

  async verify(frame: Frame, candidate: ParkingCandidate) {
    const url = `data:image/jpeg;base64,${bytesToBase64(frame.bytes)}`;
    const raw = await (this.ai as unknown as LooseAi).run(VLM_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You inspect low-resolution NYC traffic-camera images. Answer only about the curb parking lane described. A space is empty only if at least one full car length of curb is visibly free of vehicles.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Look at the curb parking lane on the ${describeLocation(candidate.polygon)}. Is there an empty, car-sized parking space there right now? Respond as JSON.`,
            },
            { type: 'image_url', image_url: { url } },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'gap_verdict',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              empty_space: { type: 'boolean' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              reason: { type: 'string' },
            },
            required: ['empty_space', 'confidence', 'reason'],
            additionalProperties: false,
          },
        },
      },
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0,
      max_completion_tokens: 160,
    });
    const verdict = parseVerdict(raw);
    if (!verdict) return { agrees: null, note: 'Vision model gave no usable answer' };
    return {
      agrees: verdict.confidence < 0.5 ? null : verdict.emptySpace,
      note: `Vision model: ${verdict.emptySpace ? 'looks open' : 'looks taken'} (${Math.round(verdict.confidence * 100)}%)${verdict.reason ? ` — ${verdict.reason}` : ''}`,
    };
  }
}

/** Adjust a candidate after a second opinion. */
export function applyVerdict(c: ParkingCandidate, agrees: boolean | null, note: string, minConfidence: number): ParkingCandidate {
  if (agrees === null) return { ...c, reasons: [...c.reasons, note] };
  const confidence = Math.min(0.95, Math.max(0.05, c.confidence + (agrees ? 0.05 : -0.25)));
  return {
    ...c,
    confidence: Number(confidence.toFixed(3)),
    status: confidence >= minConfidence && c.status === 'likely_available' ? 'likely_available' : 'possible',
    reasons: [...c.reasons, note],
  };
}
