import { describe, expect, it } from 'vitest';
import { prettyCameraName, summarize } from '../shared/status';

describe('summarize', () => {
  it('reports likely spots', () => {
    expect(summarize([{ spaces: 1, status: 'likely_available' }, { spaces: 1, status: 'possible' }], 2)).toEqual({
      state: 'available',
      spots: 2,
      headline: '2 possible spots nearby',
    });
  });
  it('reports lower-confidence spots as possible', () => {
    expect(summarize([{ spaces: 1, status: 'possible' }], 1)).toMatchObject({ state: 'possible', headline: 'Maybe 1 spot nearby' });
  });
  it('distinguishes "none" from "no data"', () => {
    expect(summarize([], 2).state).toBe('none');
    expect(summarize([], 0).state).toBe('unknown');
  });
});

describe('prettyCameraName', () => {
  it.each([
    ['Audobon Ave @ W 181 ST', 'Audubon Ave near W 181st'],
    ['Amsterdam Ave @ 181 St', 'Amsterdam Ave near W 181st'],
    ['Amsterdam Ave @ W 180 st ', 'Amsterdam Ave near W 180th'],
    ['St Nicholas Ave @ 181 St', 'St Nicholas Ave near W 181st'],
    ['C1-CBE-01_N_NB_at_Amsterdam_Ave-Ex-HRD', 'C1-CBE-01 N NB at Amsterdam Ave-Ex-HRD'],
  ])('%s -> %s', (input, expected) => {
    expect(prettyCameraName(input)).toBe(expected);
  });
});
