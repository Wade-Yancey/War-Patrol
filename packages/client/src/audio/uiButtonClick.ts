/** Short mechanical switch click for UI buttons (station + umpire + landing). */
export const UI_BUTTON_CLICK_SAMPLE_URL = '/audio/ui-button-click.wav';

/** Peak HTMLAudio volume for the click (0–1). */
export const UI_BUTTON_CLICK_VOLUME = 0.45;

/**
 * Minimum gap between click onsets. Restarts the same element instead of
 * stacking overlapping clones on rapid pointer/keyboard repeats.
 */
export const UI_BUTTON_CLICK_COOLDOWN_MS = 55;

const BUTTON_SELECTOR =
  'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]';

let sharedAudio: HTMLAudioElement | null = null;
let lastPlayMs = 0;
let installed = false;

function ensureAudio(): HTMLAudioElement {
  if (!sharedAudio) {
    const audio = new Audio(UI_BUTTON_CLICK_SAMPLE_URL);
    audio.preload = 'auto';
    audio.volume = UI_BUTTON_CLICK_VOLUME;
    sharedAudio = audio;
  }
  return sharedAudio;
}

function isInteractiveButton(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target.closest(BUTTON_SELECTOR);
  if (!(el instanceof HTMLElement)) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
    return !el.disabled;
  }
  return true;
}

/** Play the UI click one-shot (no-op while cooldown is active or autoplay blocked). */
export function playUiButtonClick(): void {
  const now = performance.now();
  if (now - lastPlayMs < UI_BUTTON_CLICK_COOLDOWN_MS) return;
  lastPlayMs = now;
  try {
    const audio = ensureAudio();
    audio.currentTime = 0;
    void audio.play().catch(() => {
      /* Autoplay / unlock — ignore; next user gesture may succeed. */
    });
  } catch {
    /* Ignore decode / element errors so UI clicks never throw. */
  }
}

/**
 * Document-level delegated click SFX for `button` / role=button (and submit inputs).
 * Does not call preventDefault or stopPropagation — real handlers still run.
 * Returns an uninstall function.
 */
export function installUiButtonClickSfx(): () => void {
  if (typeof document === 'undefined' || installed) {
    return () => {};
  }
  installed = true;

  // Warm the element on first gesture so the first audible click is snappy.
  const warm = () => {
    ensureAudio();
    document.removeEventListener('pointerdown', warm, true);
  };
  document.addEventListener('pointerdown', warm, true);

  const onClick = (event: MouseEvent) => {
    // Ignore non-primary mouse buttons; keyboard activation still uses click.
    if (event.button !== 0) return;
    if (!isInteractiveButton(event.target)) return;
    playUiButtonClick();
  };
  // Capture so we hear the click even when a handler stops bubbling.
  document.addEventListener('click', onClick, true);

  return () => {
    document.removeEventListener('pointerdown', warm, true);
    document.removeEventListener('click', onClick, true);
    installed = false;
  };
}
