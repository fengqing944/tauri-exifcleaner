import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

export function UtilityDrawer(props: {
  isOpen: boolean;
  title: string;
  subtitle: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (props.isOpen) {
      closeButtonRef.current?.focus();
    }
  }, [props.isOpen]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const drawer = drawerRef.current;
    if (!drawer) {
      return;
    }

    const focusableElements = Array.from(
      drawer.querySelectorAll<HTMLElement>(
        'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("tabindex") !== "-1",
    );

    if (!focusableElements.length) {
      event.preventDefault();
      drawer.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      if (!activeElement || activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      }
      return;
    }

    if (activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  if (!props.isOpen) {
    return null;
  }

  return (
    <div className="details-drawer-backdrop" onClick={props.onClose}>
      <aside
        ref={drawerRef}
        className={`details-drawer utility-drawer ${props.className ?? ""}`.trim()}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="details-drawer-head utility-drawer-head">
          <div>
            <strong>{props.title}</strong>
            <span>{props.subtitle}</span>
          </div>
          <button
            ref={closeButtonRef}
            className="button"
            type="button"
            onClick={props.onClose}
          >
            关闭
          </button>
        </div>

        <div
          className={`details-drawer-body utility-drawer-body ${
            props.bodyClassName ?? ""
          }`.trim()}
        >
          {props.children}
        </div>
      </aside>
    </div>
  );
}
