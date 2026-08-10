import type { ReactNode } from "react";

export function FantasySectionHeading({ id, title, description, level = 2, action }: {
  id?: string;
  title: string;
  description?: string;
  level?: 1 | 2;
  action?: ReactNode;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return <div className="fantasy-section-heading">
    <span className="fantasy-section-heading__sigil" aria-hidden="true">✦</span>
    <div>
      <Heading id={id}>{title}</Heading>
      {description ? <small>{description}</small> : null}
    </div>
    {action ? <div className="fantasy-section-heading__action">{action}</div> : null}
  </div>;
}
