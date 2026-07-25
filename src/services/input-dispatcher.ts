import { invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';

const KEY_DEFINITIONS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  '0': { key: '0', code: 'Digit0', keyCode: 48 },
  '1': { key: '1', code: 'Digit1', keyCode: 49 },
  '2': { key: '2', code: 'Digit2', keyCode: 50 },
  '3': { key: '3', code: 'Digit3', keyCode: 51 },
  '4': { key: '4', code: 'Digit4', keyCode: 52 },
  '5': { key: '5', code: 'Digit5', keyCode: 53 },
  '6': { key: '6', code: 'Digit6', keyCode: 54 },
  '7': { key: '7', code: 'Digit7', keyCode: 55 },
  '8': { key: '8', code: 'Digit8', keyCode: 56 },
  '9': { key: '9', code: 'Digit9', keyCode: 57 },
  '-': { key: '-', code: 'Minus', keyCode: 189 },
  '=': { key: '=', code: 'Equal', keyCode: 187 },
  '[': { key: '[', code: 'BracketLeft', keyCode: 219 },
  ']': { key: ']', code: 'BracketRight', keyCode: 221 },
  '\\': { key: '\\', code: 'Backslash', keyCode: 220 },
  ';': { key: ';', code: 'Semicolon', keyCode: 186 },
  "'": { key: "'", code: 'Quote', keyCode: 222 },
  ',': { key: ',', code: 'Comma', keyCode: 188 },
  '.': { key: '.', code: 'Period', keyCode: 190 },
  '/': { key: '/', code: 'Slash', keyCode: 191 },
  '`': { key: '`', code: 'Backquote', keyCode: 192 },
};

const MODIFIER_DEFINITIONS: Record<string, { key: string; code: string; keyCode: number; mask: number }> = {
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17, mask: 2 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17, mask: 2 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, mask: 8 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, mask: 1 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, mask: 4 },
  cmd: { key: 'Meta', code: 'MetaLeft', keyCode: 91, mask: 4 },
  command: { key: 'Meta', code: 'MetaLeft', keyCode: 91, mask: 4 },
};

function charDefinition(char: string): { key: string; code: string; keyCode: number } {
  const known = KEY_DEFINITIONS[char];
  if (known) return known;
  if (/^[a-zA-Z]$/.test(char)) {
    return { key: char, code: `Key${char.toUpperCase()}`, keyCode: char.toUpperCase().charCodeAt(0) };
  }
  if (char === ' ') return { key: ' ', code: 'Space', keyCode: 32 };
  return { key: char, code: '', keyCode: char.charCodeAt(0) };
}

export interface PointerClickOptions {
  button?: 'left' | 'right';
  clickCount?: 1 | 2;
}

export class InputDispatcher {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
  ) {}

  async click(x: number, y: number, options: PointerClickOptions = {}): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw invalidArgument('Click coordinates must be finite numbers');
    }
    const button = options.button ?? 'left';
    const clickCount = options.clickCount ?? 1;
    if (button === 'right' && clickCount !== 1) {
      throw invalidArgument('Right click does not support clickCount 2');
    }
    await this.transport.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none',
    }, this.sessionId);
    await this.transport.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, clickCount,
    }, this.sessionId);
    await this.transport.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, clickCount,
    }, this.sessionId);
  }

  async press(combo: string): Promise<void> {
    if (!combo) throw invalidArgument('Key combination must not be empty', 'key');
    const parts = combo.split('+');
    const mainKey = parts.pop();
    if (!mainKey) throw invalidArgument(`Invalid key combination: ${combo}`, 'key');

    const modifiers = parts.map(part => {
      const modifier = MODIFIER_DEFINITIONS[part.toLowerCase()];
      if (!modifier) throw invalidArgument(`Unknown modifier: ${part}`, 'key');
      return modifier;
    });
    const modifierFlags = modifiers.reduce((value, modifier) => value | modifier.mask, 0);
    const known = KEY_DEFINITIONS[mainKey.toLowerCase()];
    const key = known?.key ?? mainKey;
    const code = known?.code ?? (mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey);
    const keyCode = known?.keyCode ?? mainKey.toUpperCase().charCodeAt(0);
    const commands = mainKey.toLowerCase() === 'a' && modifiers.length === 1 && (
      modifiers[0].key === 'Control' || modifiers[0].key === 'Meta'
    ) ? ['SelectAll'] : undefined;

    for (const modifier of modifiers) {
      await this.transport.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: modifier.key,
        code: modifier.code,
        windowsVirtualKeyCode: modifier.keyCode,
        modifiers: modifierFlags,
      }, this.sessionId);
    }
    const text = key === 'Enter' ? '\r' : (known || modifiers.length > 0 ? '' : mainKey);
    await this.transport.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text, modifiers: modifierFlags,
      ...(commands ? { commands } : {}),
    }, this.sessionId);
    await this.transport.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers: modifierFlags,
    }, this.sessionId);
    for (const modifier of [...modifiers].reverse()) {
      await this.transport.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode,
      }, this.sessionId);
    }
  }

  async typeText(text: string, delayMs = 0): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw invalidArgument('Typing delay must be a non-negative number', 'delayMs');
    }
    for (const char of text) {
      if (char === '\n') {
        await this.press('Enter');
      } else if (char === '\t') {
        await this.press('Tab');
      } else if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
        const { key, code, keyCode } = charDefinition(char);
        await this.transport.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text: char,
        }, this.sessionId);
        await this.transport.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode,
        }, this.sessionId);
      } else {
        await this.insertText(char);
      }
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  async insertText(text: string): Promise<void> {
    await this.transport.send('Input.insertText', { text }, this.sessionId);
  }
}
