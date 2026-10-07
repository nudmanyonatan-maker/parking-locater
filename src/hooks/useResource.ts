// Minimal stale-while-revalidate loader. Keeps the previous data while a reload
// runs, aborts in-flight requests on unmount / key change, and supports
// optimistic local edits via `mutate`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError, toApiError } from '../lib/api';

interface State<T> {
  key: string;
  data: T | undefined;
  error: ApiError | null;
}

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | null;
  /** A request for the current key is in flight. */
  loading: boolean;
  reload: () => void;
  mutate: (update: (prev: T | undefined) => T | undefined) => void;
}

/** `key` identifies the request (e.g. a camera id); null disables loading. */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<State<T>>({ key: '', data: undefined, error: null });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const requestKey = key === null ? null : `${key}#${nonce}`;
  useEffect(() => {
    if (requestKey === null) return;
    const ctrl = new AbortController();
    loadRef.current(ctrl.signal).then(
      (data) => setState({ key: requestKey, data, error: null }),
      (err: unknown) => {
        if (isAbortError(err) || ctrl.signal.aborted) return;
        const base = requestKey.slice(0, requestKey.lastIndexOf('#') + 1);
        setState((s) => ({ key: requestKey, data: s.key.startsWith(base) ? s.data : undefined, error: toApiError(err) }));
      },
    );
    return () => ctrl.abort();
  }, [requestKey]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const mutate = useCallback((update: (prev: T | undefined) => T | undefined) => {
    setState((s) => ({ ...s, data: update(s.data) }));
  }, []);

  // Data from a different key (e.g. another camera) must not leak through.
  const sameBase = key !== null && state.key.startsWith(`${key}#`);
  return {
    data: sameBase ? state.data : undefined,
    error: sameBase ? state.error : null,
    loading: requestKey !== null && state.key !== requestKey,
    reload,
    mutate,
  };
}
