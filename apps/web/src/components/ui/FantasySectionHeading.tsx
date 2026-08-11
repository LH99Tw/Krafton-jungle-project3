import type { ReactNode } from "react";

export function FantasySectionHeading({ id, title, level = 2, action }: {
  id?: string;
  title: string;
  level?: 1 | 2;
  action?: ReactNode;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return <div className="fantasy-section-heading">
    <div>
      <Heading id={id}>{title}</Heading>
    </div>
    {action ? <div className="fantasy-section-heading__action">{action}</div> : null}
  </div>;
}
