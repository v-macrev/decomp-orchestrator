// SPDX-License-Identifier: AGPL-3.0-or-later
// Two-step confirmation without window.confirm (unsupported or auto-dismissed in embedded browsers).
import { useEffect, useState, type ReactNode } from 'react';

export function ConfirmButton({ onConfirm, children, confirmLabel = 'Click again to confirm', className = 'danger', disabled, title }: {
  onConfirm: () => void | Promise<void>;
  children: ReactNode;
  confirmLabel?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? `${className} armed` : className}
      disabled={disabled}
      title={title}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setArmed(false);
        await onConfirm();
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
