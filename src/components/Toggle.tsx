interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Shows a pending state (e.g. waiting for a permission prompt). */
  busy?: boolean;
}

/** iOS switch. Rendered as role="switch" so screen readers announce on/off. */
export function Toggle({ checked, onChange, label, disabled, busy }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className="toggle"
      onClick={() => onChange(!checked)}
    />
  );
}
