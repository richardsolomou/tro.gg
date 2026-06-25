type TextInputSession = {
  value: string;
  maxLength: number;
  /** `caret` is the insertion-point index, so callers can render their own cursor. */
  onChange(value: string, caret: number): void;
  onSubmit(value: string): void;
  onCancel(): void;
  onBlur(): void;
  onKeyDown?(e: KeyboardEvent, input: HTMLInputElement): void;
};

let input: HTMLInputElement | undefined;
let active: TextInputSession | undefined;

function ensureInput(): HTMLInputElement {
  if (!input) {
    input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.enterKeyHint = "send";
    Object.assign(input.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "1px",
      height: "1px",
      opacity: "0.01",
      border: "0",
      padding: "0",
      background: "transparent",
      color: "transparent",
      caretColor: "transparent",
      pointerEvents: "none",
      zIndex: "2147483647",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(input);

    const notify = () => {
      if (!active) return;
      active.onChange(input!.value, input!.selectionStart ?? input!.value.length);
    };

    input.addEventListener("input", notify);
    // The caret also moves on arrow keys, Home/End and selection without firing
    // "input"; selectionchange catches those so the rendered cursor keeps up.
    document.addEventListener("selectionchange", () => {
      if (document.activeElement === input) notify();
    });
    input.addEventListener("keydown", (e) => {
      if (!active) return;
      active.onKeyDown?.(e, input!);
      if (e.defaultPrevented) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const session = active;
        const value = input!.value;
        active = undefined;
        input!.blur();
        session.onSubmit(value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const session = active;
        active = undefined;
        input!.blur();
        session.onCancel();
      }
    });
    input.addEventListener("blur", () => {
      const session = active;
      active = undefined;
      session?.onBlur();
    });
  }
  return input;
}

export function focusTextInput(session: TextInputSession): void {
  const el = ensureInput();
  if (active) active.onBlur();
  active = session;
  el.maxLength = session.maxLength;
  el.value = session.value;
  el.focus({ preventScroll: true });
}

export function blurTextInput(): void {
  if (!input || !active) return;
  active = undefined;
  input.blur();
}

export function isTextInputActive(): boolean {
  return active !== undefined;
}
