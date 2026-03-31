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

/** Return {title, url} of the current page. */
export const PAGE_INFO = `JSON.stringify({title:document.title,url:location.href})`;

/** Return full-page dimensions. */
export const PAGE_DIMENSIONS = `JSON.stringify({
  width:  Math.max(document.documentElement.scrollWidth,  document.documentElement.clientWidth),
  height: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight)
})`;

/** Return bounding rect of a querySelector match (or null). */
export function elementRect(selector: string): string {
  return `JSON.stringify((() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x:r.x, y:r.y, width:r.width, height:r.height};
  })())`;
}
