// The saved car spot, shared by both tabs. `spot` is undefined while loading.

import { useCallback, useEffect, useState } from 'react';
import type { CarSpot } from '../../shared/types';
import { clearSpot, getSpot, isAbortError, saveSpot, toApiError, type ApiError } from '../lib/api';

export type SpotInput = Parameters<typeof saveSpot>[0];

export function useSpot() {
  const [spot, setSpot] = useState<CarSpot | null | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getSpot(ctrl.signal)
      .then((s) => setSpot(s && Number.isFinite(s.lat) ? s : null))
      .catch((e: unknown) => {
        if (isAbortError(e)) return;
        setError(toApiError(e));
        setSpot(null);
      });
    return () => ctrl.abort();
  }, []);

  const save = useCallback(async (input: SpotInput) => {
    const saved = await saveSpot(input);
    setSpot(saved);
    setError(null);
    return saved;
  }, []);

  const clear = useCallback(async () => {
    await clearSpot();
    setSpot(null);
  }, []);

  return { spot, error, save, clear };
}

export type SpotState = ReturnType<typeof useSpot>;
