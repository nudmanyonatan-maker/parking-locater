import { TriangleAlert } from 'lucide-react';

interface Props {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  tone?: 'red' | 'orange' | 'gray';
}

export function ErrorBanner({ title, message, onRetry, retryLabel = 'Try again', tone = 'red' }: Props) {
  return (
    <div className={`banner tone-${tone}`} role="alert">
      <TriangleAlert size={18} aria-hidden="true" />
      <div className="banner-body">
        {title && <strong>{title}</strong>}
        <span>{message}</span>
        {onRetry && (
          <div>
            <button type="button" className="btn-link" onClick={onRetry}>
              {retryLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
