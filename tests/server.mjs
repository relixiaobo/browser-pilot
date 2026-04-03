// Fixture server for bp compatibility tests.
// Serves Playwright-style fixture pages plus extra bp-specific pages.
import http from 'node:http';

const PORT = parseInt(process.argv[2] || '18274', 10);

const PAGES = {
  // ── Playwright fixtures (adapted) ──────────────────

  // textarea.html — textarea + input + contenteditable with event tracking
  '/input/textarea': `<title>Textarea test</title>
<textarea spellcheck="false"></textarea>
<input>
<div contenteditable="true" id="ce"></div>
<div class="plain">Plain div</div>
<script>
  window.result = '';
  let textarea = document.querySelector('textarea');
  textarea.addEventListener('input', () => result = textarea.value, false);
  let input = document.querySelector('input');
  input.addEventListener('input', () => result = input.value, false);
</script>`,

  // select.html — select with event tracking
  '/input/select': `<title>Selection Test</title>
<select>
  <option value="black">Black</option>
  <option value="blue">Blue</option>
  <option value="brown">Brown</option>
  <option value="cyan">Cyan</option>
  <option value="gray">Gray</option>
  <option value="green">Green</option>
  <option value="indigo">Indigo</option>
  <option value="magenta">Magenta</option>
  <option value="orange">Orange</option>
  <option value="pink">Pink</option>
  <option value="purple">Purple</option>
  <option value="red">Red</option>
  <option value="violet">Violet</option>
  <option value="white">White</option>
  <option value="yellow">Yellow</option>
</select>
<script>
  window.result = { onInput: null, onChange: null };
  let select = document.querySelector('select');
  select.addEventListener('input', () => {
    result.onInput = Array.from(select.querySelectorAll('option:checked')).map(o => o.value);
  }, false);
  select.addEventListener('change', () => {
    result.onChange = Array.from(select.querySelectorAll('option:checked')).map(o => o.value);
  }, false);
</script>`,

  // keyboard.html — logs keydown/keypress/keyup
  '/input/keyboard': `<title>Keyboard test</title>
<textarea></textarea>
<script>
  window.result = "";
  let textarea = document.querySelector('textarea');
  textarea.focus();
  textarea.addEventListener('keydown', event => {
    log('Keydown:', event.key, event.code, modifiers(event));
  });
  textarea.addEventListener('keypress', event => {
    log('Keypress:', event.key, event.code, event.charCode, modifiers(event));
  });
  textarea.addEventListener('keyup', event => {
    log('Keyup:', event.key, event.code, modifiers(event));
  });
  function modifiers(event) {
    let m = [];
    if (event.altKey) m.push('Alt');
    if (event.ctrlKey) m.push('Control');
    if (event.shiftKey) m.push('Shift');
    return '[' + m.join(' ') + ']';
  }
  function log(...args) { result += args.join(' ') + '\\n'; }
  function getResult() { let t = result.trim(); result = ""; return t; }
</script>`,

  // scrollable.html — 100 buttons, tests click after scroll
  '/input/scrollable': `<title>Scrollable test</title>
<script>
  for (let i = 0; i < 100; i++) {
    let button = document.createElement('button');
    button.textContent = i + ': not clicked';
    button.id = 'button-' + i;
    button.onclick = () => button.textContent = 'clicked';
    document.body.appendChild(button);
    document.body.appendChild(document.createElement('br'));
  }
</script>`,

  // ── Shadow DOM ─────────────────────────────────────

  // Basic shadow DOM with button
  '/shadow/basic': `<title>Shadow DOM</title>
<div id="host"></div>
<script>
  window.clicked = false;
  const host = document.getElementById('host');
  const shadowRoot = host.attachShadow({mode: 'open'});
  const h1 = document.createElement('h1');
  h1.textContent = 'Shadow DOM v1';
  const button = document.createElement('button');
  button.textContent = 'Shadow Button';
  button.addEventListener('click', () => { window.clicked = true; });
  shadowRoot.appendChild(h1);
  shadowRoot.appendChild(button);
</script>`,

  // Deep nested shadow DOM (3 levels)
  '/shadow/deep': `<title>Deep Shadow DOM</title>
<div id="host"></div>
<script>
  const host = document.getElementById('host');

  // Level 1
  const root1 = document.createElement('div');
  root1.id = 'root1';
  host.appendChild(root1);
  const sr1 = root1.attachShadow({mode:'open'});
  const span1 = document.createElement('span');
  span1.textContent = 'Hello from root1';
  sr1.appendChild(span1);

  // Level 2 (inside shadow 1)
  const root2 = document.createElement('div');
  sr1.appendChild(root2);
  const sr2 = root2.attachShadow({mode:'open'});
  const btn2 = document.createElement('button');
  btn2.textContent = 'Deep Button';
  btn2.id = 'deep-btn';
  btn2.addEventListener('click', () => { window.deepClicked = true; });
  sr2.appendChild(btn2);

  // Level 3 (inside shadow 2)
  const root3 = document.createElement('div');
  sr2.appendChild(root3);
  const sr3 = root3.attachShadow({mode:'open'});
  const input3 = document.createElement('input');
  input3.setAttribute('aria-label', 'Deep Input');
  input3.placeholder = 'type here';
  sr3.appendChild(input3);

  window.deepClicked = false;
</script>`,

  // Shadow DOM with input
  '/shadow/input': `<title>Shadow Input</title>
<div id="host"></div>
<script>
  const host = document.getElementById('host');
  const sr = host.attachShadow({mode:'open'});

  const label = document.createElement('label');
  label.textContent = 'Shadow Field';
  const input = document.createElement('input');
  input.setAttribute('aria-label', 'Shadow Field');
  input.type = 'text';
  sr.appendChild(label);
  sr.appendChild(input);

  window.shadowValue = '';
  input.addEventListener('input', () => { window.shadowValue = input.value; });
</script>`,

  // Shadow DOM with custom element + slot
  '/shadow/custom-element': `<title>Custom Element</title>
<template id="my-link-template">
  <a href="#" id="inner-link" onclick="window.clickCount++"><slot></slot></a>
</template>
<my-link>Sign up</my-link>
<script>
  window.clickCount = 0;
  customElements.define('my-link', class extends HTMLElement {
    constructor() {
      super();
      const template = document.getElementById('my-link-template');
      this.attachShadow({mode:'open'}).appendChild(template.content.cloneNode(true));
    }
  });
</script>`,

  // ── Contenteditable variants ───────────────────────

  // Basic contenteditable
  '/ce/basic': `<title>ContentEditable</title>
<div contenteditable="true" id="editor" aria-label="Editor"></div>
<script>
  window.result = '';
  const editor = document.getElementById('editor');
  editor.addEventListener('input', () => { window.result = editor.textContent; });
</script>`,

  // Contenteditable with existing content + selection
  '/ce/existing': `<title>CE Existing</title>
<div contenteditable="true" id="editor" aria-label="Editor">Hello World</div>
<script>
  window.result = '';
  const editor = document.getElementById('editor');
  editor.addEventListener('input', () => { window.result = editor.textContent; });
</script>`,

  // Contenteditable with focus handler that collapses selection (Playwright issue #39492)
  '/ce/focus-collapse': `<title>CE Focus Collapse</title>
<div contenteditable="true" id="editor" aria-label="Editor">initial text</div>
<script>
  window.result = '';
  const editor = document.getElementById('editor');
  editor.addEventListener('focus', () => {
    const sel = window.getSelection();
    if (sel.rangeCount > 0) sel.collapseToEnd();
  });
  editor.addEventListener('input', () => { window.result = editor.textContent; });
</script>`,

  // Contenteditable with beforeinput handler (Playwright issue #36715)
  '/ce/beforeinput': `<title>CE BeforeInput</title>
<div contenteditable="true" id="editor" aria-label="Editor"></div>
<script>
  window.result = '';
  const editor = document.getElementById('editor');
  editor.addEventListener('beforeinput', (event) => {
    event.preventDefault();
    editor.textContent = event.data;
  });
  editor.addEventListener('input', () => { window.result = editor.textContent; });
</script>`,

  // Body contenteditable
  '/ce/body': `<title>CE Body</title>
<script>document.addEventListener('DOMContentLoaded', () => {
  document.body.contentEditable = 'true';
  window.result = '';
  document.body.addEventListener('input', () => { window.result = document.body.textContent; });
});</script>`,

  // ── Special input types ────────────────────────────

  '/input/types': `<title>Input Types</title>
<input type="text" id="text" aria-label="Text Field">
<input type="password" id="password" aria-label="Password">
<input type="search" id="search" aria-label="Search">
<input type="tel" id="tel" aria-label="Phone">
<input type="url" id="url" aria-label="URL">
<input type="number" id="number" aria-label="Number">
<input type="email" id="email" aria-label="Email">
<textarea id="textarea" aria-label="Textarea"></textarea>`,

  '/input/number': `<title>Number Input</title>
<input type="number" id="input" aria-label="Number" min="0" max="100">
<script>
  window.result = '';
  document.getElementById('input').addEventListener('input', e => { window.result = e.target.value; });
</script>`,

  '/input/date': `<title>Date Input</title>
<input type="date" id="date" aria-label="Date">
<input type="time" id="time" aria-label="Time">
<input type="datetime-local" id="datetime" aria-label="DateTime">
<input type="month" id="month" aria-label="Month">
<input type="week" id="week" aria-label="Week">
<input type="color" id="color" aria-label="Color" value="#000000">
<input type="range" id="range" aria-label="Range" min="0" max="100" value="50">`,

  // ── Click edge cases ───────────────────────────────

  // Overlay / modal
  '/click/overlay': `<title>Overlay Test</title>
<button id="behind" onclick="window.behindClicked=true">Behind Button</button>
<div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;">
  <div style="background:white;padding:20px;">
    <button id="modal-btn" onclick="window.modalClicked=true;document.getElementById('overlay').style.display='none'">Close Modal</button>
  </div>
</div>
<script>window.behindClicked=false;window.modalClicked=false;</script>`,

  // Fixed position
  '/click/fixed': `<title>Fixed Position</title>
<div style="height:3000px">Tall page</div>
<button id="fixed-btn" style="position:fixed;bottom:20px;right:20px" onclick="window.fixedClicked=true">Fixed Button</button>
<script>window.fixedClicked=false;</script>`,

  // Element that moves on scroll
  '/click/scroll-target': `<title>Scroll Target</title>
<div style="height:2000px"></div>
<button id="target" onclick="window.targetClicked=true">Bottom Button</button>
<script>window.targetClicked=false;</script>`,

  // ── Frames ─────────────────────────────────────────

  '/frames/host': `<title>Frame Host</title>
<h1>Host Page</h1>
<iframe src="/frames/inner" width="400" height="300" id="frame1"></iframe>`,

  '/frames/inner': `<title>Inner Frame</title>
<h1>Inside Frame</h1>
<button id="frame-btn" onclick="window.frameBtnClicked=true">Frame Button</button>
<input id="frame-input" aria-label="Frame Input" type="text">
<script>window.frameBtnClicked=false;</script>`,

  // Contenteditable inside iframe
  '/frames/ce-host': `<title>CE Frame Host</title>
<h1>Host</h1>
<iframe src="/frames/ce-inner" width="400" height="300"></iframe>`,

  // ── Network test page ───────────────────────────────
  '/net/test': `<title>Network Test</title>
<button id="fetch-btn" onclick="fetch('/api/data').then(r=>r.json()).then(d=>{document.getElementById('result').textContent=JSON.stringify(d)})">Fetch Data</button>
<button id="post-btn" onclick="fetch('/api/post',{method:'POST',body:JSON.stringify({hello:'world'}),headers:{'Content-Type':'application/json'}}).then(r=>r.json()).then(d=>{document.getElementById('result').textContent=JSON.stringify(d)})">POST Data</button>
<button id="track-btn" onclick="var s=document.createElement('script');s.src='/tracking.js';document.head.appendChild(s);setTimeout(()=>{document.getElementById('result').textContent=window.__tracked?'tracked':'not tracked'},500)">Load Tracker</button>
<div id="result"></div>`,

  '/frames/ce-inner': `<title>CE Frame Inner</title>
<div contenteditable="true" id="editor" aria-label="Frame Editor"></div>
<script>
  window.result = '';
  document.getElementById('editor').addEventListener('input', () => {
    window.result = document.getElementById('editor').textContent;
  });
</script>`,
};

const server = http.createServer((req, res) => {
  const path = req.url?.split('?')[0] || '/';

  // ── API endpoints for network interception tests ──
  if (path === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Original': 'true' });
    res.end(JSON.stringify({ source: 'real', timestamp: Date.now() }));
    return;
  }
  if (path === '/api/post') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: body, method: req.method }));
    });
    return;
  }
  if (path === '/api/headers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ headers: req.headers }));
    return;
  }
  if (path === '/api/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slow: true }));
    }, 2000);
    return;
  }
  if (path === '/tracking.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end('window.__tracked = true;');
    return;
  }

  const html = PAGES[path];
  if (html) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Compat test server on http://127.0.0.1:${PORT}`);
});
