// Admin unlock state. The token is verified with GET /api/auth/check before it
// is stored, so "unlocked" means the server accepted it at that time.

import { useCallback } from 'react';
import { checkAdminToken } from '../lib/api';
import { setPref, usePrefs } from '../lib/prefs';

export function useAdmin() {
  const { adminToken } = usePrefs();

  /** Throws ApiError (401 wrong token, 503 not configured, network…) when rejected. */
  const unlock = useCallback(async (token: string) => {
    const trimmed = token.trim();
    if (!trimmed) throw new Error('Enter the admin token.');
    await checkAdminToken(trimmed);
    setPref('adminToken', trimmed);
  }, []);

  const lock = useCallback(() => setPref('adminToken', null), []);

  return { isAdmin: adminToken !== null, unlock, lock };
}
