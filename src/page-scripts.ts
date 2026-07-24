// JavaScript injected into the page via Runtime.callFunctionOn / Runtime.evaluate.

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
      if (accepts(hit)) return {status:'ready', x, y};
      if (!firstObstruction && hit) firstObstruction = describes(hit);
    }
  }
  return blocked('obscured', firstObstruction);
}`;

/** Focus `this`, set its value (React-compatible), dispatch input+change. */
export const SET_VALUE = `function(text, clear) {
  this.focus();
  const proto = this instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const val = clear ? text : this.value + text;
  if (setter) setter.call(this, val); else this.value = val;
  this.dispatchEvent(new Event('input',  {bubbles:true}));
  this.dispatchEvent(new Event('change', {bubbles:true}));
}`;

/** Focus `this` and optionally clear its value. */
export const FOCUS_AND_CLEAR = `function(clear) {
  this.focus();
  if (clear) { this.value = ''; this.dispatchEvent(new Event('input',{bubbles:true})); }
}`;

/** Check if `this` element is a contenteditable (Draft.js, ProseMirror, etc.). */
export const IS_CONTENTEDITABLE = `function() {
  return this.isContentEditable && !(this instanceof HTMLInputElement) && !(this instanceof HTMLTextAreaElement);
}`;

/** Focus `this` contenteditable element. */
export const CONTENTEDITABLE_FOCUS = `function() {
  this.focus();
}`;

/** Select all content in `this` contenteditable (call after focus has settled). */
export const CONTENTEDITABLE_SELECT_ALL = `function() {
  const range = document.createRange();
  range.selectNodeContents(this);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}`;

/** Clear all content from `this` contenteditable via native editing commands.
 *  Uses execCommand which triggers beforeinput/input events correctly. */
export const CONTENTEDITABLE_CLEAR = `function() {
  this.focus();
  document.execCommand('selectAll');
  document.execCommand('delete');
}`;

/** Focus a contenteditable element and move the caret to its end. */
export const CONTENTEDITABLE_FOCUS_END = `function() {
  this.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(this);
  sel.collapseToEnd();
}`;

/** Return readable input state for verification without page-side logging. */
export const READ_EDITABLE_STATE = `function() {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    return {kind:'input', value:String(this.value ?? ''), sensitive:this instanceof HTMLInputElement && this.type === 'password'};
  }
  if (this.isContentEditable) {
    return {kind:'contenteditable', value:String(this.innerText ?? this.textContent ?? ''), sensitive:false};
  }
  return {kind:'unsupported', value:'', sensitive:false};
}`;

/** Return editable state for the active element, used after keyboard input. */
export const READ_ACTIVE_EDITABLE_STATE = `(() => {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return {kind:'input', value:String(el.value ?? ''), sensitive:el instanceof HTMLInputElement && el.type === 'password'};
  }
  if (el && el.isContentEditable) {
    return {kind:'contenteditable', value:String(el.innerText ?? el.textContent ?? ''), sensitive:false};
  }
  return {kind:'unsupported', value:'', sensitive:false};
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
