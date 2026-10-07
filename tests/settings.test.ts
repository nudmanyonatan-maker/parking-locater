import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, settingsFromRows, validateSettingsPatch } from '../shared/settings';

describe('validateSettingsPatch', () => {
  it('accepts valid values', () => {
    const r = validateSettingsPatch({ radiusMi: 0.75, minConfidence: 0.705, notificationsEnabled: true, backgroundMode: 'always' });
    expect(r).toEqual({ ok: true, value: { radiusMi: 0.75, minConfidence: 0.71, notificationsEnabled: true, backgroundMode: 'always' } });
  });
  it('rejects out-of-range and unknown values with per-field errors', () => {
    const r = validateSettingsPatch({ radiusMi: 2, minConfidence: 1.5, backgroundMode: 'sometimes', analysisCooldownSeconds: 1, nope: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['analysisCooldownSeconds', 'backgroundMode', 'minConfidence', 'nope', 'radiusMi']);
  });
  it('rejects non-objects', () => {
    expect(validateSettingsPatch(null).ok).toBe(false);
    expect(validateSettingsPatch([1]).ok).toBe(false);
  });
});

describe('settingsFromRows', () => {
  it('overlays valid stored values on defaults and ignores junk', () => {
    const s = settingsFromRows([
      { key: 'radiusMi', value_json: '0.25' },
      { key: 'minConfidence', value_json: '7' },
      { key: 'notificationsEnabled', value_json: '{bad json' },
      { key: 'app_last_seen_at', value_json: '"2026-10-07T00:00:00Z"' },
      { key: 'home', value_json: JSON.stringify({ address: 'x', lat: 40.85, lon: -73.93, source: 'test', geocodedAt: 'now' }) },
    ]);
    expect(s.radiusMi).toBe(0.25);
    expect(s.minConfidence).toBe(DEFAULT_SETTINGS.minConfidence);
    expect(s.notificationsEnabled).toBe(DEFAULT_SETTINGS.notificationsEnabled);
    expect(s.home).toMatchObject({ lat: 40.85, lon: -73.93, source: 'test' });
  });
});
