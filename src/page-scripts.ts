// JavaScript injected into the page via Runtime.callFunctionOn / Runtime.evaluate.

const CLICK_TARGET_STATE_FUNCTION = `function() {
  const target = this;
  if (!target || target.nodeType !== 1 || !target.isConnected) {
    return {connected:false, kind:'other', focused:false};
  }
  const composedParent = node => {
    if (node && node.parentElement) return node.parentElement;
    const root = node && typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  };
  const composedContains = (container, node) => {
    for (let current = node; current; current = composedParent(current)) {
      if (current === container) return true;
    }
    return false;
  };
  const isShadowHostOf = (node, possibleHost) => {
    let root = node && typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    while (root && root.host) {
      if (root.host === possibleHost) return true;
      root = typeof root.host.getRootNode === 'function' ? root.host.getRootNode() : null;
    }
    return false;
  };
  const token = (value, mixed) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return mixed && normalized === 'mixed' ? 'mixed' : undefined;
  };
  const tag = String(target.tagName || '').toLowerCase();
  const role = String(target.getAttribute && target.getAttribute('role') || '').trim().toLowerCase();
  const inputType = tag === 'input' ? String(target.type || '').toLowerCase() : '';
  let kind = 'other';
  if (inputType === 'checkbox' || role === 'checkbox' || role === 'menuitemcheckbox') kind = 'checkbox';
  else if (inputType === 'radio' || role === 'radio' || role === 'menuitemradio') kind = 'radio';
  else if (role === 'switch') kind = 'switch';
  else if (tag === 'option' || role === 'option') kind = 'option';
  else if (tag === 'select' || role === 'listbox' || role === 'combobox') kind = 'select';
  else if (
    tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' ||
    role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem'
  ) kind = 'control';

  const state = {connected:true, kind, focused:false};
  if ((kind === 'checkbox' || kind === 'radio') && tag === 'input') {
    state.checked = !!target.checked;
  } else if (kind === 'checkbox' || kind === 'radio' || kind === 'switch') {
    const checked = token(target.getAttribute('aria-checked'), true);
    if (checked !== undefined) state.checked = checked;
  }
  if (kind === 'option' && tag === 'option') state.selected = !!target.selected;
  else {
    const selected = token(target.getAttribute('aria-selected'), false);
    if (selected !== undefined) state.selected = selected === true;
  }
  const pressed = token(target.getAttribute('aria-pressed'), true);
  if (pressed !== undefined) state.pressed = pressed;
  const expanded = token(target.getAttribute('aria-expanded'), false);
  if (expanded !== undefined) state.expanded = expanded === true;

  let active = document.activeElement;
  for (let depth = 0; depth < 32 && active && active.shadowRoot && active.shadowRoot.activeElement; depth += 1) {
    active = active.shadowRoot.activeElement;
  }
  state.focused = active === target || composedContains(target, active) || isShadowHostOf(target, active);
  return state;
}`;

/** Read bounded semantic and focus state for click verification. */
export const READ_CLICK_TARGET_STATE = CLICK_TARGET_STATE_FUNCTION;

/** Validate `this` as a pointer target and return a safe in-viewport point. */
export const GET_POINTER_TARGET_STATE = `function() {
  const blocked = (reason, obstruction) => ({
    status: 'blocked',
    reason,
    ...(obstruction ? {obstruction} : {}),
  });
  const composedParent = node => {
    if (node && node.parentElement) return node.parentElement;
    const root = node && typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  };
  const composedContains = (container, node) => {
    for (let current = node; current; current = composedParent(current)) {
      if (current === container) return true;
    }
    return false;
  };
  const isShadowHostOf = (node, possibleHost) => {
    let root = node && typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    while (root && root.host) {
      if (root.host === possibleHost) return true;
      root = typeof root.host.getRootNode === 'function' ? root.host.getRootNode() : null;
    }
    return false;
  };
  const describes = node => {
    if (!node || typeof node.tagName !== 'string') return undefined;
    const tagName = node.tagName.toLowerCase().slice(0, 40);
    const rawRole = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null;
    const role = typeof rawRole === 'string' ? rawRole.trim().slice(0, 40) : '';
    return role ? {tagName, role} : {tagName};
  };

  const target = this;
  if (!target || target.nodeType !== 1 || !target.isConnected) return blocked('detached');
  target.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
  if (!target.isConnected) return blocked('detached');

  const style = getComputedStyle(target);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
    return blocked('no_layout');
  }

  for (let current = target; current; current = composedParent(current)) {
    const ariaDisabled = typeof current.getAttribute === 'function'
      ? current.getAttribute('aria-disabled') : null;
    const nativeDisabled = typeof current.matches === 'function' && current.matches(':disabled');
    if (nativeDisabled || current.inert === true || String(ariaDisabled).trim().toLowerCase() === 'true') {
      return blocked('disabled');
    }
  }

  const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
  const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
  const rectList = target.getClientRects();
  const rects = [];
  for (let index = 0; index < Math.min(rectList.length, 64); index += 1) {
    const rect = rectList[index];
    if (
      Number.isFinite(rect.left) && Number.isFinite(rect.top) &&
      Number.isFinite(rect.right) && Number.isFinite(rect.bottom) &&
      rect.width > 0 && rect.height > 0
    ) rects.push(rect);
  }
  if (rects.length === 0) return blocked('no_layout');

  const visibleRects = rects.map(rect => ({
    left: Math.max(0, rect.left),
    top: Math.max(0, rect.top),
    right: Math.min(viewportWidth, rect.right),
    bottom: Math.min(viewportHeight, rect.bottom),
  })).filter(rect => rect.right > rect.left && rect.bottom > rect.top)
    .sort((a, b) => ((b.right - b.left) * (b.bottom - b.top)) - ((a.right - a.left) * (a.bottom - a.top)))
    .slice(0, 4);
  if (visibleRects.length === 0) return blocked('outside_viewport');

  const labels = [];
  if (target.labels && typeof target.labels.length === 'number') {
    for (let index = 0; index < Math.min(target.labels.length, 32); index += 1) {
      labels.push(target.labels[index]);
    }
  }
  for (let current = target; current; current = composedParent(current)) {
    if (String(current.tagName).toLowerCase() === 'label') labels.push(current);
  }
  const accepts = hit => {
    if (!hit) return false;
    if (hit === target || composedContains(target, hit) || isShadowHostOf(target, hit)) return true;
    return labels.some(label => (
      hit === label || composedContains(label, hit) || isShadowHostOf(label, hit)
    ));
  };

  let firstObstruction;
  for (const rect of visibleRects) {
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    const points = [
      [rect.left + width * 0.5, rect.top + height * 0.5],
      [rect.left + width * 0.25, rect.top + height * 0.25],
      [rect.left + width * 0.75, rect.top + height * 0.25],
      [rect.left + width * 0.25, rect.top + height * 0.75],
      [rect.left + width * 0.75, rect.top + height * 0.75],
    ];
    for (const [x, y] of points) {
      const hit = document.elementsFromPoint(x, y)[0];
      if (accepts(hit)) {
        const readClickTargetState = ${CLICK_TARGET_STATE_FUNCTION};
        return {status:'ready', x, y, targetState:readClickTargetState.call(target)};
      }
      if (!firstObstruction && hit) firstObstruction = describes(hit);
    }
  }
  return blocked('obscured', firstObstruction);
}`;

const EDITABLE_STATE_FUNCTION = `function(target) {
  const unsupported = (reason, inputType) => ({
    kind:'unsupported', value:'', sensitive:false, editable:false,
    ...(inputType ? {inputType} : {}), reason,
  });
  if (!target || target.nodeType !== 1 || !target.isConnected) return unsupported('detached');

  const composedParent = node => {
    if (node && node.parentElement) return node.parentElement;
    const root = node && typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  };
  const hasComposedState = (node, property, attribute) => {
    for (let current = node; current; current = composedParent(current)) {
      if (current[property] === true || current.hasAttribute?.(attribute)) return true;
    }
    return false;
  };
  const ariaTrue = (node, name) => String(node.getAttribute?.(name) || '').trim().toLowerCase() === 'true';
  const blockedReason = node => {
    if (hasComposedState(node, 'inert', 'inert')) return 'inert';
    for (let current = node; current; current = composedParent(current)) {
      if (current.matches?.(':disabled') || current.disabled === true || ariaTrue(current, 'aria-disabled')) {
        return 'disabled';
      }
    }
    for (let current = node; current; current = composedParent(current)) {
      if (current.readOnly === true || ariaTrue(current, 'aria-readonly')) return 'readonly';
    }
    return null;
  };
  const contenteditableRoot = node => {
    let root = node;
    while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
    return root;
  };

  if (target instanceof HTMLInputElement) {
    const inputType = String(target.type || 'text').toLowerCase();
    const rangeTextTypes = new Set(['text', 'search', 'tel', 'url', 'password']);
    const selectTextTypes = new Set(['email', 'number']);
    const valueTypes = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
    const editMode = rangeTextTypes.has(inputType) || selectTextTypes.has(inputType)
      ? 'text' : valueTypes.has(inputType) ? 'value' : null;
    if (!editMode) return unsupported('unsupported_input_type', inputType);
    const reason = blockedReason(target);
    return {
      kind:'input', value:String(target.value ?? ''), sensitive:inputType === 'password',
      editable:!reason, inputType, editMode,
      ...(editMode === 'text' ? {selectionMode:selectTextTypes.has(inputType) ? 'select' : 'range'} : {}),
      ...(reason ? {reason} : {}),
    };
  }
  if (target instanceof HTMLTextAreaElement) {
    const reason = blockedReason(target);
    return {
      kind:'input', value:String(target.value ?? ''), sensitive:false,
      editable:!reason, inputType:'textarea', editMode:'text', selectionMode:'range',
      ...(reason ? {reason} : {}),
    };
  }
  if (target.isContentEditable) {
    const root = contenteditableRoot(target);
    const reason = blockedReason(root);
    return {
      kind:'contenteditable', value:String(root.innerText ?? root.textContent ?? ''), sensitive:false,
      editable:!reason, inputType:'contenteditable', editMode:'text', selectionMode:'range',
      ...(reason ? {reason} : {}),
    };
  }
  return unsupported('unsupported_element');
}`;

/** Validate and focus an editable target, then select its replacement/insertion range. */
export const PREPARE_EDITABLE_TARGET = `function(clear) {
  const readState = ${EDITABLE_STATE_FUNCTION};
  const state = readState(this);
  if (!state.editable) return state;

  if (state.kind === 'input') {
    this.focus();
    const focusedState = readState(this);
    if (!focusedState.editable) return focusedState;
    if (focusedState.editMode === 'text') {
      if (focusedState.selectionMode === 'range') {
        const end = String(this.value ?? '').length;
        this.setSelectionRange(clear ? 0 : end, end, 'none');
      } else if (clear) {
        this.select();
      }
    }
    return focusedState;
  }

  let root = this;
  while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
  root.focus();
  const focusedState = readState(root);
  if (!focusedState.editable) return focusedState;
  const range = document.createRange();
  range.selectNodeContents(root);
  if (!clear) range.collapse(false);
  const selection = window.getSelection();
  if (!selection) return {...focusedState, editable:false, reason:'selection_unavailable'};
  selection.removeAllRanges();
  selection.addRange(range);
  return focusedState;
}`;

/** Set non-text value controls while preserving framework setter interception. */
export const SET_VALUE_CONTROL = `function(value) {
  const readState = ${EDITABLE_STATE_FUNCTION};
  const state = readState(this);
  if (!state.editable || state.kind !== 'input' || state.editMode !== 'value') return;
  this.focus();
  const beforeInput = new InputEvent('beforeinput', {
    bubbles:true, composed:true, cancelable:true, inputType:'insertReplacementText', data:value,
  });
  if (!this.dispatchEvent(beforeInput)) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(this, value); else this.value = value;
  this.dispatchEvent(new InputEvent('input', {
    bubbles:true, composed:true, inputType:'insertReplacementText', data:value,
  }));
}`;

/** Return readable input state for verification without page-side logging. */
export const READ_EDITABLE_STATE = `function() {
  const readState = ${EDITABLE_STATE_FUNCTION};
  return readState(this);
}`;

/** Return editable state for the deepest active element, including open Shadow DOM. */
export const READ_ACTIVE_EDITABLE_STATE = `(() => {
  const readState = ${EDITABLE_STATE_FUNCTION};
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return readState(active);
})()`;

/** Return {title, url} of the current page. */
export const PAGE_INFO = `JSON.stringify({title:document.title,url:location.href})`;

/** Return full-page dimensions. */
export const PAGE_DIMENSIONS = `JSON.stringify({
  width:  Math.max(document.documentElement.scrollWidth,  document.documentElement.clientWidth),
  height: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight)
})`;

/** Inject pulsing glow overlay to indicate agent is active. CSP-safe via Web Animations API. */
export const INJECT_BORDER = `(() => {
  if (document.getElementById('__bp_overlay')) return;
  const d = document.createElement('div');
  d.id = '__bp_overlay';
  d.setAttribute('aria-hidden','true');
  d.setAttribute('role','presentation');
  Object.assign(d.style, {position:'fixed',inset:'0',zIndex:'2147483647',pointerEvents:'none'});
  document.documentElement.appendChild(d);
  try{d.animate([
    {boxShadow:'inset 0 0 20px rgba(59,130,246,.8),inset 0 0 40px rgba(59,130,246,.4),inset 0 0 80px rgba(59,130,246,.15)'},
    {boxShadow:'inset 0 0 30px rgba(59,130,246,1),inset 0 0 60px rgba(59,130,246,.5),inset 0 0 100px rgba(59,130,246,.2)'},
    {boxShadow:'inset 0 0 20px rgba(59,130,246,.8),inset 0 0 40px rgba(59,130,246,.4),inset 0 0 80px rgba(59,130,246,.15)'},
  ],{duration:2500,iterations:Infinity,easing:'ease-in-out'})}catch(e){}
})()`;

/** Remove border overlay. */
export const REMOVE_BORDER = `(() => {
  document.getElementById('__bp_overlay')?.remove();
})()`;

/** Return bounding rect of a querySelector match (or null). */
export function elementRect(selector: string): string {
  return `JSON.stringify((() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x:r.x, y:r.y, width:r.width, height:r.height};
  })())`;
}

/** Extract cleaned readable text from a page or element.
 *  - Strips scripts/styles/nav/footer/aside/ads
 *  - Collapses whitespace
 *  - Returns title + url + text
 *  Designed for LLM agents that need to "see" content the accessibility tree misses
 *  (search results, article bodies, list cards).
 */
export function readContent(selector: string | null, limit: number): string {
  return `JSON.stringify((() => {
    const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : `(document.querySelector('main') || document.querySelector('article') || document.querySelector('[role="main"]') || document.body)`};
    if (!root) return {ok:false, error:'No content root found'};
    // Clone so we don't mutate the live DOM
    const clone = root.cloneNode(true);
    const drop = clone.querySelectorAll('script,style,noscript,nav,footer,aside,svg,iframe,[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]');
    drop.forEach(el => el.remove());
    // Collapse whitespace
    let text = (clone.innerText || clone.textContent || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
    const truncated = text.length > ${limit};
    if (truncated) text = text.slice(0, ${limit});
    return {
      ok: true,
      title: document.title,
      url: location.href,
      text,
      length: text.length,
      truncated
    };
  })())`;
}
