import type { HTMLAttributes, ReactNode } from "react";

export function FantasyFrame({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return <div {...props} className={`fantasy-frame ${className}`.trim()}>
    <span className="fantasy-frame__corner fantasy-frame__corner--tl" aria-hidden="true" />
    <span className="fantasy-frame__corner fantasy-frame__corner--tr" aria-hidden="true" />
    <span className="fantasy-frame__corner fantasy-frame__corner--bl" aria-hidden="true" />
    <span className="fantasy-frame__corner fantasy-frame__corner--br" aria-hidden="true" />
    {children}
  </div>;
}
