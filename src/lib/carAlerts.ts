// Phone alert an hour before "Move by" (Web Push through public/sw.js).
// On iPhone, web notifications only work in the Home Screen app.

import { carAlertsOff, carAlertsOn, getPushConfig } from './api';

/** on/off; 'home-screen': iPhone Safari tab, add to Home Screen first; 'unsupported': no push here. */
export type AlertsState = 'on' | 'off' | 'home-screen' | 'unsupported';

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

const subscription = async () => (await navigator.serviceWorker.ready).pushManager.getSubscription();

export async function alertsState(): Promise<AlertsState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIos() && !standalone() ? 'home-screen' : 'unsupported';
  }
  if (Notification.permission !== 'granted') return 'off';
  const sub = await subscription();
  if (!sub) return 'off';
  // Re-send it: the server drops phones whose subscription expired, and this costs one small request.
  await carAlertsOn(sub.toJSON()).catch(() => undefined);
  return 'on';
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

export async function turnOnAlerts(): Promise<void> {
  const config = await getPushConfig();
  if (!config.enabled || !config.publicKey) throw new Error("Alerts aren't set up on the server yet.");
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked. Allow them for this app in Settings.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) }));
  await carAlertsOn(sub.toJSON());
}

export async function turnOffAlerts(): Promise<void> {
  const sub = await subscription();
  if (!sub) return;
  await carAlertsOff(sub.endpoint);
  await sub.unsubscribe();
}
