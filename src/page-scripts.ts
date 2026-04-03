// JavaScript injected into the page via Runtime.callFunctionOn / Runtime.evaluate.

/** Return {x, y} center of `this` element after scrolling it into view. */
export const GET_CLICK_COORDS = `function() {
  this.scrollIntoView({block:'center',inline:'center'});
  const r = this.getBoundingClientRect();
  return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
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
