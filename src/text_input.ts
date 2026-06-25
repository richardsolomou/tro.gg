type TextInputSession = {
  value: string;
  maxLength: number;
  onChange(value: string): void;
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

    input.addEventListener("input", () => {
      if (!active) return;
      active.onChange(input!.value);
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
