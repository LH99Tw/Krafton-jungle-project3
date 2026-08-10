import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

type FantasyButtonStyle = {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "small" | "medium" | "large";
  fullWidth?: boolean;
  trailingIcon?: ReactNode;
};

type FantasyButtonProps = FantasyButtonStyle & (
  | ({ href: string } & AnchorHTMLAttributes<HTMLAnchorElement>)
  | ({ href?: never } & ButtonHTMLAttributes<HTMLButtonElement>)
);

export function FantasyButton({
  variant = "secondary",
  size = "medium",
  fullWidth = false,
  trailingIcon,
  className = "",
  children,
  ...props
}: FantasyButtonProps) {
  const classes = [
    "fantasy-button",
    `fantasy-button--${variant}`,
    `fantasy-button--${size}`,
    fullWidth ? "fantasy-button--full" : "",
    className,
  ].filter(Boolean).join(" ");

  const content = <><span className="fantasy-button__label">{children}</span>{trailingIcon ? <span className="fantasy-button__icon" aria-hidden="true">{trailingIcon}</span> : null}</>;

  if ("href" in props && typeof props.href === "string") {
    return <a {...props} className={classes}>{content}</a>;
  }

  return <button {...props} className={classes}>{content}</button>;
}
