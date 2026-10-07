// Cron trigger (every minute, see wrangler.jsonc). Every minute: the "move
// your car" Discord reminder. Every 2 minutes: keep the camera catalog fresh,
// analyze watched cameras in the background when that is useful, and prune
// old detections once a day.
//
// Background analysis runs when backgroundMode is "always", or for
// "when_alerts_on" while alerts can actually be delivered (notifications on +
// an enabled subscription) or the app was opened in the last 15 minutes.

import { runReminderCheck } from './car';
import { countEnabledSubscriptions, deleteDetectionsBefore } from './db';
import type { Env } from './env';
import { errorMessage } from './http';
import { analyzeCamera } from './services/analysis';
import { ensureCatalogFresh, watchedCalibratedCameras } from './services/cameras';
import { readSettingsState, type SettingsState } from './services/settings';

const MAX_CAMERAS_PER_RUN = 4;
const APP_ACTIVE_WINDOW_MS = 15 * 60_000;
const RETENTION_DAYS = 7;
/** Retention runs on the cron tick(s) that fall in 08:00-08:01 UTC. */
const RETENTION_HOUR_UTC = 8;

/** Why background analysis should run now, or null to stay idle. */
async function backgroundReason(env: Env, state: SettingsState, now = Date.now()): Promise<string | null> {
  const { backgroundMode, notificationsEnabled } = state.settings;
  if (backgroundMode === 'off') return null;
  if (backgroundMode === 'always') return 'always';
  if (notificationsEnabled && (await countEnabledSubscriptions(env.DB)) > 0) return 'alerts_on';
  const lastSeen = state.appLastSeenAt ? Date.parse(state.appLastSeenAt) : NaN;
  if (Number.isFinite(lastSeen) && now - lastSeen <= APP_ACTIVE_WINDOW_MS) return 'app_open';
  return null;
}

function isRetentionTick(scheduledTime: number): boolean {
  const t = new Date(scheduledTime);
  return t.getUTCHours() === RETENTION_HOUR_UTC && t.getUTCMinutes() <= 1;
}

/** Camera work runs on even minutes only (the reminder needs every minute). */
export function isParkingTick(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() % 2 === 0;
}

export async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    const reminder = await runReminderCheck(env, controller.scheduledTime);
    if (reminder !== 'idle') console.log(`cron: move-by reminder ${reminder}`);
  } catch (e) {
    console.error(`cron: reminder check failed: ${errorMessage(e)}`);
  }
  if (isParkingTick(controller.scheduledTime)) await parkingTick(controller, env, ctx);
}

async function parkingTick(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  await ensureCatalogFresh(env);
  const state = await readSettingsState(env);
  const reason = await backgroundReason(env, state);

  const results: string[] = [];
  if (reason) {
    const cameras = (await watchedCalibratedCameras(env, state.settings.radiusMi)).slice(0, MAX_CAMERAS_PER_RUN);
    for (const camera of cameras) {
      try {
        const d = await analyzeCamera(env, ctx, camera.id);
        results.push(`${camera.id.slice(0, 8)}=${d.status}`);
      } catch (e) {
        results.push(`${camera.id.slice(0, 8)}=error`);
        console.error(`cron: analyze ${camera.id} failed: ${errorMessage(e)}`);
      }
    }
  }

  let pruned = 0;
  if (isRetentionTick(controller.scheduledTime)) {
    const cutoff = new Date(controller.scheduledTime - RETENTION_DAYS * 86_400_000).toISOString();
    pruned = await deleteDetectionsBefore(env.DB, cutoff);
  }
  console.log(`cron: ${reason ?? 'idle'}; analyzed ${results.length ? results.join(' ') : 'none'}; pruned ${pruned} detections`);
}
