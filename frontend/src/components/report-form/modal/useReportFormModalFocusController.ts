import { useCallback, useRef } from "react";
import { MODAL_FIELD_ORDER, type ModalFieldKey, isModalFieldEmpty } from "./types";

import type { FormState } from "../types";

export function useReportFormModalFocusController() {
  const formRef = useRef<HTMLFormElement>(null);

  const getModalFieldEl = useCallback((key: ModalFieldKey): HTMLElement | null => {
    const form = formRef.current;
    if (!form) return null;
    const root = form.querySelector<HTMLElement>(`[data-inline-editor-key="modal-${key}"]`);
    if (!root) return null;
    if (
      root instanceof HTMLInputElement ||
      root instanceof HTMLTextAreaElement ||
      root instanceof HTMLButtonElement ||
      root instanceof HTMLSelectElement
    ) {
      return root;
    }
    const nestedFocusable = root.querySelector<HTMLElement>(
      "input, textarea, button, select, [tabindex]"
    );
    return nestedFocusable ?? root;
  }, []);

  const focusModalField = useCallback((key: ModalFieldKey): boolean => {
    const el = getModalFieldEl(key);
    if (!el) {
      return false;
    }
    const scrollTarget =
      el.closest<HTMLElement>("label, .modal-field") ??
      el.closest<HTMLElement>(".modal-reason-section") ??
      el;
    scrollTarget.scrollIntoView({
      block: "center",
      inline: "nearest",
    });
    el.focus();
    return true;
  }, [getModalFieldEl]);

  const focusModalSubmitButton = useCallback((intent: "save" | "save-and-next"): boolean => {
    const button = formRef.current?.querySelector<HTMLButtonElement>(
      `.modal-actions button[data-submit-intent="${intent}"]`
    );
    if (!button || button.disabled) {
      return false;
    }
    button.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
    button.focus();
    return true;
  }, []);

  const focusNextEmptyModalField = useCallback(
    (
      currentKey: ModalFieldKey,
      state: FormState,
      options: { wrap?: boolean } = {}
    ): boolean => {
      const currentIndex = MODAL_FIELD_ORDER.indexOf(currentKey);
      if (currentIndex === -1) {
        return false;
      }

      const findNextIndex = (startIndex: number): ModalFieldKey | null => {
        for (let index = startIndex; index < MODAL_FIELD_ORDER.length; index += 1) {
          const key = MODAL_FIELD_ORDER[index];
          if (isModalFieldEmpty(key, state)) {
            return key;
          }
        }
        return null;
      };

      const nextKey =
        findNextIndex(currentIndex + 1) ??
        (options.wrap ? findNextIndex(0) : null);
      if (!nextKey) {
        return false;
      }

      window.setTimeout(() => {
        focusModalField(nextKey);
      }, 0);
      return true;
    },
    [focusModalField]
  );

  return {
    formRef,
    getModalFieldEl,
    focusModalField,
    focusModalSubmitButton,
    focusNextEmptyModalField,
    modalFieldOrder: MODAL_FIELD_ORDER,
  };
}
