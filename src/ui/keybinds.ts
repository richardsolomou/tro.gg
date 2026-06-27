type KeybindHandler = (event: KeyboardEvent) => void;

export interface Keybind {
  id: string;
  matches: (event: KeyboardEvent) => boolean;
  handler: KeybindHandler;
}

const bindings = new Map<string, Keybind>();
let listening = false;

/** Register a global keybind, ignored while a real typing field owns input. */
export function registerKeybind(binding: Keybind): () => void {
  bindings.set(binding.id, binding);
  if (!listening) {
    window.addEventListener("keydown", onKeyDown);
    listening = true;
  }

  return () => {
    if (bindings.get(binding.id) !== binding) return;
    bindings.delete(binding.id);
    if (bindings.size === 0 && listening) {
      window.removeEventListener("keydown", onKeyDown);
      listening = false;
    }
  };
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.repeat || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;

  for (const binding of bindings.values()) {
    if (!binding.matches(event)) continue;
    event.preventDefault();
    binding.handler(event);
    return;
  }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable === true;
}
