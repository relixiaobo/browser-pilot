export const REQUIRED_BROWSER_CAPABILITY_SCENARIOS = Object.freeze([
  'ax_only',
  'dom_only',
  'shadow_dom',
  'same_origin_iframe',
  'cross_origin_oopif',
  'overlay',
  'contenteditable',
  'react_controlled_input',
  'navigation',
  'document_replacement',
]);

export const BROWSER_CAPABILITY_FIXTURES = Object.freeze([
  {
    id: 'ax_only',
    path: '/capability/ax-only',
    signals: ['ax_role', 'accessible_name'],
    html: () => `<title>AX-only semantics</title>
<div id="ax-control" role="button" tabindex="0" aria-label="AX Command">custom control</div>`,
  },
  {
    id: 'dom_only',
    path: '/capability/dom-only',
    signals: ['dom_click_handler', 'no_interactive_semantics'],
    html: () => `<title>DOM-only interaction</title>
<div id="dom-control" data-action="command">DOM Command</div>
<div id="hidden-dom-control" hidden>Hidden DOM Command</div>
<div id="disabled-dom-control" aria-disabled="true">Disabled DOM Command</div>
<script>
  window.domActivated = false;
  document.getElementById('dom-control').addEventListener('click', () => { window.domActivated = true; });
  document.getElementById('hidden-dom-control').addEventListener('click', () => {});
  document.getElementById('disabled-dom-control').addEventListener('click', () => {});
</script>`,
  },
  {
    id: 'shadow_dom',
    path: '/capability/shadow-dom',
    signals: ['open_shadow_root', 'nested_interactive_control'],
    html: () => `<title>Shadow DOM fixture</title>
<div id="shadow-host"></div>
<script>
  window.shadowActivated = false;
  const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  button.id = 'shadow-button';
  button.textContent = 'Shadow Command';
  button.addEventListener('click', () => { window.shadowActivated = true; });
  root.append(button);
</script>`,
  },
  {
    id: 'same_origin_iframe',
    path: '/capability/frame-same',
    signals: ['same_origin_frame', 'frame_control'],
    html: () => `<title>Same-origin frame host</title>
<iframe id="same-frame" src="/capability/frame-same-inner"></iframe>`,
  },
  {
    id: 'cross_origin_oopif',
    path: '/capability/frame-cross',
    signals: ['cross_origin_frame', 'oopif_target'],
    html: ({ crossOrigin }) => `<title>Cross-origin frame host</title>
<iframe id="cross-frame" src="${crossOrigin}/capability/frame-cross-inner"></iframe>`,
  },
  {
    id: 'overlay',
    path: '/capability/overlay',
    signals: ['obscured_control', 'modal_control'],
    html: () => `<title>Overlay fixture</title>
<button id="behind">Behind Overlay</button>
<div id="fixture-overlay" role="dialog" aria-modal="true" aria-label="Blocking dialog">
  <button id="modal-action">Resolve Overlay</button>
</div>
<style>
  #behind { position: fixed; left: 40px; top: 40px; width: 180px; height: 48px; }
  #fixture-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.4); }
  #modal-action { position: fixed; left: 280px; top: 40px; }
</style>`,
  },
  {
    id: 'contenteditable',
    path: '/capability/contenteditable',
    signals: ['rich_textbox', 'nested_markup'],
    html: () => `<title>Contenteditable fixture</title>
<div id="editor" contenteditable="true" aria-label="Fixture editor">one <strong>two</strong></div>`,
  },
  {
    id: 'react_controlled_input',
    path: '/capability/react-controlled',
    signals: ['controlled_value', 'async_rollback'],
    html: () => `<title>React-style controlled input</title>
<input id="controlled" aria-label="Controlled field" value="fixed">
<script>
  (() => {
    const field = document.getElementById('controlled');
    const modelValue = field.value;
    window.fixtureRollbackCount = 0;
    field.addEventListener('input', () => {
      queueMicrotask(() => {
        field.value = modelValue;
        window.fixtureRollbackCount += 1;
      });
    });
  })();
</script>`,
  },
  {
    id: 'navigation',
    path: '/capability/navigation',
    signals: ['top_level_navigation', 'loader_change'],
    html: () => `<title>Navigation fixture</title>
<button id="navigate" onclick="location.href='/capability/navigation-next'">Navigate</button>`,
  },
  {
    id: 'document_replacement',
    path: '/capability/document-replacement',
    signals: ['same_url', 'new_document'],
    html: () => `<title>Document replacement fixture</title>
<button id="replace-document">Replace document</button>
<script>
  document.getElementById('replace-document').addEventListener('click', () => {
    document.open();
    document.write('<!doctype html><title>Replaced document</title><main id="replacement">replacement complete</main>');
    document.close();
  });
</script>`,
  },
]);

const fixturesByPath = new Map(BROWSER_CAPABILITY_FIXTURES.map(fixture => [fixture.path, fixture]));

const SUPPORT_PAGES = new Map([
  ['/capability/frame-same-inner', `<title>Same-origin frame</title>
<button id="same-frame-button">Same Frame Command</button>`],
  ['/capability/frame-cross-inner', `<title>Cross-origin frame</title>
<button id="cross-frame-button">Cross Frame Command</button>`],
  ['/capability/navigation-next', `<title>Navigation complete</title>
<main id="navigation-complete">navigation complete</main>`],
]);

export function renderBrowserCapabilityFixture(path, options = {}) {
  const support = SUPPORT_PAGES.get(path);
  if (support) return support;
  const fixture = fixturesByPath.get(path);
  if (!fixture) return undefined;
  const crossOrigin = options.crossOrigin ?? 'http://localhost';
  return fixture.html({ crossOrigin });
}
