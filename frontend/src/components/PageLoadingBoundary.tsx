import type { ReactNode } from "react";
import "./page-loading-boundary.css";

export type PageLoadingState =
  | {
      kind: "pending";
      message: string;
    }
  | {
      kind: "error";
      title: string;
      message: string;
      action?: {
        label: string;
        onClick: () => void;
      };
    }
  | {
      kind: "ready";
    };

interface LoadingSpinnerProps {
  size?: "small" | "medium" | "large";
  tone?: "light" | "dark";
}

interface BackgroundLoadingIndicatorProps {
  label: string;
  className?: string;
  tone?: "light" | "dark";
}

interface PageLoadingBoundaryProps {
  state: PageLoadingState;
  children?: ReactNode;
  variant?: "page" | "section" | "compact";
  tone?: "light" | "dark";
  className?: string;
}

function joinClassNames(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export function LoadingSpinner({
  size = "medium",
  tone = "light",
}: LoadingSpinnerProps) {
  return (
    <span
      className={joinClassNames(
        "loading-spinner",
        `loading-spinner--${size}`,
        tone === "dark" && "loading-spinner--dark"
      )}
      aria-hidden="true"
    />
  );
}

export function BackgroundLoadingIndicator({
  label,
  className,
  tone = "light",
}: BackgroundLoadingIndicatorProps) {
  return (
    <span
      className={joinClassNames(
        "background-loading-indicator",
        tone === "dark" && "background-loading-indicator--dark",
        className
      )}
      role="status"
      aria-live="polite"
    >
      <LoadingSpinner size="small" tone={tone} />
      <span>{label}</span>
    </span>
  );
}

export function PageLoadingBoundary({
  state,
  children,
  variant = "section",
  tone = "light",
  className,
}: PageLoadingBoundaryProps) {
  if (state.kind === "pending") {
    return (
      <section
        className={joinClassNames(
          "page-loading-boundary",
          `page-loading-boundary--${variant}`,
          tone === "dark" && "page-loading-boundary--dark",
          className
        )}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="page-loading-boundary__content">
          <LoadingSpinner size={variant === "compact" ? "medium" : "large"} tone={tone} />
          <p>{state.message}</p>
        </div>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section
        className={joinClassNames(
          "page-loading-boundary",
          "page-loading-boundary--error",
          `page-loading-boundary--${variant}`,
          tone === "dark" && "page-loading-boundary--dark",
          className
        )}
        role="alert"
      >
        <div className="page-loading-boundary__content">
          <strong>{state.title}</strong>
          <p>{state.message}</p>
          {state.action ? (
            <button type="button" onClick={state.action.onClick}>
              {state.action.label}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return <>{children}</>;
}
