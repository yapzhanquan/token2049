"use client";
import { useEffect, type ReactNode } from "react";

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  width,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head">
          <div className="flex flex-col min-w-0">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {subtitle && <div className="text-[12px] muted">{subtitle}</div>}
          </div>
          <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
