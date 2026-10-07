import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { dismissToast, useToast } from '../lib/toast';

export function Toaster() {
  const t = useToast();
  if (!t) return null;
  const Icon = t.tone === 'success' ? CircleCheck : t.tone === 'error' ? CircleAlert : Info;
  return (
    <div key={t.id} className={`toast glass is-${t.tone}`} role="status" aria-live="polite" onClick={dismissToast}>
      <Icon size={18} aria-hidden="true" />
      <span>{t.message}</span>
    </div>
  );
}
