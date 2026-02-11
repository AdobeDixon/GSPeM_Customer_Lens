const GS4PM_HOST = 'experience.adobe.com';
const GS4PM_TOKEN = 'genstudio';

function isGs4pmUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === GS4PM_HOST && url.toLowerCase().includes(GS4PM_TOKEN);
  } catch (error) {
    return false;
  }
}

function isGs4pmContext() {
  // In recent GS4PM builds, the main app UI may render inside iframes whose own URL
  // does not include the `genstudio` token. We still need tagging listeners inside
  // those frames as long as the *top frame* is a GS4PM tab.
  if (isGs4pmUrl(window.location.href)) return true;
  try {
    if (window.top && window.top !== window && isGs4pmUrl(window.top.location.href)) return true;
  } catch {
    // Cross-origin: we can't inspect the top URL. Fall back to the frame URL only.
  }
  return false;
}

const SHOULD_RUN = isGs4pmContext();

if (!SHOULD_RUN) {
  console.log('[GS4PM Filter] Skipping non-GS4PM page:', window.location.href);
} else {
let tagging = false;
let currentTagCustomer = null;
let hoverHandler = null;
let clickHandler = null;
let pointerDownHandler = null;
let pointerUpHandler = null;
let escapeHandler = null;
let repositionHighlight = null;
let bannerResizeHandler = null;
let lastOutlinedContainer = null;
let lastRightClickedSelector = null;
let currentFilterCustomer = 'ALL';
let cachedTags = [];
let resizeTimeout = null;
let dropdownHeightObserver = null;
let targetDropdownHeight = null;
let dropdownWatchdogInterval = null;
let dropdownRetryTimeouts = [];
let dropdownItemObserver = null;
let isTemporarilyIncreasingHeight = false; // Flag to prevent observer from resetting height during watchdog re-filtering
let lastTagPointerUpAt = 0;

const CUSTOMER_KEY = 'gs4pm_customers';
const CURRENT_CUSTOMER_KEY = 'gs4pm_current_customer';
const ACTIVE_FILTER_KEY = 'gs4pm_active_filter_customer';
const TAGGING_ENABLED_KEY = 'gs4pm_tagging_enabled';
const TAGGING_BANNER_ID = 'gs4pm-tagging-banner';
const OVERLAY_VISIBLE_KEY = 'gs4pm_overlay_visible';
const OVERLAY_ID = 'gs4pm-workspace-bar';
const OVERLAY_STYLE_ID = 'gs4pm-workspace-bar-style';

// Hover highlight overlay (more reliable than element outline across shadow DOM / virtualization).
const HOVER_HIGHLIGHT_ID = 'gs4pm-hover-highlight';
let hoverHighlightEl = null;

function ensureHoverHighlightEl() {
  if (hoverHighlightEl && hoverHighlightEl.isConnected) return hoverHighlightEl;
  const existing = document.getElementById(HOVER_HIGHLIGHT_ID);
  if (existing) {
    hoverHighlightEl = existing;
    return hoverHighlightEl;
  }
  const el = document.createElement('div');
  el.id = HOVER_HIGHLIGHT_ID;
  el.style.position = 'fixed';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.width = '0px';
  el.style.height = '0px';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '2147483646';
  el.style.border = '2px dashed #00bcd4';
  el.style.borderRadius = '10px';
  el.style.boxShadow = '0 0 0 2px rgba(0, 188, 212, 0.18), 0 10px 22px rgba(0,0,0,0.18)';
  el.style.display = 'none';
  (document.body || document.documentElement).appendChild(el);
  hoverHighlightEl = el;
  return el;
}

function hideHoverHighlight() {
  const el = ensureHoverHighlightEl();
  el.style.display = 'none';
  el.style.width = '0px';
  el.style.height = '0px';
}

function positionHoverHighlight(target) {
  if (!(target instanceof Element)) {
    hideHoverHighlight();
    return;
  }
  const rect = target.getBoundingClientRect();
  if (!rect || rect.width < 2 || rect.height < 2) {
    hideHoverHighlight();
    return;
  }
  const el = ensureHoverHighlightEl();
  // Small padding so the border doesn't overlap the component edge.
  const pad = 2;
  el.style.left = `${Math.max(0, rect.left - pad)}px`;
  el.style.top = `${Math.max(0, rect.top - pad)}px`;
  el.style.width = `${Math.max(0, rect.width + pad * 2)}px`;
  el.style.height = `${Math.max(0, rect.height + pad * 2)}px`;
  el.style.display = 'block';
}

function shouldRenderBadges() {
  // User expectation: tags/badges are a tagging-mode affordance only.
  return !!tagging;
}

function shouldRenderBrandLibraryCardLabels() {
  // User expectation: labels are a tagging-mode affordance only.
  return !!tagging;
}

console.log('[GS4PM Filter] contentScript loaded in frame:', window.location.href);
console.log('[GS4PM Filter] Initializing on GS4PM page:', window.location.href);

let lastPathname = location.pathname;

// ===== Keyboard shortcut: Cmd/Ctrl+K cycles customers =====

const FILTER_CYCLE_TOAST_ID = 'gs4pm-filter-cycle-toast';

function isTextEntryTarget(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  // Some Spectrum components wrap inputs; don't steal Cmd/Ctrl+K from them.
  if (el.closest && el.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return true;
  return false;
}

function getToastDocument() {
  try {
    // Prefer top-frame so the toast is visible even if the keydown happens in an iframe.
    return window.top && window.top.document ? window.top.document : document;
  } catch {
    return document;
  }
}

function getTopDocumentSafe() {
  try {
    return window.top && window.top.document ? window.top.document : document;
  } catch {
    return document;
  }
}

function isWorkspaceBarVisible() {
  const doc = getTopDocumentSafe();
  const overlay = doc.getElementById(OVERLAY_ID);
  return !!(overlay && overlay.getAttribute('data-hidden') !== 'true');
}

function setWorkspaceBarVisible(visible) {
  // Persist and broadcast so the top-frame can react even if storage events are flaky across iframes.
  safeStorageSet({ [OVERLAY_VISIBLE_KEY]: !!visible });
  try { sendBroadcastFromContent({ type: 'SET_OVERLAY_VISIBLE', visible: !!visible }); } catch {}

  // Best-effort immediate DOM update (works if we're running in the same doc as the bar).
  const doc = getTopDocumentSafe();
  const overlay = doc.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.setAttribute('data-hidden', visible ? 'false' : 'true');
    if (visible) {
      try { overlay.focus(); } catch {}
    }
  }
}

function showFilterCycleToast(label) {
  const doc = getToastDocument();
  const existing = doc.getElementById(FILTER_CYCLE_TOAST_ID);
  if (existing) existing.remove();

  const el = doc.createElement('div');
  el.id = FILTER_CYCLE_TOAST_ID;
  el.textContent = label;
  el.style.position = 'fixed';
  el.style.left = '50%';
  el.style.bottom = '18px';
  el.style.transform = 'translateX(-50%)';
  el.style.zIndex = '2147483647';
  el.style.padding = '10px 12px';
  el.style.borderRadius = '999px';
  el.style.background = 'rgba(0, 0, 0, 0.78)';
  el.style.color = 'rgba(255, 255, 255, 0.92)';
  el.style.border = '1px solid rgba(255, 255, 255, 0.14)';
  el.style.boxShadow = '0 12px 28px rgba(0,0,0,0.40)';
  el.style.font = '600 12px system-ui, -apple-system, Segoe UI, sans-serif';
  el.style.letterSpacing = '0.01em';
  el.style.maxWidth = 'min(92vw, 420px)';
  el.style.whiteSpace = 'nowrap';
  el.style.overflow = 'hidden';
  el.style.textOverflow = 'ellipsis';
  el.style.opacity = '0';
  el.style.transition = 'opacity 120ms ease, transform 120ms ease';

  (doc.body || doc.documentElement).appendChild(el);

  // animate in
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(-2px)';
  });

  // animate out
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(2px)';
    setTimeout(() => el.remove(), 220);
  }, 1100);
}

function cycleActiveCustomerFilter(direction = 1) {
  if (!chrome.runtime || !chrome.runtime.id) return;

  chrome.storage.local.get([CUSTOMER_KEY, ACTIVE_FILTER_KEY], (data) => {
    const customers = Array.isArray(data[CUSTOMER_KEY]) ? data[CUSTOMER_KEY].filter(Boolean) : [];
    if (!customers.length) return;

    const current = data[ACTIVE_FILTER_KEY] || 'ALL';
    const options = ['ALL', ...customers];
    const idx = Math.max(0, options.indexOf(current));
    const nextIdx = (idx + (direction < 0 ? -1 : 1) + options.length) % options.length;
    const next = options[nextIdx];

    chrome.storage.local.set({ [ACTIVE_FILTER_KEY]: next }, () => {
      const label = next === 'ALL' ? 'Filter: All customers' : `Filter: ${next}`;
      showFilterCycleToast(label);
      // Ensure all frames apply immediately (Brands grid often lives in iframes).
      try { sendBroadcastFromContent({ type: 'SET_FILTER', customer: next }); } catch {}
    });
  });
}

document.addEventListener(
  'keydown',
  (e) => {
    if (!e) return;
    if (e.defaultPrevented) return;
    if (e.repeat) return;
    if (isTextEntryTarget(e.target)) return;

    const key = (e.key || '').toLowerCase();
    const hasMod = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (!hasMod || key !== 'k') return;

    // Cmd/Ctrl+K is commonly used by apps for command palettes; we intentionally override it on GS4PM.
    e.preventDefault();
    e.stopPropagation();

    // First priority: ensure the workspace bar (popover menu) is visible.
    // If it's already visible, Cmd/Ctrl+K cycles customers (Shift reverses direction).
    if (!isWorkspaceBarVisible()) {
      setWorkspaceBarVisible(true);
      showFilterCycleToast('Menu: shown');
      return;
    }

    // Shift reverses direction (nice for power-users).
    cycleActiveCustomerFilter(e.shiftKey ? -1 : 1);
  },
  true
);

// ===== Bottom workspace bar (persistent overlay) =====

function isTopFrame() {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function injectOverlayStyles() {
  if (!isTopFrame()) return;
  if (document.getElementById(OVERLAY_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = OVERLAY_STYLE_ID;
  style.textContent = `
    :root{
      --gs4pm-overlay-bg: linear-gradient(180deg, rgba(42, 42, 42, 0.78), rgba(20, 20, 20, 0.82));
      --gs4pm-overlay-border: rgba(255, 255, 255, 0.10);
      --gs4pm-overlay-text: rgba(255, 255, 255, 0.92);
      --gs4pm-overlay-muted: rgba(255, 255, 255, 0.64);
      --gs4pm-overlay-accent: #2ee071;
      --gs4pm-overlay-accent-soft: rgba(46, 224, 113, 0.22);
    }

    #${OVERLAY_ID}{
      position: fixed;
      left: 50%;
      bottom: 14px;
      transform: translateX(-50%);
      z-index: 2147483647;
      width: min(980px, calc(100vw - 24px));
      border-radius: 16px;
      border: 1px solid var(--gs4pm-overlay-border);
      background: var(--gs4pm-overlay-bg);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 16px 36px rgba(0,0,0,0.42);
      color: var(--gs4pm-overlay-text);
      font: 650 12px system-ui, -apple-system, Segoe UI, sans-serif;
      letter-spacing: 0.01em;
    }
    #${OVERLAY_ID} *{ box-sizing: border-box; }
    #${OVERLAY_ID}[data-hidden="true"]{ display:none; }

    #${OVERLAY_ID} .gs4pm-row{
      display:flex;
      align-items:center;
      gap:12px;
      padding:12px 14px;
    }
    #${OVERLAY_ID} .gs4pm-left,
    #${OVERLAY_ID} .gs4pm-center,
    #${OVERLAY_ID} .gs4pm-right{
      display:flex;
      align-items:center;
      gap:10px;
      min-width:0;
    }
    #${OVERLAY_ID} .gs4pm-left{
      flex:1 1 auto;
    }
    #${OVERLAY_ID} .gs4pm-center{
      flex:0 0 auto;
    }
    #${OVERLAY_ID} .gs4pm-right{
      flex:0 0 auto;
      margin-left:auto;
    }
    #${OVERLAY_ID} .gs4pm-icon{
      width:22px;
      height:22px;
      border-radius:7px;
      border:1px solid rgba(255,255,255,0.10);
      box-shadow: 0 10px 18px rgba(0,0,0,0.28);
      flex:0 0 auto;
    }
    #${OVERLAY_ID} .gs4pm-pill{
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:6px 8px;
      border-radius:12px;
      border:1px solid rgba(255,255,255,0.10);
      background: rgba(255,255,255,0.06);
      min-width:0;
      flex:0 1 auto;
    }
    #${OVERLAY_ID} .gs4pm-pill.gs4pm-stack{
      flex-direction:column;
      align-items:flex-start;
      gap:4px;
      padding:6px 10px;
    }
    #${OVERLAY_ID} .gs4pm-label{
      color: var(--gs4pm-overlay-muted);
      font-weight:700;
      font-size:10px;
      letter-spacing:0.08em;
      text-transform:uppercase;
      white-space:nowrap;
    }
    #${OVERLAY_ID} .gs4pm-btn{
      border:1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.22);
      color: var(--gs4pm-overlay-text);
      border-radius:10px;
      padding:6px 12px;
      height:32px;
      font-weight:700;
      cursor:pointer;
      transition: background 120ms ease, border-color 120ms ease, transform 60ms ease;
      white-space:nowrap;
    }
    #${OVERLAY_ID} .gs4pm-btn:hover{ background: rgba(255,255,255,0.08); }
    #${OVERLAY_ID} .gs4pm-btn:active{ transform: translateY(1px); }

    #${OVERLAY_ID} .gs4pm-input{
      border:1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.22);
      color: var(--gs4pm-overlay-text);
      border-radius:10px;
      padding:6px 10px;
      height:32px;
      font-weight:600;
      min-width:150px;
      max-width:210px;
      outline:none;
    }
    #${OVERLAY_ID} .gs4pm-input::placeholder{
      color: var(--gs4pm-overlay-muted);
    }
    #${OVERLAY_ID} .gs4pm-input:focus{
      border-color: var(--gs4pm-overlay-accent);
      box-shadow: 0 0 0 3px var(--gs4pm-overlay-accent-soft);
    }

    #${OVERLAY_ID} .gs4pm-btn-primary{
      background: linear-gradient(135deg, var(--gs4pm-overlay-accent), #68ffb0);
      border-color: rgba(255,255,255,0.10);
      color: rgba(0,0,0,0.88);
      box-shadow: 0 10px 22px rgba(46,224,113,0.22);
    }
    #${OVERLAY_ID} .gs4pm-btn-primary:hover{
      background: linear-gradient(135deg, #39ea84, #7dffbe);
    }
    #${OVERLAY_ID} .gs4pm-btn-primary[data-off="true"]{
      background: rgba(0,0,0,0.20);
      color: var(--gs4pm-overlay-text);
      box-shadow:none;
      border-color: rgba(255,255,255,0.12);
    }

    /* Custom dropdown */
    #${OVERLAY_ID} .dd{ position:relative; min-width:160px; max-width:230px; }

    #${OVERLAY_ID} .dd button{
      width:100%;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      border:1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.22);
      color: var(--gs4pm-overlay-text);
      border-radius:10px;
      padding:6px 10px;
      cursor:pointer;
      font-weight:600;
      height:32px;
    }
    #${OVERLAY_ID} .dd button:focus{
      outline:none;
      box-shadow: 0 0 0 3px var(--gs4pm-overlay-accent-soft);
      border-color: var(--gs4pm-overlay-accent);
    }
    #${OVERLAY_ID} .dd .value{
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      min-width:0;
      text-align:left;
      flex:1;
    }
    #${OVERLAY_ID} .dd .chev{ opacity:0.75; flex:0 0 auto; }
    #${OVERLAY_ID} .dd .menu{
      position:absolute;
      left:0;
      right:0;
      bottom: calc(100% + 8px);
      border-radius:14px;
      border:1px solid rgba(255,255,255,0.14);
      background: rgba(18,18,18,0.96);
      box-shadow: 0 18px 48px rgba(0,0,0,0.55);
      padding:6px;
      max-height:320px;
      overflow:auto;
      display:none;
    }
    #${OVERLAY_ID} .dd[data-open="true"] .menu{ display:block; }
    #${OVERLAY_ID} .dd .opt{
      padding:8px 10px;
      border-radius:10px;
      cursor:pointer;
      color: rgba(255,255,255,0.88);
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
    }
    #${OVERLAY_ID} .dd .opt:hover{ background: rgba(255,255,255,0.08); }
    #${OVERLAY_ID} .dd .opt[data-selected="true"]{
      background: rgba(46,224,113,0.16);
      border: 1px solid rgba(46,224,113,0.22);
    }

    #${OVERLAY_ID} .gs4pm-add-pill .gs4pm-input{
      min-width:180px;
      max-width:240px;
    }

    @media (max-width: 980px){
      #${OVERLAY_ID} .gs4pm-row{ flex-wrap:wrap; }
      #${OVERLAY_ID} .gs4pm-left,
      #${OVERLAY_ID} .gs4pm-center{
        flex:1 1 100%;
      }
      #${OVERLAY_ID} .gs4pm-right{
        margin-left:auto;
      }
    }
    @media (max-width: 640px){
      #${OVERLAY_ID} .dd{ min-width:160px; max-width:210px; }
      #${OVERLAY_ID} .gs4pm-input{ min-width:130px; max-width:170px; }
      #${OVERLAY_ID} .gs4pm-add-pill .gs4pm-input{ min-width:150px; max-width:200px; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function closeAllDropdowns(root) {
  root.querySelectorAll('.dd[data-open="true"]').forEach((dd) => dd.setAttribute('data-open', 'false'));
}

function createDropdown({ label, placeholder, options, value, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'dd';
  wrap.setAttribute('data-open', 'false');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', label);

  const valEl = document.createElement('div');
  valEl.className = 'value';
  valEl.textContent = value ? String(value) : placeholder;

  const chev = document.createElement('div');
  chev.className = 'chev';
  chev.textContent = '▴';

  btn.appendChild(valEl);
  btn.appendChild(chev);

  const menu = document.createElement('div');
  menu.className = 'menu';

  const render = () => {
    menu.innerHTML = '';
    (options || []).forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'opt';
      item.setAttribute('data-selected', opt.value === value ? 'true' : 'false');
      item.textContent = opt.label;
      item.addEventListener('click', () => {
        value = opt.value;
        valEl.textContent = opt.label;
        wrap.setAttribute('data-open', 'false');
        render();
        onChange?.(opt.value);
        // If tagging banner is present, keep it out of the way.
        try { positionTaggingBanner(); } catch {}
      });
      menu.appendChild(item);
    });
  };
  render();

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const open = wrap.getAttribute('data-open') === 'true';
    const root = wrap.closest(`#${OVERLAY_ID}`) || document;
    closeAllDropdowns(root);
    wrap.setAttribute('data-open', open ? 'false' : 'true');
    // If tagging banner is present, keep it out of the way.
    try { positionTaggingBanner(); } catch {}
  });

  wrap.appendChild(btn);
  wrap.appendChild(menu);

  return {
    el: wrap,
    setOptions(nextOptions) {
      options = nextOptions || [];
      render();
    },
    setValue(nextValue, nextLabel) {
      value = nextValue;
      valEl.textContent = nextLabel ?? (value ? String(value) : placeholder);
      render();
    },
    getValue() {
      return value;
    }
  };
}

function sendBroadcastFromContent(message) {
  if (!hasValidExtensionContext()) return;
  try {
    chrome.runtime.sendMessage({ type: 'GS4PM_BROADCAST', message }, () => {});
  } catch (e) {
    // Extension reloaded; page refresh required.
    try { showFilterCycleToast('Extension updated: refresh page'); } catch {}
  }
}

function hasValidExtensionContext() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

function safeStorageGet(keys, cb) {
  if (!hasValidExtensionContext()) {
    cb?.({});
    return;
  }
  try {
    chrome.storage.local.get(keys, (data) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        cb?.({});
        return;
      }
      cb?.(data || {});
    });
  } catch (e) {
    try { showFilterCycleToast('Extension updated: refresh page'); } catch {}
    cb?.({});
  }
}

function safeStorageSet(obj, cb) {
  if (!hasValidExtensionContext()) {
    cb?.();
    return;
  }
  try {
    chrome.storage.local.set(obj, () => cb?.());
  } catch (e) {
    try { showFilterCycleToast('Extension updated: refresh page'); } catch {}
    cb?.();
  }
}

function ensureWorkspaceBar() {
  if (!isTopFrame()) return;
  injectOverlayStyles();
  if (document.getElementById(OVERLAY_ID)) return;

  const bar = document.createElement('div');
  bar.id = OVERLAY_ID;
  bar.setAttribute('data-hidden', 'true');
  bar.setAttribute('tabindex', '0');

  const row = document.createElement('div');
  row.className = 'gs4pm-row';

  const left = document.createElement('div');
  left.className = 'gs4pm-left';

  const center = document.createElement('div');
  center.className = 'gs4pm-center';

  const icon = document.createElement('img');
  icon.className = 'gs4pm-icon';
  try {
    icon.src = chrome.runtime.getURL('icons/logo.png');
  } catch {
    // ignore
  }
  icon.alt = '';
  icon.decoding = 'async';

  const filterPill = document.createElement('div');
  filterPill.className = 'gs4pm-pill gs4pm-stack';
  const filterLabel = document.createElement('div');
  filterLabel.className = 'gs4pm-label';
  filterLabel.textContent = 'Filter';

  const filterDd = createDropdown({
    label: 'Filter customer',
    placeholder: 'All customers',
    options: [{ value: 'ALL', label: 'All customers' }],
    value: 'ALL',
    onChange: (val) => {
      const normalized = !val || val === 'ALL' ? 'ALL' : val;
      safeStorageSet({ [ACTIVE_FILTER_KEY]: normalized });
      // Apply across all frames immediately (storage events can be flaky in nested iframes).
      try { sendBroadcastFromContent({ type: 'SET_FILTER', customer: normalized }); } catch {}
    }
  });

  filterPill.appendChild(filterLabel);
  filterPill.appendChild(filterDd.el);

  const tagPill = document.createElement('div');
  tagPill.className = 'gs4pm-pill gs4pm-stack';
  const tagLabel = document.createElement('div');
  tagLabel.className = 'gs4pm-label';
  tagLabel.textContent = 'Tag';

  const tagDd = createDropdown({
    label: 'Tag customer',
    placeholder: 'Select customer…',
    options: [],
    value: null,
    onChange: (val) => {
      if (!val) {
        safeStorageSet({ [CURRENT_CUSTOMER_KEY]: '__ALL__' });
        return;
      }
      safeStorageSet({ [CURRENT_CUSTOMER_KEY]: val });
      safeStorageGet([TAGGING_ENABLED_KEY], (data) => {
        if (!data[TAGGING_ENABLED_KEY]) return;
        sendBroadcastFromContent({ type: 'STOP_TAGGING' });
        sendBroadcastFromContent({ type: 'START_TAGGING', customer: val });
      });
    }
  });

  tagPill.appendChild(tagLabel);
  tagPill.appendChild(tagDd.el);

  const addPill = document.createElement('div');
  addPill.className = 'gs4pm-pill gs4pm-add-pill';
  const addLabel = document.createElement('div');
  addLabel.className = 'gs4pm-label';
  addLabel.textContent = 'Add';

  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'gs4pm-input';
  addInput.placeholder = 'New customer';
  addInput.setAttribute('aria-label', 'New customer name');

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'gs4pm-btn';
  addBtn.textContent = 'Add';

  const addCustomerFromBar = () => {
    const name = addInput.value.trim();
    if (!name) return;
    safeStorageGet([CUSTOMER_KEY], (data) => {
      const existing = Array.isArray(data[CUSTOMER_KEY]) ? data[CUSTOMER_KEY].filter(Boolean) : [];
      const updated = existing.includes(name) ? existing : [...existing, name];
      safeStorageSet(
        {
          [CUSTOMER_KEY]: updated,
          [CURRENT_CUSTOMER_KEY]: name,
          [ACTIVE_FILTER_KEY]: name
        },
        () => {
          addInput.value = '';
        }
      );
    });
  };

  addBtn.addEventListener('click', addCustomerFromBar);
  addInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addCustomerFromBar();
  });

  addPill.appendChild(addLabel);
  addPill.appendChild(addInput);
  addPill.appendChild(addBtn);

  const toggleTagBtn = document.createElement('button');
  toggleTagBtn.type = 'button';
  toggleTagBtn.className = 'gs4pm-btn gs4pm-btn-primary';
  toggleTagBtn.setAttribute('data-off', 'true');
  toggleTagBtn.textContent = 'Enable tagging';

  const updateToggleBtn = (enabled) => {
    toggleTagBtn.setAttribute('data-off', enabled ? 'false' : 'true');
    toggleTagBtn.textContent = enabled ? 'Disable tagging' : 'Enable tagging';
  };

  const toggleTaggingFromBar = () => {
    safeStorageGet([TAGGING_ENABLED_KEY], (data) => {
      const enabled = !!data[TAGGING_ENABLED_KEY];
      if (enabled) {
        safeStorageSet({ [TAGGING_ENABLED_KEY]: false }, () => {
          updateToggleBtn(false);
          sendBroadcastFromContent({ type: 'STOP_TAGGING' });
        });
        return;
      }

      const selected = tagDd.getValue();
      if (!selected || selected === '__NONE__' || selected === 'ALL') return;

      safeStorageSet(
        { [TAGGING_ENABLED_KEY]: true, [CURRENT_CUSTOMER_KEY]: selected },
        () => {
          updateToggleBtn(true);
          sendBroadcastFromContent({ type: 'START_TAGGING', customer: selected });
        }
      );
    });
  };

  toggleTagBtn.addEventListener('click', toggleTaggingFromBar);

  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.className = 'gs4pm-btn';
  hideBtn.textContent = 'Hide';
  hideBtn.addEventListener('click', () => safeStorageSet({ [OVERLAY_VISIBLE_KEY]: false }));

  const right = document.createElement('div');
  right.className = 'gs4pm-right';
  right.appendChild(toggleTagBtn);
  right.appendChild(hideBtn);

  left.appendChild(icon);
  left.appendChild(filterPill);
  left.appendChild(tagPill);
  center.appendChild(addPill);

  row.appendChild(left);
  row.appendChild(center);
  row.appendChild(right);
  bar.appendChild(row);

  bar.addEventListener('pointerdown', () => {
    if (document.activeElement !== bar) bar.focus();
  });

  bar.addEventListener('keydown', (e) => {
    if (e.key !== ' ') return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    toggleTaggingFromBar();
  });

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!bar.isConnected) return;
      const t = e.target instanceof Node ? e.target : null;
      if (t && bar.contains(t)) return;
      closeAllDropdowns(bar);
    },
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      closeAllDropdowns(bar);
    },
    true
  );

  (document.body || document.documentElement).appendChild(bar);

  const sync = () => {
    safeStorageGet(
      [CUSTOMER_KEY, ACTIVE_FILTER_KEY, CURRENT_CUSTOMER_KEY, TAGGING_ENABLED_KEY, OVERLAY_VISIBLE_KEY],
      (data) => {
        const customers = Array.isArray(data[CUSTOMER_KEY]) ? data[CUSTOMER_KEY].filter(Boolean) : [];

        const filterOptions = [{ value: 'ALL', label: 'All customers' }, ...customers.map((c) => ({ value: c, label: c }))];
        filterDd.setOptions(filterOptions);

        const active = data[ACTIVE_FILTER_KEY] && (data[ACTIVE_FILTER_KEY] === 'ALL' || customers.includes(data[ACTIVE_FILTER_KEY]))
          ? data[ACTIVE_FILTER_KEY]
          : 'ALL';
        filterDd.setValue(active, active === 'ALL' ? 'All customers' : active);

        const tagOptions = customers.map((c) => ({ value: c, label: c }));
        tagDd.setOptions(tagOptions);

        const current = data[CURRENT_CUSTOMER_KEY];
        if (current && current !== '__ALL__' && customers.includes(current)) {
          tagDd.setValue(current, current);
        } else if (active !== 'ALL') {
          tagDd.setValue(active, active);
        } else {
          tagDd.setValue(null, 'Select customer…');
        }

        updateToggleBtn(!!data[TAGGING_ENABLED_KEY]);

        const visible = !!data[OVERLAY_VISIBLE_KEY];
        bar.setAttribute('data-hidden', visible ? 'false' : 'true');

        // If the Esc banner exists, re-position it so it doesn't overlap the bar/menu.
        if (document.getElementById(TAGGING_BANNER_ID)) {
          positionTaggingBanner();
        }
      }
    );
  };

  sync();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (
        changes[CUSTOMER_KEY] ||
        changes[ACTIVE_FILTER_KEY] ||
        changes[CURRENT_CUSTOMER_KEY] ||
        changes[TAGGING_ENABLED_KEY] ||
        changes[OVERLAY_VISIBLE_KEY]
      ) {
        sync();
      }
    });
  } catch (e) {
    // ignore (extension context invalidated)
  }
}

// Create the workspace bar in the top frame.
// Visibility is controlled via `OVERLAY_VISIBLE_KEY`.
setTimeout(() => {
  try {
    ensureWorkspaceBar();
  } catch (e) {
    // Keep failures silent; overlay is an optional enhancement.
  }
}, 0);

// Brand library card badges run in whatever frame owns the grid.
setTimeout(() => {
  try {
    initBrandLibraryCardLabels();
  } catch (e) {
    // optional enhancement
  }
}, 0);

function getPageKey() {
  // Use a host-wide key so tags apply across GS4PM sections (personas, products, dropdowns, etc.)
  return `gs4pm_tags::${location.host}`;
}

function isContentAssetsPage() {
  // Works for both hash-based and direct routes
  return window.location.href.includes('/content/assets');
}

function isTemplatesPage() {
  // Avoid relying only on URL; templates are identifiable via contenttype on cards.
  return (
    window.location.href.includes('/templates') ||
    document.querySelector('[data-omega-attribute-contenttype="templates"]') !== null
  );
}

// ===== Content/assets CSS filtering (no flicker on scroll) =====

const ASSETS_FILTER_STYLE_ID = 'gs4pm-assets-filter-style';
const BRAND_FILTER_STYLE_ID = 'gs4pm-brand-filter-style';
const brandRemovedNodes = new Map(); // key -> { node, parent, nextSibling }

function deepQuerySelector(selector, root = document) {
  // Searches through document + any *open* shadow roots.
  // (Does not pierce closed shadow roots.)
  const tryQuery = (node) => {
    if (!node || typeof node.querySelector !== 'function') return null;
    try {
      return node.querySelector(selector);
    } catch (e) {
      return null;
    }
  };

  const first = tryQuery(root);
  if (first) return first;

  const visited = new Set();
  const stack = [];

  const enqueueShadowRoots = (node) => {
    if (!node || typeof node.querySelectorAll !== 'function') return;
    let all;
    try {
      all = node.querySelectorAll('*');
    } catch (e) {
      return;
    }
    all.forEach((el) => {
      const sr = el && el.shadowRoot;
      if (sr && !visited.has(sr)) {
        visited.add(sr);
        stack.push(sr);
      }
    });
  };

  enqueueShadowRoots(root);

  while (stack.length) {
    const sr = stack.pop();
    const found = tryQuery(sr);
    if (found) return found;
    enqueueShadowRoots(sr);
  }

  return null;
}

function cssEscapeAttrValue(value) {
  // Safe for double-quoted CSS attribute selectors
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function extractAttrFromSelector(selector, attrName) {
  if (!selector) return null;
  // e.g. [data-item-id="urn:..."]
  const re = new RegExp(`\\[\\s*${attrName}\\s*=\\s*["']([^"']+)["']\\s*\\]`);
  const match = selector.match(re);
  return match ? match[1] : null;
}

function inferListboxTotalOptionCount(listboxEl) {
  if (!(listboxEl instanceof Element)) return null;

  // Prefer container-level hints when present.
  const fromListboxSetSize = parseInt(listboxEl.getAttribute('aria-setsize') || '', 10);
  if (Number.isFinite(fromListboxSetSize) && fromListboxSetSize > 0) return fromListboxSetSize;

  const fromRowCount = parseInt(listboxEl.getAttribute('aria-rowcount') || '', 10);
  if (Number.isFinite(fromRowCount) && fromRowCount > 0) return fromRowCount;

  // Fall back to option-level hints.
  const options = Array.from(listboxEl.querySelectorAll('[role="option"]'));
  let maxSetSize = null;
  for (const opt of options) {
    const v = parseInt(opt.getAttribute('aria-setsize') || '', 10);
    if (Number.isFinite(v) && v > 0) {
      maxSetSize = Math.max(maxSetSize || 0, v);
    }
  }
  return maxSetSize;
}

function updateAssetsCssFilter(activeCustomer, tags) {
  if (!isContentAssetsPage()) return;

  let styleEl = document.getElementById(ASSETS_FILTER_STYLE_ID);

  // Remove style when showing ALL
  if (!activeCustomer || activeCustomer === 'ALL') {
    if (styleEl) styleEl.remove();
    return;
  }

  const itemIds = new Set();
  const contentIds = new Set();

  (tags || []).forEach(tag => {
    if (!tag || tag.customer !== activeCustomer) return;

    const itemId = extractAttrFromSelector(tag.selector, 'data-item-id');
    const contentId = extractAttrFromSelector(tag.selector, 'data-omega-attribute-contentid');
    if (itemId) itemIds.add(itemId);
    if (contentId) contentIds.add(contentId);

    // Fallback: if selector matches an element currently in DOM, harvest ids
    if (!itemId && !contentId) {
      try {
        const el = document.querySelector(tag.selector);
        if (el instanceof Element) {
          const container = getDisplayContainer(el) || el;
          const harvestedItemId = container.getAttribute('data-item-id');
          const harvestedContentId = container.getAttribute('data-omega-attribute-contentid');
          if (harvestedItemId) itemIds.add(harvestedItemId);
          if (harvestedContentId) contentIds.add(harvestedContentId);
        }
      } catch (e) {
        // ignore invalid selectors
      }
    }
  });

  const showSelectors = [];
  itemIds.forEach(id => showSelectors.push(`[data-item-id="${cssEscapeAttrValue(id)}"]`));
  contentIds.forEach(id => showSelectors.push(`[data-omega-attribute-contentid="${cssEscapeAttrValue(id)}"]`));

  const css =
    // Hide ALL tiles by default when a customer filter is active
    `[data-item-id],[data-omega-attribute-contentid]{display:none !important;}` +
    // Then show only the ones tagged to the active customer
    (showSelectors.length ? `${showSelectors.join(',')}{display:revert !important;}` : '');

  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = ASSETS_FILTER_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

// ===== Templates CSS filtering (no flicker on scroll) =====

const TEMPLATES_FILTER_STYLE_ID = 'gs4pm-templates-filter-style';

function updateTemplatesCssFilter(activeCustomer, tags) {
  if (!isTemplatesPage()) return;

  let styleEl = document.getElementById(TEMPLATES_FILTER_STYLE_ID);

  if (!activeCustomer || activeCustomer === 'ALL') {
    if (styleEl) styleEl.remove();
    return;
  }

  const itemIds = new Set();
  const contentIds = new Set();

  (tags || []).forEach(tag => {
    if (!tag || tag.customer !== activeCustomer) return;

    const itemId = extractAttrFromSelector(tag.selector, 'data-item-id');
    const contentId = extractAttrFromSelector(tag.selector, 'data-omega-attribute-contentid');
    if (itemId) itemIds.add(itemId);
    if (contentId) contentIds.add(contentId);

    if (!itemId && !contentId) {
      try {
        const el = document.querySelector(tag.selector);
        if (el instanceof Element) {
          const container = getDisplayContainer(el) || el;
          const harvestedItemId = container.getAttribute('data-item-id');
          const harvestedContentId = container.getAttribute('data-omega-attribute-contentid');
          if (harvestedItemId) itemIds.add(harvestedItemId);
          if (harvestedContentId) contentIds.add(harvestedContentId);
        }
      } catch (e) {
        // ignore invalid selectors
      }
    }
  });

  const showItemSelectors = [];
  const showContentSelectors = [];
  itemIds.forEach(id => showItemSelectors.push(`[data-item-id="${cssEscapeAttrValue(id)}"]`));
  contentIds.forEach(id => showContentSelectors.push(`[data-omega-attribute-contentid="${cssEscapeAttrValue(id)}"]`));

  // Templates use a virtualized wrapper `div[role="presentation"].item` with absolute positioning.
  // Use :has() so we hide/show the wrapper itself (prevents scroll reusing DOM nodes from flashing).
  const hideWrapper =
    `div[role="presentation"].item:has([data-omega-attribute-contenttype="templates"][data-item-id]),` +
    `div[role="presentation"].item:has([data-omega-attribute-contenttype="templates"][data-omega-attribute-contentid])` +
    `{display:none !important;}`;

  const showWrapper = (() => {
    const parts = [];
    showItemSelectors.forEach(sel => {
      parts.push(`div[role="presentation"].item:has([data-omega-attribute-contenttype="templates"]${sel})`);
    });
    showContentSelectors.forEach(sel => {
      parts.push(`div[role="presentation"].item:has([data-omega-attribute-contenttype="templates"]${sel})`);
    });
    return parts.length ? `${parts.join(',')}{display:revert !important;}` : '';
  })();

  // Fallback: if wrapper class changes, still hide the card itself.
  const hideTiles = `[data-omega-attribute-contenttype="templates"][data-item-id],[data-omega-attribute-contenttype="templates"][data-omega-attribute-contentid]{display:none !important;}`;
  const showTiles = (() => {
    const parts = [];
    itemIds.forEach(id =>
      parts.push(`[data-omega-attribute-contenttype="templates"][data-item-id="${cssEscapeAttrValue(id)}"]`)
    );
    contentIds.forEach(id =>
      parts.push(
        `[data-omega-attribute-contenttype="templates"][data-omega-attribute-contentid="${cssEscapeAttrValue(id)}"]`
      )
    );
    return parts.length ? `${parts.join(',')}{display:revert !important;}` : '';
  })();

  const css = hideWrapper + showWrapper + hideTiles + showTiles;

  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = TEMPLATES_FILTER_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

function isBrandLibraryPage() {
  // Brands "library grid" view uses a stable root id + test id.
  return getBrandLibraryGrid() !== null;
}

function updateBrandLibraryCssFilter(activeCustomer, tags) {
  if (!isBrandLibraryPage()) return;

  let styleEl = document.getElementById(BRAND_FILTER_STYLE_ID);
  const debug = Boolean(window.__GS4PM_DEBUG_BRAND_FILTER);

  const restoreRemovedBrandNodes = () => {
    if (!brandRemovedNodes.size) return;
    brandRemovedNodes.forEach((entry) => {
      const { node, parent, nextSibling } = entry || {};
      if (!node || !parent || !parent.isConnected) return;
      try {
        if (nextSibling && nextSibling.parentNode === parent) parent.insertBefore(node, nextSibling);
        else parent.appendChild(node);
      } catch (e) {
        // ignore reinsertion failures
      }
    });
    brandRemovedNodes.clear();
  };

  // Remove style when showing ALL
  if (!activeCustomer || activeCustomer === 'ALL') {
    if (styleEl) styleEl.remove();
    // Restore any removed brand cards.
    restoreRemovedBrandNodes();
    // Also clear any inline hides.
    const grid = getBrandLibraryGrid();
    if (grid) {
      const containers = Array.from(grid.querySelectorAll('div.library-list-item-container[data-key]'));
      containers.forEach(c => {
        if (!(c instanceof Element)) return;
        c.style.removeProperty('display');
      });
      // Restore original virtualized positions (prevents gaps after filtering).
      try { restoreVirtualizedGrid(containers); } catch (e) {}
    }
    return;
  }

  // Brands filtering semantics: when a customer is selected, SHOW ONLY brands tagged to that customer.
  // (This makes filtering obvious and avoids "no visible change" when most brands are untagged.)
  const showKeys = new Set();

  (tags || []).forEach(tag => {
    if (!tag?.selector || !tag.customer) return;
    if (tag.customer !== activeCustomer) return;
    let key = extractAttrFromSelector(tag.selector, 'data-key');
    if (key) {
      showKeys.add(key);
      return;
    }
    // Fallback: resolve selector in DOM and read closest brand container key.
    try {
      const matches = Array.from(document.querySelectorAll(tag.selector));
      matches.forEach(el => {
        if (!(el instanceof Element)) return;
        const container = el.closest('div.library-list-item-container[data-key]');
        const resolvedKey = container?.getAttribute('data-key');
        if (resolvedKey) showKeys.add(resolvedKey);
      });
    } catch (e) {
      // ignore invalid selectors
    }
  });

  // IMPORTANT:
  // Brand library mosaic is virtualized + absolutely positioned. Hiding/removing nodes can leave
  // layout gaps (cards keep old left/top). Instead, we reflow visible cards to the top-left using
  // `reorderVirtualizedGrid` and push hidden cards off-screen.
  if (styleEl) {
    // Remove any legacy CSS hide/show rules that can interfere with measuring positions.
    styleEl.remove();
    styleEl = null;
  }

  // If we previously removed nodes with older logic, restore them so we can reposition.
  const grid = getBrandLibraryGrid();
  if (grid) {
    if (debug) {
      console.log(
        '[GS4PM Filter][Brand] applying',
        activeCustomer,
        'tags:',
        Array.isArray(tags) ? tags.length : 0,
        'current removed:',
        brandRemovedNodes.size
      );
    }
    // Restore any previously removed nodes so we can re-evaluate for the new active customer.
    restoreRemovedBrandNodes();

    const containers = Array.from(
      grid.querySelectorAll('div.library-list-item-container[data-key]')
    );

    const visible = [];
    const hidden = [];
    containers.forEach((container) => {
      if (!(container instanceof Element)) return;
      // Clear any legacy inline display hides so we can measure/reposition.
      try { container.style.removeProperty('display'); } catch (e) {}

      const key = container.getAttribute('data-key');
      if (key && showKeys.has(key)) visible.push(container);
      else hidden.push(container);
    });

    if (visible.length === 0) {
      // Hide all (no matches) without leaving gaps.
      const parent = containers[0]?.parentElement || null;
      hidden.forEach((container) => {
        if (!(container instanceof Element)) return;
        if (!container.dataset.gs4pmOrigLeft) {
          container.dataset.gs4pmOrigLeft = container.style.left;
          container.dataset.gs4pmOrigTop = container.style.top;
        }
        container.style.left = '-9999px';
        container.style.top = '-9999px';
        container.dataset.gs4pmHidden = 'true';
      });
      if (parent) {
        if (!parent.dataset.gs4pmOrigHeight) parent.dataset.gs4pmOrigHeight = parent.style.height;
        parent.style.height = '0px';
      }
      if (debug) console.log('[GS4PM Filter][Brand] no matches; hid all brand tiles');
    } else {
      try { reorderVirtualizedGrid(visible, hidden); } catch (e) {}
    }

    if (debug) {
      console.log(
        '[GS4PM Filter][Brand] grid containers:',
        containers.length,
        'showKeys:',
        showKeys.size,
        'visible:',
        visible.length,
        'hidden:',
        hidden.length
      );
    }
  }
}

// ===== Selector helpers =====

function getUniqueSelector(el) {
  // Content/assets + templates: prefer stable container ids if present on an ancestor.
  const contentAncestor = el.closest && el.closest('[data-omega-attribute-contentid],[data-item-id]');
  if (contentAncestor) {
    const contentId = contentAncestor.getAttribute('data-omega-attribute-contentid');
    if (contentId) {
      return `[data-omega-attribute-contentid="${cssEscapeAttrValue(contentId)}"]`;
    }
    const itemId = contentAncestor.getAttribute('data-item-id');
    if (itemId) {
      return `[data-item-id="${cssEscapeAttrValue(itemId)}"]`;
    }
  }

  // Prefer a stable data-key used across grids and dropdown options
  const keyAncestor = el.closest && el.closest('[data-key]');
  if (keyAncestor) {
    const key = keyAncestor.getAttribute('data-key');
    if (key) {
      return `[data-key="${key}"]`;
    }
  }

  const personaAncestor = el.closest && el.closest('article[data-omega-attribute-referenceid]');
  if (personaAncestor) {
    const refId = personaAncestor.getAttribute('data-omega-attribute-referenceid');
    if (refId) {
      // Link cards and dropdown options by shared reference id
      return `[data-omega-attribute-referenceid="${refId}"], [data-key="${refId}"]`;
    }
  }

  if (el.dataset) {
    if (el.dataset.omegaAttributeReferenceid) {
      const refId = el.dataset.omegaAttributeReferenceid;
      return `[data-omega-attribute-referenceid="${refId}"], [data-key="${refId}"]`;
    }
    if (el.dataset.testId) {
      return `[data-test-id="${el.dataset.testId}"]`;
    }
    if (el.dataset.testid) {
      return `[data-testid="${el.dataset.testid}"]`;
    }
    if (el.dataset.itemId) {
      return `[data-item-id="${el.dataset.itemId}"]`;
    }
    if (el.dataset.omegaAttributeContentid) {
      return `[data-omega-attribute-contentid="${el.dataset.omegaAttributeContentid}"]`;
    }
    if (el.dataset.key) {
      return `[data-key="${el.dataset.key}"]`;
    }
  }

  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }

  const parts = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
    let selector = current.nodeName.toLowerCase();

    if (current.classList && current.classList.length > 0) {
      selector += [...current.classList].map(c => `.${CSS.escape(c)}`).join('');
    }

    const parent = current.parentNode;
    if (parent) {
      const sameTypeSiblings = Array.from(parent.children)
        .filter(child => child.nodeName === current.nodeName);
      if (sameTypeSiblings.length > 1) {
        const index = sameTypeSiblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(selector);
    current = parent;
  }

  return parts.join(' > ');
}

function findTaggableElement(eventOrNode) {
  const path = eventOrNode.composedPath
    ? eventOrNode.composedPath()
    : [eventOrNode.target || eventOrNode];

  const hasCards = Boolean(
    document.querySelector('article[data-omega-attribute-referenceid], article[data-testid^="card-"]')
  );

  const taggableSelectors = [
    'article[data-omega-attribute-referenceid]',
    'article[data-testid^="card-"]',
  ];

  // GenStudio routes can be hash-based; don't rely only on `location.pathname`.
  if (isContentAssetsPage() || window.location.href.includes('/genstudio/content')) {
    taggableSelectors.push('div[data-omega-element="explore-card"]');
  }

  // Content/assets and templates tiles commonly expose stable ids on containers.
  taggableSelectors.push('[data-item-id]', '[data-omega-attribute-contentid]');

  if (!hasCards) {
    taggableSelectors.push('[role="option"]', 'div[data-test-id^="library-drop-target"]');
  }

  const taggableSelector = taggableSelectors.join(', ');

  const candidates = Array.from(path);

  // If this came from a mouse event, also try the actual point hit.
  if (typeof eventOrNode.clientX === 'number' && typeof eventOrNode.clientY === 'number') {
    const pointEls = document.elementsFromPoint
      ? document.elementsFromPoint(eventOrNode.clientX, eventOrNode.clientY)
      : [];
    for (const el of pointEls) candidates.push(el);
  }

  for (const node of candidates) {
    if (!(node instanceof Element)) continue;

    if (node.matches && node.matches(taggableSelector)) {
      return node;
    }
    const ancestor = node.closest && node.closest(taggableSelector);
    if (ancestor) return ancestor;
  }

  return null;
}

function loadTags(cb) {
  const key = getPageKey();
  // Check if extension context is valid before trying to use chrome APIs
  if (!chrome.runtime || !chrome.runtime.id) {
    // Extension was reloaded - this is expected, just silently return empty tags
    // User will see the extension work again after they reload the page
    console.log('[GS4PM Filter] Extension updated - please reload page for full functionality');
    cachedTags = [];
    cb(cachedTags);
    return;
  }
  
  // Use local storage for unlimited quota (not synced across devices)
  try {
    chrome.storage.local.get([key], data => {
      if (chrome.runtime.lastError) {
        console.warn('[GS4PM Filter] Storage access issue:', chrome.runtime.lastError.message);
        cachedTags = [];
        cb(cachedTags);
        return;
      }
      cachedTags = data[key] || [];
      cb(cachedTags);
    });
  } catch (error) {
    console.warn('[GS4PM Filter] Could not load tags:', error.message);
    cachedTags = [];
    cb(cachedTags);
  }
}

// ===== Layout container resolution =====

function getDisplayContainer(el) {
  if (!(el instanceof Element)) return null;

  const contentAncestor = el.closest && el.closest('[data-item-id], [data-omega-attribute-contentid]');
  if (contentAncestor) return contentAncestor;

  // Dropdown / menu items: just return the option itself (don't traverse to presentation wrapper)
  // This prevents us from affecting the dropdown container's positioning
  // For dropdown options: return the absolutely positioned parent wrapper
  // Dropdown structure: <div role="presentation" style="position: absolute">
  //                       <div role="option">...</div>
  //                     </div>
  if (el.getAttribute('role') === 'option') {
    const wrapper = el.parentElement;
    if (wrapper && wrapper.getAttribute('role') === 'presentation') {
      return wrapper;
    }
    return el;
  }
  
  const option = el.closest('[role="option"]');
  if (option) {
    const wrapper = option.parentElement;
    if (wrapper && wrapper.getAttribute('role') === 'presentation') {
      return wrapper;
    }
    return option;
  }

  // For virtualized grids: find absolutely positioned wrapper containing the card
  let node = el;
  while (node && node !== document.body) {
    if (node instanceof Element) {
      const style = window.getComputedStyle(node);
      // If we find an absolutely positioned ancestor that contains an article, that's our wrapper
      if (style.position === 'absolute' && node.querySelector('article')) {
        return node;
      }
    }
    node = node.parentElement;
  }

  // Prefer the outer gridcell so hiding it collapses layout gaps
  let container = el.closest('div[role="gridcell"]');
  if (container) return container;

  container = el.closest('.react-spectrum-GridView-item');
  if (container) return container;

  container = el.closest('div.item');
  if (container) return container;

  container = el.closest('div.library-list-item-container');
  if (container) return container;

  return el;
}

// ===== Badge helpers =====

const BADGE_ATTR = 'data-gs4pm-badge';
const BADGE_HOST_CLASS = 'gs4pm-badge-host';
const BADGE_STYLE_ID = 'gs4pm-badge-style';

function ensureBadgeStyles() {
  if (document.getElementById(BADGE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = BADGE_STYLE_ID;
  style.textContent = `
    /* High-specificity, !important to survive Spectrum/React styling */
    div.library-list-item-container.${BADGE_HOST_CLASS}[${BADGE_ATTR}]::after{
      content: attr(${BADGE_ATTR}) !important;
      display: inline-block !important;
      position: absolute !important;
      top: 6px !important;
      right: 6px !important;
      z-index: 2147483646 !important;
      background: rgba(0, 0, 0, 0.78) !important;
      color: #fff !important;
      padding: 3px 6px !important;
      border-radius: 999px !important;
      font-size: 11px !important;
      line-height: 1.2 !important;
      font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
      font-weight: 650 !important;
      letter-spacing: 0.01em !important;
      pointer-events: none !important;
      max-width: 76% !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      box-shadow: 0 8px 18px rgba(0,0,0,0.25) !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function shouldUseAttributeBadge(container) {
  // Brand library tiles are often React-managed; injected children can be removed.
  // Using an attribute + ::after is far more stable.
  return container instanceof Element && container.matches('div.library-list-item-container');
}

function removeAllBadges(restorePosition = false) {
  // Remove DOM badges
  Array.from(document.querySelectorAll('.gs4pm-tag-badge')).forEach(badge => {
    const parent = badge.parentElement;
    badge.remove();
    if (restorePosition && parent && parent.dataset && parent.dataset.gs4pmOriginalPosition === 'static') {
      parent.style.position = '';
      delete parent.dataset.gs4pmOriginalPosition;
    }
  });

  // Remove attribute-based badges (brands)
  Array.from(document.querySelectorAll(`.${BADGE_HOST_CLASS}[${BADGE_ATTR}]`)).forEach(host => {
    if (!(host instanceof Element)) return;
    host.removeAttribute(BADGE_ATTR);
    host.classList.remove(BADGE_HOST_CLASS);
    if (restorePosition && host.dataset && host.dataset.gs4pmOriginalPosition === 'static') {
      host.style.position = '';
      delete host.dataset.gs4pmOriginalPosition;
    }
  });
}

function ensureBadgeContainer(container) {
  // Brand library: use attribute badge to avoid React removing injected children.
  if (shouldUseAttributeBadge(container)) {
    ensureBadgeStyles();
    const style = window.getComputedStyle(container);
    if (style.position === 'static') {
      container.dataset.gs4pmOriginalPosition = 'static';
      container.style.position = 'relative';
    }
    container.classList.add(BADGE_HOST_CLASS);
    return null;
  }

  let badge = container.querySelector(':scope > .gs4pm-tag-badge');
  if (!badge) {
    const style = window.getComputedStyle(container);
    if (style.position === 'static') {
      container.dataset.gs4pmOriginalPosition = 'static';
      container.style.position = 'relative';
    }
    badge = document.createElement('div');
    badge.className = 'gs4pm-tag-badge';
    badge.style.position = 'absolute';
    badge.style.top = '4px';
    badge.style.right = '4px';
    badge.style.zIndex = '9999';
    badge.style.background = 'rgba(0, 0, 0, 0.75)';
    badge.style.color = '#fff';
    badge.style.padding = '2px 4px';
    badge.style.borderRadius = '10px';
    badge.style.fontSize = '10px';
    badge.style.fontFamily = 'system-ui, sans-serif';
    badge.style.pointerEvents = 'none';
    badge.style.maxWidth = '70%';
    badge.style.overflow = 'hidden';
    badge.style.textOverflow = 'ellipsis';
    badge.style.whiteSpace = 'nowrap';
    container.appendChild(badge);
  }
  return badge;
}

function addBadge(container, customer) {
  if (!shouldRenderBadges()) return;
  const badge = ensureBadgeContainer(container);
  if (!badge && shouldUseAttributeBadge(container)) {
    const existing = container.getAttribute(BADGE_ATTR) || '';
    const names = existing ? existing.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (!names.includes(customer)) names.push(customer);
    container.setAttribute(BADGE_ATTR, names.join(', '));
    return;
  }
  if (!badge) return;
  let names = badge.dataset.customers ? badge.dataset.customers.split('|') : [];
  if (!names.includes(customer)) {
    names.push(customer);
    badge.dataset.customers = names.join('|');
  }
  badge.textContent = names.join(', ');
}

function refreshBadges() {
  if (!shouldRenderBadges()) return;
  if (!cachedTags.length) {
    removeAllBadges(false);
    return;
  }

  // Build a map of container -> customers, then update in-place.
  // This avoids the visual flicker of removing/re-adding badges during scroll virtualization.
  const byContainer = new Map();

  cachedTags.forEach(tag => {
    if (!tag?.selector || !tag.customer) return;
    try {
      Array.from(document.querySelectorAll(tag.selector)).forEach(el => {
        const container = getDisplayContainer(el) || el;
        if (!container) return;
        let set = byContainer.get(container);
        if (!set) {
          set = new Set();
          byContainer.set(container, set);
        }
        set.add(tag.customer);
      });
    } catch (e) {
      // ignore invalid selectors
    }
  });

  // Remove badges for containers that are no longer present in the computed map.
  Array.from(document.querySelectorAll('.gs4pm-tag-badge')).forEach(badge => {
    const parent = badge.parentElement;
    if (!parent || byContainer.has(parent)) return;
    badge.remove();
    if (parent.dataset && parent.dataset.gs4pmOriginalPosition === 'static') {
      parent.style.position = '';
      delete parent.dataset.gs4pmOriginalPosition;
    }
  });

  // Remove attribute-based badges that are no longer present in computed map.
  Array.from(document.querySelectorAll(`.${BADGE_HOST_CLASS}[${BADGE_ATTR}]`)).forEach(host => {
    if (!(host instanceof Element)) return;
    if (byContainer.has(host)) return;
    host.removeAttribute(BADGE_ATTR);
    host.classList.remove(BADGE_HOST_CLASS);
    if (host.dataset && host.dataset.gs4pmOriginalPosition === 'static') {
      host.style.position = '';
      delete host.dataset.gs4pmOriginalPosition;
    }
  });

  // Update/create badges for all current containers.
  byContainer.forEach((customerSet, container) => {
    const names = Array.from(customerSet);
    const badge = ensureBadgeContainer(container);
    if (!badge && shouldUseAttributeBadge(container)) {
      container.setAttribute(BADGE_ATTR, names.join(', '));
      return;
    }
    if (!badge) return;
    badge.dataset.customers = names.join('|');
    badge.textContent = names.join(', ');
  });
}

// ===== Grid Reordering: For virtualized grids with absolute positioning =====

function reorderVirtualizedGrid(visibleContainers, hiddenContainers) {
  if (visibleContainers.length === 0) return;
  
  // SAFETY: Filter out any dropdown elements that somehow got through
  const safeVisible = visibleContainers.filter(c => {
    // Brand library cards don't use <article>; they use Spectrum Web Components (<sp-card...>).
    return (c.querySelector('article') !== null || c.querySelector('[data-test-id^="library-grid-mosaic-card-"]') !== null) && 
           c.closest('[role="listbox"]') === null &&
           !c.className.includes('Popover');
  });
  
  const safeHidden = hiddenContainers.filter(c => {
    return (c.querySelector('article') !== null || c.querySelector('[data-test-id^="library-grid-mosaic-card-"]') !== null) &&
           c.closest('[role="listbox"]') === null &&
           !c.className.includes('Popover');
  });
  
  if (safeVisible.length === 0) return;
  
  // Get parent container
  const parent = safeVisible[0].parentElement;
  if (!parent) return;
  
  console.log('[GS4PM Filter] Reordering grid:', safeVisible.length, 'visible,', safeHidden.length, 'hidden (filtered from', visibleContainers.length, '+', hiddenContainers.length, ')');
  
  // Detect grid parameters from ALL containers (visible + hidden)
  const allContainers = [...safeVisible, ...safeHidden];
  const positions = allContainers.map(c => ({
    left: parseFloat(c.dataset.gs4pmOrigLeft || c.style.left) || 0,
    top: parseFloat(c.dataset.gs4pmOrigTop || c.style.top) || 0,
    width: parseFloat(window.getComputedStyle(c).width) || 0,
    height: parseFloat(window.getComputedStyle(c).height) || 0
  })).filter(p => p.left >= 0 && p.top >= 0); // Filter out already off-screen items
  
  if (positions.length === 0) return;
  
  // Sort by top then left to find grid pattern
  positions.sort((a, b) => a.top - b.top || a.left - b.left);

  // Preserve the grid's natural inset (this grid often starts at ~24px, not 0).
  const originLeft = positions[0].left || 0;
  const originTop = positions[0].top || 0;
  
  // Find column width (smallest horizontal gap between items in same row)
  const firstRowItems = positions.filter(p => Math.abs(p.top - positions[0].top) < 10);
  const columnWidth = firstRowItems.length > 1 
    ? Math.min(...firstRowItems.slice(1).map((p, i) => p.left - firstRowItems[i].left))
    : positions[0].width + 24;
  
  // Find row height (smallest vertical gap)
  const rowHeight = positions.length > 1
    ? positions.slice(1).reduce((min, p, i) => {
        const gap = p.top - positions[i].top;
        return gap > 10 && gap < min ? gap : min;
      }, positions[0].height + 24)
    : positions[0].height + 24;
  
  // Detect columns per row
  const columnsPerRow = firstRowItems.length;
  
  console.log('[GS4PM Filter] Grid params: columnWidth=' + columnWidth + 'px, rowHeight=' + rowHeight + 'px, columns=' + columnsPerRow);
  
  // Reposition visible containers in grid from (0,0)
  safeVisible.forEach((container, index) => {
    const col = index % columnsPerRow;
    const row = Math.floor(index / columnsPerRow);
    const newLeft = originLeft + col * columnWidth;
    const newTop = originTop + row * rowHeight;
    
    // Store original position if not already stored
    if (!container.dataset.gs4pmOrigLeft) {
      container.dataset.gs4pmOrigLeft = container.style.left;
      container.dataset.gs4pmOrigTop = container.style.top;
    }
    
    container.style.left = newLeft + 'px';
    container.style.top = newTop + 'px';
    container.style.display = '';
    // If this container was previously hidden, clear hidden marker.
    delete container.dataset.gs4pmHidden;
  });
  
  // Move hidden containers off-screen
  safeHidden.forEach(container => {
    if (!container.dataset.gs4pmOrigLeft) {
      container.dataset.gs4pmOrigLeft = container.style.left;
      container.dataset.gs4pmOrigTop = container.style.top;
    }
    container.style.left = '-9999px';
    container.style.top = '-9999px';
    container.dataset.gs4pmHidden = 'true';
  });
  
  // Adjust parent height to fit visible cards
  const visibleRows = Math.ceil(safeVisible.length / columnsPerRow);
  const newHeight = visibleRows * rowHeight;
  if (!parent.dataset.gs4pmOrigHeight) {
    parent.dataset.gs4pmOrigHeight = parent.style.height;
  }
  parent.style.height = newHeight + 'px';
  
  console.log('[GS4PM Filter] Grid reordered:', safeVisible.length, 'cards in', visibleRows, 'rows, height=' + newHeight + 'px');
}

function restoreVirtualizedGrid(containers) {
  if (containers.length === 0) return;
  
  const parent = containers[0].parentElement;
  
  containers.forEach(container => {
    if (container.dataset.gs4pmOrigLeft !== undefined) {
      container.style.left = container.dataset.gs4pmOrigLeft;
      container.style.top = container.dataset.gs4pmOrigTop;
      container.style.display = '';
      delete container.dataset.gs4pmOrigLeft;
      delete container.dataset.gs4pmOrigTop;
      delete container.dataset.gs4pmHidden;
    }
  });
  
  if (parent && parent.dataset.gs4pmOrigHeight !== undefined) {
    parent.style.height = parent.dataset.gs4pmOrigHeight;
    delete parent.dataset.gs4pmOrigHeight;
  }
  
  console.log('[GS4PM Filter] Grid restored to original layout');
}

function reorderVirtualizedDropdown(visibleWrappers, hiddenWrappers) {
  // Log call stack to see what triggered this
  const stack = new Error().stack;
  const caller = stack.split('\n')[2] || 'unknown';
  console.log('[GS4PM Filter] 🔄 reorderVirtualizedDropdown called from:', caller.trim());
  console.log('[GS4PM Filter] 📊 Reordering:', visibleWrappers.length, 'visible,', hiddenWrappers.length, 'hidden');
  
  if (visibleWrappers.length === 0 && hiddenWrappers.length === 0) return;
  
  const allWrappers = [...visibleWrappers, ...hiddenWrappers];
  if (allWrappers.length === 0) return;
  
  const parent = allWrappers[0].parentElement;
  if (!parent) {
    console.log('[GS4PM Filter] ERROR: No parent element found for dropdown wrappers');
    return;
  }
  
  // Get the height of a single item
  const itemHeight = parseInt(allWrappers[0].style.height) || 32;
  
  // Sort visible by original position to maintain order
  // Use original top if available, otherwise parse current top (handles "4px" etc)
  const sortedVisible = visibleWrappers.sort((a, b) => {
    const aTop = a.dataset.gs4pmOrigTop ? parseInt(a.dataset.gs4pmOrigTop) : (parseInt(a.style.top) || 0);
    const bTop = b.dataset.gs4pmOrigTop ? parseInt(b.dataset.gs4pmOrigTop) : (parseInt(b.style.top) || 0);
    return aTop - bTop;
  });
  
  // Reposition visible items to compress (NO OBSERVER PROTECTION)
  // Check for parent padding that might cause offset (used for both positioning and height calculation)
  const parentPaddingTop = parseInt(window.getComputedStyle(parent).paddingTop) || 0;
  
  // Use the FIRST item's original top position as base offset
  // This accounts for any padding/margins/spacing that computed styles might miss
  // CRITICAL: We must use the actual first item position, not computed padding, because
  // React's virtualization may position items differently than CSS padding suggests
  let baseOffset = 0;
  if (sortedVisible.length > 0) {
    const firstWrapper = sortedVisible[0];
    const firstOrigTop = firstWrapper.dataset.gs4pmOrigTop ? 
                        parseInt(firstWrapper.dataset.gs4pmOrigTop) : 
                        (parseInt(firstWrapper.style.top) || 0);
    baseOffset = firstOrigTop;
  } else {
    baseOffset = parentPaddingTop;
  }
  
  // Find popover element (used in multiple places)
  const popover = parent?.closest('[data-testid="popover"]') || 
                 parent?.closest('.spectrum-Popover') ||
                 parent?.closest('[role="presentation"][class*="Popover"]');
  
  const itemDetails = [];
  const currentPositions = [];
  let needsRepositioning = false;
  
  // First pass: check if repositioning is needed
  sortedVisible.forEach((wrapper, index) => {
    const currentTop = wrapper.style.top;
    const newTop = (index * itemHeight) + baseOffset;
    const currentTopNum = currentTop ? parseInt(currentTop) : null;
    const newTopNum = parseInt(newTop);
    
    // Check if position is already correct (within 1px tolerance)
    if (currentTopNum === null || Math.abs(currentTopNum - newTopNum) > 1) {
      needsRepositioning = true;
    }
  });
  
  // Only reposition if needed
  if (needsRepositioning) {
    sortedVisible.forEach((wrapper, index) => {
      const currentTop = wrapper.style.top;
      if (!wrapper.dataset.gs4pmOrigTop) {
        wrapper.dataset.gs4pmOrigTop = wrapper.style.top;
      }
      const newTop = (index * itemHeight) + baseOffset; // Account for padding
      const option = wrapper.querySelector('[role="option"]');
      const text = option ? option.textContent.trim() : 'unknown';
      
      itemDetails.push(text + '@' + newTop + 'px');
      if (currentTop && currentTop !== newTop + 'px') {
        currentPositions.push(text + ': ' + currentTop + ' → ' + newTop + 'px');
      }
      
      wrapper.style.top = newTop + 'px';
      wrapper.style.display = '';
      wrapper.style.visibility = 'visible';
      wrapper.style.opacity = '1';
    });
    
    // Only log if positions actually changed
    if (currentPositions.length > 0) {
      console.log('[GS4PM Filter] ⚠️ Position changes detected:', currentPositions.join(', '));
    }
    
    // Continue with visibility checks for last item (only if we repositioned)
    if (sortedVisible.length > 0) {
      const lastIndex = sortedVisible.length - 1;
      const wrapper = sortedVisible[lastIndex];
      const option = wrapper.querySelector('[role="option"]');
      const text = option ? option.textContent.trim() : 'unknown';
      
      // After positioning, check if item is actually visible (only for last item to avoid spam)
      // Check immediately AND after delay
      const checkVisibility = () => {
        const rect = wrapper.getBoundingClientRect();
        const parent = wrapper.parentElement;
        const parentRect = parent ? parent.getBoundingClientRect() : null;
        const isInParent = parentRect ? (rect.top >= parentRect.top && rect.bottom <= parentRect.bottom) : true;
        const computedDisplay = window.getComputedStyle(wrapper).display;
        const computedVisibility = window.getComputedStyle(wrapper).visibility;
        const computedOpacity = window.getComputedStyle(wrapper).opacity;
        const parentHeight = parent ? window.getComputedStyle(parent).height : 'N/A';
        const parentMaxHeight = parent ? window.getComputedStyle(parent).maxHeight : 'N/A';
        const parentOverflow = parent ? window.getComputedStyle(parent).overflow : 'N/A';
        
        if (!isInParent || computedDisplay === 'none' || computedVisibility === 'hidden' || computedOpacity === '0') {
          console.log('[GS4PM Filter] ⚠️ Last item ("' + text + '") may not be visible:');
          console.log('  - wrapper top:', wrapper.style.top, 'rect.top:', rect.top, 'rect.bottom:', rect.bottom);
          console.log('  - parent rect:', parentRect ? parentRect.top + '-' + parentRect.bottom : 'N/A', 'parent height:', parentHeight, 'maxHeight:', parentMaxHeight);
          console.log('  - display:', computedDisplay, 'visibility:', computedVisibility, 'opacity:', computedOpacity, 'overflow:', parentOverflow);
          console.log('  - isInParent:', isInParent, 'rect.height:', rect.height);
          
          // If clipped, try to fix parent height again
          if (!isInParent && parent) {
            console.log('[GS4PM Filter] 🔧 Item clipped! Re-applying parent height...');
            const expectedHeight = sortedVisible.length * 32;
            parent.style.setProperty('height', expectedHeight + 'px', 'important');
            parent.style.setProperty('max-height', expectedHeight + 'px', 'important');
            
            // Check for clip-path or transform that might be clipping
            const clipPath = window.getComputedStyle(parent).clipPath;
            const transform = window.getComputedStyle(parent).transform;
            if (clipPath && clipPath !== 'none') {
              console.log('[GS4PM Filter] ⚠️ Parent has clip-path:', clipPath);
            }
            if (transform && transform !== 'none') {
              console.log('[GS4PM Filter] ⚠️ Parent has transform:', transform);
            }
            
            // Check all ancestors for clipping
            let current = parent.parentElement;
            let level = 0;
            while (current && level < 3) {
              const currentHeight = window.getComputedStyle(current).height;
              const currentMaxHeight = window.getComputedStyle(current).maxHeight;
              const currentOverflow = window.getComputedStyle(current).overflow;
              if (currentMaxHeight && currentMaxHeight !== 'none' && parseInt(currentMaxHeight) < expectedHeight) {
                console.log('[GS4PM Filter] ⚠️ Ancestor at level', level, 'has restrictive maxHeight:', currentMaxHeight);
                current.style.setProperty('max-height', expectedHeight + 'px', 'important');
              }
              current = current.parentElement;
              level++;
            }
          }
        }
      };
      
      checkVisibility(); // Check immediately
      setTimeout(checkVisibility, 100); // Check again after React settles
    }
  } else {
    // Positions already correct, just ensure visibility properties are set
    sortedVisible.forEach((wrapper) => {
      wrapper.style.display = '';
      wrapper.style.visibility = 'visible';
      wrapper.style.opacity = '1';
    });
    console.log('[GS4PM Filter] ✅ Items already correctly positioned, skipping repositioning');
  }
  
  // Move hidden items off-screen (NO OBSERVER PROTECTION)
  hiddenWrappers.forEach(wrapper => {
    if (!wrapper.dataset.gs4pmOrigTop) {
      wrapper.dataset.gs4pmOrigTop = wrapper.style.top;
    }
    wrapper.style.top = '-9999px';
    wrapper.style.left = '-9999px';
    wrapper.style.display = 'none';
    wrapper.dataset.gs4pmHidden = 'true';
  });
  
  // Adjust parent height to fit visible items only (NO OBSERVER PROTECTION)
  // Check for padding that might reduce available space
  const parentPaddingBottom = parseInt(window.getComputedStyle(parent).paddingBottom) || 0;
  const parentBorderTop = parseInt(window.getComputedStyle(parent).borderTopWidth) || 0;
  const parentBorderBottom = parseInt(window.getComputedStyle(parent).borderBottomWidth) || 0;
  
  const contentHeight = sortedVisible.length * itemHeight;
  
  // CRITICAL: Calculate height based on baseOffset and item count (more reliable)
  // Last item will be positioned at: baseOffset + (visibleCount - 1) * itemHeight
  // Last item bottom = last item top + itemHeight
  const lastItem = sortedVisible[sortedVisible.length - 1];
  const lastItemTop = baseOffset + ((sortedVisible.length - 1) * itemHeight);
  const lastItemBottom = lastItemTop + itemHeight;
  
  // Verify: also check the actual style.top in case there's a mismatch
  const actualLastItemTop = parseInt(lastItem.style.top) || 0;
  if (Math.abs(actualLastItemTop - lastItemTop) > 1) {
    console.log('[GS4PM Filter] ⚠️ Height calculation mismatch: calculated=' + lastItemTop + 'px, actual style=' + actualLastItemTop + 'px');
  }
  
  // CRITICAL: Add a buffer to prevent React from removing items due to rounding/subpixel issues
  // React's virtualization can be very aggressive and will remove items if the container is even slightly too small
  // Increased buffer to 24px to be VERY conservative (React needs extra space to not remove items)
  // This ensures we have plenty of room for all items
  // Also round up to nearest pixel to avoid subpixel issues
  const heightBuffer = 24;
  
  // Also account for any bottom padding/borders
  const newHeight = lastItemBottom + parentPaddingBottom + parentBorderBottom + heightBuffer;
  
  // Double-check: ensure height is at least enough for all items (INCLUDING buffer)
  // This ensures we always have enough space for all items plus buffer
  const minHeightNeeded = baseOffset + (sortedVisible.length * itemHeight) + parentPaddingBottom + parentBorderBottom + heightBuffer;
  
  // Use the larger of the two calculations, and round up to nearest pixel
  const finalHeight = Math.ceil(Math.max(newHeight, minHeightNeeded));
  
  // Only log if height is different from expected
  if (Math.abs(finalHeight - (baseOffset + (sortedVisible.length * itemHeight) + heightBuffer)) > 5) {
    console.log('[GS4PM Filter] Height check: calculated=' + newHeight + 'px, minNeeded=' + minHeightNeeded + 'px, using=' + finalHeight + 'px');
  }
  
  if (!parent.dataset.gs4pmOrigHeight) {
    parent.dataset.gs4pmOrigHeight = parent.style.height;
  }
  
  parent.style.setProperty('height', finalHeight + 'px', 'important');
  parent.style.setProperty('max-height', finalHeight + 'px', 'important');
  parent.style.setProperty('min-height', finalHeight + 'px', 'important'); // Match height exactly
  parent.style.setProperty('overflow', 'hidden', 'important');
  
  // Find and adjust the listbox (parent.parentElement should be the listbox)
  const listbox = parent.parentElement;
  if (listbox && listbox.getAttribute('role') === 'listbox') {
    if (!listbox.dataset.gs4pmOrigHeight) {
      listbox.dataset.gs4pmOrigHeight = listbox.style.height;
      listbox.dataset.gs4pmOrigMaxHeight = listbox.style.maxHeight;
    }
    listbox.style.setProperty('max-height', finalHeight + 'px', 'important');
    listbox.style.setProperty('height', finalHeight + 'px', 'important');
    listbox.style.setProperty('min-height', finalHeight + 'px', 'important'); // Match height exactly
    listbox.style.setProperty('overflow', 'hidden', 'important');
  }
  
  // Also check for the outer presentation container (the popover wrapper)
  const outerContainer = listbox?.parentElement;
  if (outerContainer) {
    if (outerContainer.dataset.gs4pmOrigHeight === undefined) {
      outerContainer.dataset.gs4pmOrigHeight = outerContainer.style.height || '';
    }
    // Set explicit height to prevent gaps
    outerContainer.style.setProperty('height', finalHeight + 'px', 'important');
    outerContainer.style.setProperty('max-height', finalHeight + 'px', 'important');
    outerContainer.style.setProperty('min-height', finalHeight + 'px', 'important'); // Match height exactly
  }
  
  // Check for SUPER outer container (beyond outerContainer)
  const superOuter = outerContainer?.parentElement;
  if (superOuter && superOuter.getAttribute('role') === 'presentation') {
    if (superOuter.dataset.gs4pmOrigHeight === undefined) {
      superOuter.dataset.gs4pmOrigHeight = superOuter.style.height || '';
    }
    superOuter.style.setProperty('height', finalHeight + 'px', 'important');
    superOuter.style.setProperty('min-height', finalHeight + 'px', 'important');
    superOuter.style.setProperty('max-height', finalHeight + 'px', 'important');
    superOuter.style.setProperty('display', 'block', 'important');
  }
  
  // CRITICAL: Also set the Popover element height (React checks this for virtualization)
  // (popover already declared above)
  if (popover) {
    if (!popover.dataset.gs4pmOrigHeight) {
      popover.dataset.gs4pmOrigHeight = popover.style.height || '';
      popover.dataset.gs4pmOrigMaxHeight = popover.style.maxHeight || '';
    }
    popover.style.setProperty('height', finalHeight + 'px', 'important');
    popover.style.setProperty('max-height', finalHeight + 'px', 'important');
    popover.style.setProperty('min-height', finalHeight + 'px', 'important');
  }
  
  // Check for EVEN MORE outer containers (popover wrapper, etc.)
  let current = superOuter || outerContainer || listbox || parent;
  let level = 0;
  while (current && current.parentElement && level < 5) {
    const grandParent = current.parentElement;
    const computedHeight = window.getComputedStyle(grandParent).height;
    const computedMaxHeight = window.getComputedStyle(grandParent).maxHeight;
    
    // If this parent has a restrictive max-height, fix it
    if (computedMaxHeight && computedMaxHeight !== 'none' && parseInt(computedMaxHeight) < finalHeight) {
      console.log('[GS4PM Filter] Found restrictive container at level', level, ':', grandParent.className, 'max-height:', computedMaxHeight);
      grandParent.style.setProperty('max-height', finalHeight + 'px', 'important');
      grandParent.style.setProperty('height', finalHeight + 'px', 'important');
    }
    
    current = grandParent;
    level++;
  }
  
  // Store the target height globally so observer can access it
  targetDropdownHeight = finalHeight;
  
  // Reset flag now that we have a new target height
  isTemporarilyIncreasingHeight = false;
  
  // ULTRA-AGGRESSIVE FIX: Use MutationObserver to watch for ANY height changes and immediately correct them
  // Disconnect any existing observer first (in case dropdown was reopened)
  if (dropdownHeightObserver) {
    dropdownHeightObserver.disconnect();
    dropdownHeightObserver = null;
  }
  
  dropdownHeightObserver = new MutationObserver((mutations) => {
    // Don't reset height if watchdog is temporarily increasing it to force React to render all items
    if (isTemporarilyIncreasingHeight) {
      return;
    }
    
    let needsFix = false;
    
    if (parent.style.height !== targetDropdownHeight + 'px') {
      console.log('[GS4PM Filter] ⚡ Observer: parent height', parent.style.height, '→', targetDropdownHeight + 'px');
      parent.style.setProperty('height', targetDropdownHeight + 'px', 'important');
      parent.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
      parent.style.setProperty('min-height', targetDropdownHeight + 'px', 'important'); // Match exactly
      parent.style.setProperty('overflow', 'hidden', 'important');
      needsFix = true;
    }
    
    if (listbox && listbox.style.height !== targetDropdownHeight + 'px') {
      listbox.style.setProperty('height', targetDropdownHeight + 'px', 'important');
      listbox.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
      listbox.style.setProperty('min-height', targetDropdownHeight + 'px', 'important'); // Match exactly
      listbox.style.setProperty('overflow', 'hidden', 'important');
      needsFix = true;
    }
    
    if (outerContainer && outerContainer.style.height !== targetDropdownHeight + 'px') {
      outerContainer.style.setProperty('height', targetDropdownHeight + 'px', 'important');
      outerContainer.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
      outerContainer.style.setProperty('min-height', targetDropdownHeight + 'px', 'important'); // Match exactly
      needsFix = true;
    }
    
    if (superOuter && superOuter.style.height !== targetDropdownHeight + 'px') {
      superOuter.style.setProperty('height', targetDropdownHeight + 'px', 'important');
      superOuter.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
      superOuter.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
      superOuter.style.setProperty('display', 'block', 'important');
      needsFix = true;
    }
    
    // Also watch popover (React checks this for virtualization)
    const popover = parent?.closest('[data-testid="popover"]') || 
                   parent?.closest('.spectrum-Popover') ||
                   parent?.closest('[role="presentation"][class*="Popover"]');
    if (popover && popover.style.height !== targetDropdownHeight + 'px') {
      popover.style.setProperty('height', targetDropdownHeight + 'px', 'important');
      popover.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
      popover.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
      needsFix = true;
    }
  });
  
  // Watch all containers for style attribute changes
  dropdownHeightObserver.observe(parent, { attributes: true, attributeFilter: ['style'] });
  if (listbox) {
    dropdownHeightObserver.observe(listbox, { attributes: true, attributeFilter: ['style'] });
  }
  if (outerContainer) {
    dropdownHeightObserver.observe(outerContainer, { attributes: true, attributeFilter: ['style'] });
  }
  if (superOuter) {
    dropdownHeightObserver.observe(superOuter, { attributes: true, attributeFilter: ['style'] });
  }
  // Also watch popover (React checks this for virtualization)
  // (popover already declared above)
  if (popover) {
    dropdownHeightObserver.observe(popover, { attributes: true, attributeFilter: ['style'] });
  }
  
  // Final verification: Check if last item is actually visible (multiple checks with increasing delays)
  const checkVisibility = (delay, checkNumber) => {
    setTimeout(() => {
      if (!document.body.contains(parent)) return; // Dropdown closed
      
      if (sortedVisible.length > 0) {
        const lastItem = sortedVisible[sortedVisible.length - 1];
        const lastRect = lastItem.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        
        // Check visibility against both parent AND popover (whichever is more restrictive)
        let isVisibleInParent = lastRect.bottom <= parentRect.bottom + 1 && lastRect.height > 0; // +1 for rounding tolerance
        let isVisibleInPopover = true;
        
        if (popover) {
          const popoverRect = popover.getBoundingClientRect();
          isVisibleInPopover = lastRect.bottom <= popoverRect.bottom + 1 && lastRect.height > 0;
        }
        
        const isVisible = isVisibleInParent && isVisibleInPopover;
        
        const lastItemTop = parseInt(lastItem.style.top) || 0;
        const parentComputedHeight = window.getComputedStyle(parent).height;
        const listboxComputedHeight = listbox ? window.getComputedStyle(listbox).height : 'N/A';
        const popoverComputedHeight = popover ? window.getComputedStyle(popover).height : 'N/A';
        
        // CRITICAL DEBUG: Log everything to understand clipping
        const lastItemStyleTop = lastItem.style.top;
        const lastItemComputedTop = window.getComputedStyle(lastItem).top;
        const lastItemOffsetTop = lastItem.offsetTop;
        const lastItemOffsetHeight = lastItem.offsetHeight;
        const lastItemScrollHeight = lastItem.scrollHeight;
        
        const parentStyleHeight = parent.style.height;
        const parentComputedHeightNum = parseFloat(parentComputedHeight);
        const parentRectHeight = parentRect.bottom - parentRect.top;
        const parentScrollHeight = parent.scrollHeight;
        const parentClientHeight = parent.clientHeight;
        
        // Also check using scrollHeight vs clientHeight
        const isClippedByScroll = parentScrollHeight > parentClientHeight;
        const contentHeight = lastItemOffsetTop + lastItemOffsetHeight;
        
        // Calculate actual needed height based on scrollHeight and content
        const actualNeededHeight = Math.max(finalHeight, parentScrollHeight, contentHeight);
        const heightToUse = actualNeededHeight > finalHeight ? actualNeededHeight : finalHeight;
        
        if (!isVisible || isClippedByScroll || contentHeight > parentClientHeight) {
          console.log('[GS4PM Filter] ❌ Last item CLIPPED! rect.bottom=' + Math.round(lastRect.bottom) + ', parent.bottom=' + Math.round(parentRect.bottom) + ', scrollHeight=' + parentScrollHeight + ', clientHeight=' + parentClientHeight);
          console.log('[GS4PM Filter] 🔧 Re-applying heights: expected', finalHeight + 'px');
          
          if (actualNeededHeight > finalHeight) {
            console.log('[GS4PM Filter]   - Adjusting height from', finalHeight, 'to', actualNeededHeight, 'px');
          }
          
          // Check all containers for clipping
          if (popover) {
            const popoverRect = popover.getBoundingClientRect();
            if (lastRect.bottom > popoverRect.bottom) {
              console.log('[GS4PM Filter] ⚠️ Popover clipping! Last item bottom', Math.round(lastRect.bottom), '> popover bottom', Math.round(popoverRect.bottom));
            }
          }
          // Force re-apply heights using the adjusted height if needed
          parent.style.setProperty('height', heightToUse + 'px', 'important');
          parent.style.setProperty('max-height', heightToUse + 'px', 'important');
          parent.style.setProperty('min-height', heightToUse + 'px', 'important');
          if (listbox) {
            listbox.style.setProperty('height', heightToUse + 'px', 'important');
            listbox.style.setProperty('max-height', heightToUse + 'px', 'important');
            listbox.style.setProperty('min-height', heightToUse + 'px', 'important');
          }
          if (outerContainer) {
            outerContainer.style.setProperty('height', heightToUse + 'px', 'important');
            outerContainer.style.setProperty('max-height', heightToUse + 'px', 'important');
            outerContainer.style.setProperty('min-height', heightToUse + 'px', 'important');
          }
          if (popover) {
            popover.style.setProperty('height', heightToUse + 'px', 'important');
            popover.style.setProperty('max-height', heightToUse + 'px', 'important');
            popover.style.setProperty('min-height', heightToUse + 'px', 'important');
          }
        } else {
          // Even if visible, check if we need to adjust height based on scrollHeight
          if (heightToUse > finalHeight) {
            console.log('[GS4PM Filter] ⚠️ Height adjustment needed (scrollHeight/content > calculated):', heightToUse, 'vs', finalHeight);
            parent.style.setProperty('height', heightToUse + 'px', 'important');
            parent.style.setProperty('max-height', heightToUse + 'px', 'important');
            parent.style.setProperty('min-height', heightToUse + 'px', 'important');
            if (listbox) {
              listbox.style.setProperty('height', heightToUse + 'px', 'important');
              listbox.style.setProperty('max-height', heightToUse + 'px', 'important');
              listbox.style.setProperty('min-height', heightToUse + 'px', 'important');
            }
            if (outerContainer) {
              outerContainer.style.setProperty('height', heightToUse + 'px', 'important');
              outerContainer.style.setProperty('max-height', heightToUse + 'px', 'important');
              outerContainer.style.setProperty('min-height', heightToUse + 'px', 'important');
            }
            if (popover) {
              popover.style.setProperty('height', heightToUse + 'px', 'important');
              popover.style.setProperty('max-height', heightToUse + 'px', 'important');
              popover.style.setProperty('min-height', heightToUse + 'px', 'important');
            }
          }
        }
      }
    }, delay);
  };
  
  // Check immediately, after 100ms, 300ms, and 500ms to catch late resets
  checkVisibility(50, 1);
  checkVisibility(200, 2);
  checkVisibility(500, 3);
  
  // Keep track of when observer is active
  parent.dataset.gs4pmObserverActive = 'true';
  
  // Clear any existing watchdog
  if (dropdownWatchdogInterval) {
    clearInterval(dropdownWatchdogInterval);
  }
  
  // Add a watchdog to check if elements are still in the DOM AND continuously fix heights
  dropdownWatchdogInterval = setInterval(() => {
    if (!document.body.contains(parent)) {
      console.log('[GS4PM Filter] 🛑 Dropdown removed from DOM, disconnecting observer');
      clearInterval(dropdownWatchdogInterval);
      dropdownWatchdogInterval = null;
      
      // Cancel any pending retry timeouts
      dropdownRetryTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
      dropdownRetryTimeouts = [];
      
      // Disconnect item observer
      if (dropdownItemObserver) {
        dropdownItemObserver.disconnect();
        dropdownItemObserver = null;
      }
      
      if (dropdownHeightObserver) {
        dropdownHeightObserver.disconnect();
        dropdownHeightObserver = null;
      }
    } else {
      // Still in DOM, continuously verify and fix heights
      let needsFix = false;
      let watchdogActions = [];
      
      // Check parent height
      const parentComputedHeight = window.getComputedStyle(parent).height;
      if (parentComputedHeight !== targetDropdownHeight + 'px') {
        watchdogActions.push('parent height: ' + parentComputedHeight + ' → ' + targetDropdownHeight + 'px');
        parent.style.setProperty('height', targetDropdownHeight + 'px', 'important');
        parent.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
        parent.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
        needsFix = true;
      }
      
      // Check listbox height
      if (listbox) {
        const listboxComputedHeight = window.getComputedStyle(listbox).height;
        if (listboxComputedHeight !== targetDropdownHeight + 'px') {
          listbox.style.setProperty('height', targetDropdownHeight + 'px', 'important');
          listbox.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
          listbox.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
          needsFix = true;
        }
      }
      
      // Check outerContainer height
      if (outerContainer) {
        const outerComputedHeight = window.getComputedStyle(outerContainer).height;
        if (outerComputedHeight !== targetDropdownHeight + 'px') {
          outerContainer.style.setProperty('height', targetDropdownHeight + 'px', 'important');
          outerContainer.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
          outerContainer.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
          needsFix = true;
        }
      }
      
      // Check popover height
      if (popover) {
        const popoverComputedHeight = window.getComputedStyle(popover).height;
        if (popoverComputedHeight !== targetDropdownHeight + 'px') {
          popover.style.setProperty('height', targetDropdownHeight + 'px', 'important');
          popover.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
          popover.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
          needsFix = true;
        }
      }
      
      // Verify last item is visible - RE-QUERY fresh wrappers to avoid stale references
      const freshWrappers = Array.from(parent.querySelectorAll('[role="presentation"]')).filter(wrapper => 
        wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute' && wrapper.style.top !== '-9999px'
      );
      
      // Generic watchdog: rely on clipping/virtualization checks below (no hardcoded demo counts).
      if (freshWrappers.length > 0) {
        const lastItem = freshWrappers[freshWrappers.length - 1];
        
        // Check if last item still exists in DOM (React might remove it)
        if (!document.body.contains(lastItem)) {
          console.log('[GS4PM Filter] ⚠️ Watchdog: Last item removed from DOM! Re-filtering...');
          // Item was removed - React's virtualization removed it because container was too small
          // Re-query wrappers and re-filter
          const listboxContainer = parent.closest('[role="listbox"]') || parent.parentElement;
          if (listboxContainer && document.body.contains(listboxContainer)) {
            console.log('[GS4PM Filter] 🔄 Re-triggering dropdown filter...');
            // Set flag to prevent observer from resetting height
            isTemporarilyIncreasingHeight = true;
            
            // Temporarily increase height to force React to render all items again
            const tempHeight = 352; // Full height for all 11 items
            parent.style.setProperty('height', tempHeight + 'px', 'important');
            parent.style.setProperty('max-height', tempHeight + 'px', 'important');
            if (listbox) {
              listbox.style.setProperty('height', tempHeight + 'px', 'important');
              listbox.style.setProperty('max-height', tempHeight + 'px', 'important');
            }
            if (popover) {
              popover.style.setProperty('height', tempHeight + 'px', 'important');
              popover.style.setProperty('max-height', tempHeight + 'px', 'important');
            }
            
            // Wait a bit for React to render, then re-filter
            setTimeout(() => {
              if (document.body.contains(listboxContainer)) {
                // Re-query and re-filter
                applyFilterToNode(listboxContainer);
                // Reset flag after re-filtering starts (it will set new targetDropdownHeight)
                setTimeout(() => {
                  isTemporarilyIncreasingHeight = false;
                }, 200);
              } else {
                isTemporarilyIncreasingHeight = false;
              }
            }, 100);
          }
          needsFix = true;
        } else {
          const lastRect = lastItem.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();
          const isVisibleInParent = lastRect.bottom <= parentRect.bottom + 1; // +1 for rounding tolerance
          
          let isVisibleInPopover = true;
          if (popover) {
            const popoverRect = popover.getBoundingClientRect();
            isVisibleInPopover = lastRect.bottom <= popoverRect.bottom + 1;
          }
          
          const isVisible = isVisibleInParent && isVisibleInPopover;
          
          if (!isVisible && lastRect.height > 0) {
            console.log('[GS4PM Filter] ⚠️ Watchdog: Last item clipped!');
            console.log('  - Last item bottom:', Math.round(lastRect.bottom), 'parent bottom:', Math.round(parentRect.bottom));
            console.log('  - Last item top style:', lastItem.style.top);
            if (popover) {
              const popoverRect = popover.getBoundingClientRect();
              console.log('  - Popover bottom:', Math.round(popoverRect.bottom), 'popover height:', window.getComputedStyle(popover).height);
            }
            
            // Force re-apply all heights
            parent.style.setProperty('height', targetDropdownHeight + 'px', 'important');
            parent.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
            parent.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
            if (listbox) {
              listbox.style.setProperty('height', targetDropdownHeight + 'px', 'important');
              listbox.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
              listbox.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
            }
            if (outerContainer) {
              outerContainer.style.setProperty('height', targetDropdownHeight + 'px', 'important');
              outerContainer.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
              outerContainer.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
            }
            if (popover) {
              popover.style.setProperty('height', targetDropdownHeight + 'px', 'important');
              popover.style.setProperty('max-height', targetDropdownHeight + 'px', 'important');
              popover.style.setProperty('min-height', targetDropdownHeight + 'px', 'important');
            }
            needsFix = true;
          }
        }
      }
      
      // Only log if watchdog took action
      if (needsFix && watchdogActions.length > 0) {
        console.log('[GS4PM Filter] 🐕 Watchdog actions:', watchdogActions.join('; '));
      }
    }
  }, 500);
  
  // Visual debug removed for performance
  
  // DEBUG: Log only if there's an issue
  const superComputed = superOuter ? window.getComputedStyle(superOuter).height : null;
  if (superOuter && (superComputed === '0px' || superComputed === 'auto')) {
    // Force superOuter to have explicit height
    superOuter.style.setProperty('height', newHeight + 'px', 'important');
    superOuter.style.setProperty('min-height', newHeight + 'px', 'important');
    superOuter.style.setProperty('max-height', newHeight + 'px', 'important');
    superOuter.style.setProperty('display', 'block', 'important');
  }
  
  // AGGRESSIVE RETRY: Set heights multiple times with delays to fight GenStudio
  const retryHeights = () => {
    parent.style.setProperty('height', newHeight + 'px', 'important');
    parent.style.setProperty('max-height', newHeight + 'px', 'important');
    parent.style.setProperty('overflow', 'hidden', 'important');
    if (listbox) {
      listbox.style.setProperty('height', newHeight + 'px', 'important');
      listbox.style.setProperty('max-height', newHeight + 'px', 'important');
      listbox.style.setProperty('overflow', 'hidden', 'important');
    }
    if (outerContainer) {
      outerContainer.style.setProperty('height', newHeight + 'px', 'important');
      outerContainer.style.setProperty('max-height', newHeight + 'px', 'important');
    }
    if (superOuter) {
      superOuter.style.setProperty('height', newHeight + 'px', 'important');
      superOuter.style.setProperty('min-height', newHeight + 'px', 'important');
      superOuter.style.setProperty('max-height', newHeight + 'px', 'important');
      superOuter.style.setProperty('display', 'block', 'important');
    }
    
    // Also check and fix any restrictive containers up the tree
    let current = superOuter || outerContainer || listbox || parent;
    let level = 0;
    while (current && current.parentElement && level < 5) {
      const grandParent = current.parentElement;
      const computedMaxHeight = window.getComputedStyle(grandParent).maxHeight;
      if (computedMaxHeight && computedMaxHeight !== 'none' && parseInt(computedMaxHeight) < newHeight) {
        grandParent.style.setProperty('max-height', newHeight + 'px', 'important');
        grandParent.style.setProperty('height', newHeight + 'px', 'important');
      }
      current = grandParent;
      level++;
    }
  };
  
  // Retry immediately, then after short delays
  setTimeout(retryHeights, 50);
  setTimeout(retryHeights, 150);
  setTimeout(retryHeights, 300);
}

function restoreVirtualizedDropdown(wrappers) {
  if (wrappers.length === 0) return;
  
  // Disconnect height observer when restoring
  if (dropdownHeightObserver) {
    dropdownHeightObserver.disconnect();
    dropdownHeightObserver = null;
    targetDropdownHeight = null;
    console.log('[GS4PM Filter] 🔓 Height observer disconnected');
  }
  
  // Clear watchdog
  if (dropdownWatchdogInterval) {
    clearInterval(dropdownWatchdogInterval);
    dropdownWatchdogInterval = null;
  }
  
  const parent = wrappers[0].parentElement;
  
  wrappers.forEach(wrapper => {
    // Restore display and position
    wrapper.style.display = '';
    if (wrapper.dataset.gs4pmOrigTop) {
      wrapper.style.top = wrapper.dataset.gs4pmOrigTop;
      delete wrapper.dataset.gs4pmOrigTop;
    }
    wrapper.style.left = '0px';
    delete wrapper.dataset.gs4pmHidden;
  });
  
  // Restore parent height
  if (parent && parent.dataset.gs4pmOrigHeight) {
    parent.style.height = parent.dataset.gs4pmOrigHeight;
    parent.style.maxHeight = '';
    parent.style.overflow = '';
    delete parent.dataset.gs4pmOrigHeight;
  }
  
  // Restore listbox height
  const listbox = parent?.parentElement;
  if (listbox && listbox.getAttribute('role') === 'listbox' && listbox.dataset.gs4pmOrigHeight) {
    listbox.style.height = listbox.dataset.gs4pmOrigHeight;
    listbox.style.maxHeight = listbox.dataset.gs4pmOrigMaxHeight || '';
    listbox.style.overflow = '';
    delete listbox.dataset.gs4pmOrigHeight;
    delete listbox.dataset.gs4pmOrigMaxHeight;
  }
  
  // Restore outer container height
  const outerContainer = listbox?.parentElement;
  if (outerContainer && outerContainer.dataset.gs4pmOrigHeight !== undefined) {
    outerContainer.style.height = outerContainer.dataset.gs4pmOrigHeight;
    outerContainer.style.maxHeight = '';
    delete outerContainer.dataset.gs4pmOrigHeight;
  }
  
  // Restore popover height if it was modified
  const popover = parent?.closest('[data-testid="popover"]') || 
                 parent?.closest('.spectrum-Popover') ||
                 parent?.closest('[role="presentation"][class*="Popover"]');
  if (popover && popover.dataset.gs4pmOrigHeight !== undefined) {
    popover.style.height = popover.dataset.gs4pmOrigHeight;
    popover.style.maxHeight = popover.dataset.gs4pmOrigMaxHeight || '';
    popover.style.minHeight = '';
    delete popover.dataset.gs4pmOrigHeight;
    delete popover.dataset.gs4pmOrigMaxHeight;
  }
  
  console.log('[GS4PM Filter] Dropdown restored to original layout');
}

// ===== Filtering logic =====

function applyFilter(activeCustomer) {
  currentFilterCustomer = activeCustomer;
  loadTags(tags => {
    // Clean filtering for Content/Assets: CSS-driven to avoid scroll flicker on virtualization.
    if (isContentAssetsPage()) {
      updateAssetsCssFilter(activeCustomer, tags);
      cachedTags = tags;
      if (shouldRenderBadges()) refreshBadges();
      return;
    }

    // Clean filtering for Templates: CSS-driven to avoid scroll flicker on virtualization.
    if (isTemplatesPage()) {
      updateTemplatesCssFilter(activeCustomer, tags);
      cachedTags = tags;
      if (shouldRenderBadges()) refreshBadges();
      return;
    }

    // Brands library: CSS-driven hide/show to survive React virtualization.
    if (isBrandLibraryPage()) {
      updateBrandLibraryCssFilter(activeCustomer, tags);
      cachedTags = tags;
      if (shouldRenderBadges()) refreshBadges();
      return;
    }

    // If a filter is active but the brand grid hasn't mounted yet, retry briefly.
    // (Brand page is virtualized; the grid can appear after filter state is applied.)
    if (activeCustomer && activeCustomer !== 'ALL') {
      let tries = 0;
      const tick = () => {
        if (isBrandLibraryPage()) {
          updateBrandLibraryCssFilter(activeCustomer, tags);
          cachedTags = tags;
          if (shouldRenderBadges()) refreshBadges();
          return;
        }
        tries++;
        if (tries < 25) setTimeout(tick, 200); // ~5s max
      };
      tick();
    }

    // Find all potential container types
    const allContainers = new Set();
    
    // Traditional container selectors (including dropdown options)
    Array.from(document.querySelectorAll(
      '.react-spectrum-GridView-item, div.item, div.library-list-item-container, div[role="gridcell"]'
    )).forEach(el => allContainers.add(el));
    
    // Dropdown options: capture directly (not their containers)
    Array.from(document.querySelectorAll('[role="option"]')).forEach(option => {
      allContainers.add(option);
    });
    
    // Also find absolutely positioned divs that contain articles (virtualized grids ONLY)
    // CRITICAL: Must exclude dropdown CONTAINERS but not dropdown OPTIONS
    let skippedDropdowns = 0;
    let addedCards = 0;
    Array.from(document.querySelectorAll('div[style*="position: absolute"]')).forEach(div => {
      // Skip dropdown container structures (but not individual options)
      const role = div.getAttribute('role');
      const isListbox = role === 'listbox';
      const isPresentation = role === 'presentation';
      const containsListbox = div.querySelector('[role="listbox"]') !== null;
      const insideListbox = div.closest('[role="listbox"]') !== null;
      const insidePopover = div.closest('[role="presentation"][data-testid="popover"]') !== null;
      const hasPopoverClass = div.className && div.className.includes('Popover');
      const insidePopoverClass = div.closest('[class*="Popover"]') !== null;
      
      // CRITICAL: If role="presentation" and inside a listbox, ALWAYS skip (these are wrapper divs)
      if (isPresentation && insideListbox) {
        skippedDropdowns++;
        return;
      }
      
      // Skip dropdown containers but NOT individual options
      if (isListbox || containsListbox || insidePopover || hasPopoverClass || insidePopoverClass) {
        skippedDropdowns++;
        return;
      }
      
      // Only include if it contains an article (card), not dropdown options
      if (div.querySelector('article')) {
        allContainers.add(div);
        addedCards++;
      }
    });
    
    // NOW add dropdown options separately (they won't be reordered, just hidden/shown)
    // Add their parent wrappers (role="presentation") which have the absolute positioning
    let addedOptions = 0;
    const dropdownOptions = Array.from(document.querySelectorAll('[role="option"]'));
    console.log('[GS4PM Filter] Found', dropdownOptions.length, 'dropdown options in DOM');
    
    dropdownOptions.forEach(option => {
      const wrapper = option.parentElement;
      if (wrapper && wrapper.getAttribute('role') === 'presentation') {
        allContainers.add(wrapper);
        addedOptions++;
      } else {
        // Fallback: add the option itself
        allContainers.add(option);
        addedOptions++;
      }
    });
    
    console.log('[GS4PM Filter] Grid detection: skipped', skippedDropdowns, 'dropdown containers, added', addedCards, 'card containers and', addedOptions, 'dropdown options');
    
    console.log('[GS4PM Filter] Found', allContainers.size, 'containers to filter');
    console.log('[GS4PM Filter] Filtering for customer:', activeCustomer);
    console.log('[GS4PM Filter] Available tags:', tags.length);

    if (activeCustomer === 'ALL') {
      // Separate grid cards from dropdown wrappers
      const gridContainers = Array.from(allContainers).filter(c => 
        c.querySelector('article') !== null || c.querySelector('[data-test-id^="library-grid-mosaic-card-"]') !== null
      );
      const dropdownWrappers = Array.from(allContainers).filter(c => 
        c.getAttribute('role') === 'presentation' && c.querySelector('[role="option"]')
      );
      
      // Restore grid to original layout
      restoreVirtualizedGrid(gridContainers);
      
      // Restore dropdowns to original layout
      restoreVirtualizedDropdown(dropdownWrappers);
      
      // Also ensure all containers are shown
      allContainers.forEach(container => {
        container.style.display = '';
      });
      
      console.log('[GS4PM Filter] Restored ALL:', gridContainers.length, 'cards and', dropdownWrappers.length, 'dropdown wrappers');
      
      if (shouldRenderBadges()) refreshBadges();
      return;
    }

    // Separate containers by type
    const absoluteContainers = [];
    const regularContainers = [];
    
    allContainers.forEach(container => {
      const computedStyle = window.getComputedStyle(container);
      if (computedStyle.position === 'absolute') {
        absoluteContainers.push(container);
      } else {
        regularContainers.push(container);
      }
    });
    
    // Count dropdown options for debugging
    const dropdownWrappersCount = absoluteContainers.filter(c => c.getAttribute('role') === 'presentation' && c.querySelector('[role="option"]')).length;
    const dropdownOptionsRegular = regularContainers.filter(c => c.getAttribute('role') === 'option' || c.getAttribute('role') === 'presentation');
    console.log('[GS4PM Filter] Found', absoluteContainers.length, 'absolute containers (including', dropdownWrappersCount, 'dropdown wrappers),', regularContainers.length, 'regular containers (including', dropdownOptionsRegular.length, 'dropdown items)');

    // NEW LOGIC: Find which containers should be HIDDEN (tagged to other customers)
    // Default: show everything (untagged + current customer)
    const hiddenContainers = new Set();
    const visibleContainers = new Set();
    
    tags.forEach(tag => {
      const matchedElements = Array.from(document.querySelectorAll(tag.selector));
      
      matchedElements.forEach(el => {
        const container = getDisplayContainer(el) || el;
        const isCard = container.querySelector('article') !== null;
        const isDropdownWrapper = container.getAttribute('role') === 'presentation' && container.querySelector('[role="option"]');
        
        if (tag.customer === activeCustomer) {
          // This item is tagged to the current customer - show it
          visibleContainers.add(container);
          addBadge(container, tag.customer);
        } else {
          // This item is tagged to a different customer - hide it
          hiddenContainers.add(container);
        }
      });
    });
    
    console.log('[GS4PM Filter] Hiding', hiddenContainers.size, 'containers tagged to other customers, showing', visibleContainers.size, 'tagged to current customer + all untagged');

    // Apply filtering
    // Separate dropdown wrappers from grid cards
    const dropdownWrappers = absoluteContainers.filter(c => 
      c.getAttribute('role') === 'presentation' && c.querySelector('[role="option"]')
    );
    const gridCards = absoluteContainers.filter(c => !dropdownWrappers.includes(c));
    
    // For grid cards (absolute positioned): reorder
    const visibleCards = gridCards.filter(c => !hiddenContainers.has(c));
    const hiddenCards = gridCards.filter(c => hiddenContainers.has(c));
    if (gridCards.length > 0) {
      reorderVirtualizedGrid(visibleCards, hiddenCards);
    }
    
    // For dropdown wrappers (absolute positioned): reorder to compress
    const visibleDropdownWrappers = dropdownWrappers.filter(c => !hiddenContainers.has(c));
    const hiddenDropdownWrappers = dropdownWrappers.filter(c => hiddenContainers.has(c));
    console.log('[GS4PM Filter] Dropdown filtering: total=' + dropdownWrappers.length + ', visible=' + visibleDropdownWrappers.length + ', hidden=' + hiddenDropdownWrappers.length);
    
    // Debug: log each dropdown item and verify classification
    dropdownWrappers.forEach(wrapper => {
      const option = wrapper.querySelector('[role="option"]');
      const text = option ? option.textContent.trim() : 'unknown';
      const isHidden = hiddenContainers.has(wrapper);
      
      // Double-check which tags match this option
      let matchedTags = [];
      if (option) {
        tags.forEach(tag => {
          try {
            if (option.matches(tag.selector)) {
              matchedTags.push(tag.customer);
            }
          } catch (e) {}
        });
      }
    });
    
    if (dropdownWrappers.length > 0) {
      console.log('[GS4PM Filter] 📞 Calling reorderVirtualizedDropdown from applyFilter (visible:', visibleDropdownWrappers.length, 'hidden:', hiddenDropdownWrappers.length + ')');
      reorderVirtualizedDropdown(visibleDropdownWrappers, hiddenDropdownWrappers);
    } else {
      
      // Clean up any stale dropdown filtering from previous opens
      const staleDropdowns = document.querySelectorAll('[role="listbox"]');
      staleDropdowns.forEach(listbox => {
        const staleWrappers = listbox.querySelectorAll('[role="presentation"][data-gs4pm-orig-top]');
        if (staleWrappers.length > 0) {
          console.log('[GS4PM Filter] Cleaning up', staleWrappers.length, 'stale dropdown wrappers');
          restoreVirtualizedDropdown(Array.from(staleWrappers));
        }
      });
    }
    
    // For regular containers: use display:none
    regularContainers.forEach(container => {
      if (hiddenContainers.has(container)) {
        container.style.display = 'none';
      } else {
        container.style.display = '';
      }
    });

    cachedTags = tags;
  });
}

// Debounce dropdown filtering to avoid progressive filtering as React adds items
let pendingDropdownFilter = null;
// Track which listboxes are currently being filtered to prevent duplicate operations
const filteringListboxes = new WeakSet();

function applyFilterToNode(node) {
  if (!node || !(node instanceof Element)) return;
  if (currentFilterCustomer === 'ALL') return;
  if (!cachedTags.length) return;
  if (isContentAssetsPage()) return;
  if (isTemplatesPage()) return;

  // NEW LOGIC: Hide only items tagged to OTHER customers
  // Show items tagged to current customer + all untagged items
  const containersToHide = new Set();
  const containersToShow = new Set();

  cachedTags.forEach(tag => {
    Array.from(node.querySelectorAll(tag.selector)).forEach(el => {
      const container = getDisplayContainer(el) || el;
      
      if (tag.customer === currentFilterCustomer) {
        // Tagged to current customer - show it
        containersToShow.add(container);
        if (tagging) {
          addBadge(container, tag.customer);
        }
      } else {
        // Tagged to different customer - hide it (unless also tagged to current)
        if (!containersToShow.has(container)) {
          containersToHide.add(container);
        }
      }
    });
  });

  // Check if this node is part of a dropdown or contains dropdown options
  // If so, find the parent listbox and query ALL wrappers from there
  let listboxContainer = null;
  
  if (node.matches('[role="listbox"]')) {
    listboxContainer = node;
  } else if (node.closest('[role="listbox"]')) {
    listboxContainer = node.closest('[role="listbox"]');
  } else if (node.querySelector('[role="listbox"]')) {
    listboxContainer = node.querySelector('[role="listbox"]');
  }
  
  if (listboxContainer) {
    // Prevent duplicate filtering of the same listbox
    if (filteringListboxes.has(listboxContainer)) {
      return; // Already filtering this listbox, skip
    }
    
    // Mark as filtering
    filteringListboxes.add(listboxContainer);
    
    // Cancel any existing retry timeouts from previous dropdown opens
    dropdownRetryTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
    dropdownRetryTimeouts = [];
    
    // Disconnect any existing item observer
    if (dropdownItemObserver) {
      dropdownItemObserver.disconnect();
      dropdownItemObserver = null;
    }
    
    clearTimeout(pendingDropdownFilter);
    
    const filterDropdownWithRetry = (attempt = 1, maxAttempts = 5) => {
      // Prevent duplicate filtering - if already filtering this listbox and this is a new attempt (not a retry), skip
      // Retries (attempt > 1) are allowed to proceed as they're part of the same filtering operation
      if (filteringListboxes.has(listboxContainer) && attempt === 1) {
        console.log('[GS4PM Filter] ⏸️ filterDropdownWithRetry skipped - already filtering this listbox');
        return;
      }
      
      // Log call stack to see what triggered this
      const stack = new Error().stack;
      const caller = stack.split('\n')[2] || 'unknown';
      console.log('[GS4PM Filter] 🔁 filterDropdownWithRetry attempt', attempt, 'called from:', caller.trim());
      
      // Check if listbox still exists (dropdown might have closed)
      if (!document.body.contains(listboxContainer)) {
        console.log('[GS4PM Filter] ⚠️ Dropdown closed during retry, aborting');
        filteringListboxes.delete(listboxContainer);
        return;
      }
      
      // Mark as filtering (only on first attempt to avoid race conditions)
      if (attempt === 1) {
        filteringListboxes.add(listboxContainer);
      }
      // Query FRESH wrappers from DOM (not stale references)
      const freshWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
        wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
      );

      // If virtualization is still hydrating items, retry briefly (when the DOM exposes a total).
      const inferredTotal = inferListboxTotalOptionCount(listboxContainer);
      if (inferredTotal && freshWrappers.length < inferredTotal && attempt < maxAttempts) {
        const delay = Math.min(attempt * 250, 1000);
        const timeoutId = setTimeout(() => filterDropdownWithRetry(attempt + 1, maxAttempts), delay);
        dropdownRetryTimeouts.push(timeoutId);
        return;
      }
      
      // First, make ALL wrappers visible (clean slate)
      freshWrappers.forEach(wrapper => {
        wrapper.style.display = '';
      });
      
      // Categorize based on tags
      const visibleDropdownWrappers = [];
      const hiddenDropdownWrappers = [];
      
      freshWrappers.forEach(wrapper => {
        const option = wrapper.querySelector('[role="option"]');
        if (!option) return;
        
        // Check if this option matches any tag
        let isTaggedToCurrent = false;
        let isTaggedToOther = false;
        
        cachedTags.forEach(tag => {
          try {
            if (option.matches(tag.selector)) {
              if (tag.customer === currentFilterCustomer) {
                isTaggedToCurrent = true;
              } else {
                isTaggedToOther = true;
              }
            }
          } catch (e) {
            // Invalid selector, skip
          }
        });
        
        // Show if: untagged OR tagged to current customer
        // Hide if: tagged ONLY to other customers
        if (isTaggedToOther && !isTaggedToCurrent) {
          hiddenDropdownWrappers.push(wrapper);
        } else {
          // Show untagged items and items tagged to current customer
          visibleDropdownWrappers.push(wrapper);
        }
      });
      
      // Only log if attempt > 1 (retries)
      if (attempt > 1) {
        console.log('[GS4PM Filter] 🔁 Retry attempt', attempt + ':', 'visible =', visibleDropdownWrappers.length, 'hidden =', hiddenDropdownWrappers.length);
      }
      
      // REMOVED: Pre-setting height before filtering was causing React to remove items
      // Instead, we'll filter first, then set height after items are positioned
      // This ensures React has all items rendered before we adjust heights
      
      // Fallback: filter without pre-setting height
      if (visibleDropdownWrappers.length > 0 || hiddenDropdownWrappers.length > 0) {
        console.log('[GS4PM Filter] 📞 Calling reorderVirtualizedDropdown from filterDropdownWithRetry (visible:', visibleDropdownWrappers.length, 'hidden:', hiddenDropdownWrappers.length + ')');
        reorderVirtualizedDropdown(visibleDropdownWrappers, hiddenDropdownWrappers);
        
        // Mark filtering as complete after a delay to allow React to settle
        setTimeout(() => {
          filteringListboxes.delete(listboxContainer);
        }, 1000); // Delay to ensure React settles
      } else {
        // No items to filter, mark as complete immediately
        filteringListboxes.delete(listboxContainer);
      }
    };
    
    // Disconnect any existing item observer
    if (dropdownItemObserver) {
      dropdownItemObserver.disconnect();
    }
    
    // Use MutationObserver to detect when items are added, then filter
    let lastWrapperCount = 0;
    let stableCount = 0;
    
    dropdownItemObserver = new MutationObserver((mutations) => {
      const currentWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
        wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
      );
      
      // If count changed, reset stability counter
      if (currentWrappers.length !== lastWrapperCount) {
        lastWrapperCount = currentWrappers.length;
        stableCount = 0;
        console.log('[GS4PM Filter] 🔍 Item observer: found', currentWrappers.length, 'wrappers');
        return;
      }
      
      // Count is stable, increment counter
      stableCount++;
      
      // If count has been stable for 2 observations (or we reached a known total), filter.
      const inferredTotal = inferListboxTotalOptionCount(listboxContainer);
      if (stableCount >= 2 || (inferredTotal && currentWrappers.length >= inferredTotal)) {
        console.log('[GS4PM Filter] ✅ Item count stable at', currentWrappers.length, 'items, filtering now');
        dropdownItemObserver.disconnect();
        dropdownItemObserver = null;
        filterDropdownWithRetry();
      }
    });
    
    // Start observing for new items
    dropdownItemObserver.observe(listboxContainer, { childList: true, subtree: true });
    
    // Fallback: filter after delay even if observer doesn't trigger
    pendingDropdownFilter = setTimeout(() => {
      if (dropdownItemObserver) {
        dropdownItemObserver.disconnect();
        dropdownItemObserver = null;
      }
      filterDropdownWithRetry();
    }, 1500); // Increased to 1500ms as fallback
    
    // Early return - don't filter yet
    return;
  }

  // Apply visibility for all NON-DROPDOWN containers
  containersToHide.forEach(container => {
    container.style.display = 'none';
  });
  containersToShow.forEach(container => {
    container.style.display = '';
  });
}

// ===== Tagging logic =====

function tagSelectorForCurrentCustomer(selector) {
  if (!selector) return;

  const pageKey = getPageKey();
  safeStorageGet([CURRENT_CUSTOMER_KEY, ACTIVE_FILTER_KEY, pageKey], data => {
    let customer = data[CURRENT_CUSTOMER_KEY];
    const activeFilter = data[ACTIVE_FILTER_KEY];
    const tags = data[pageKey] || [];

    // Fallback: if no explicit current customer, but a specific filter is active, tag against that
    if ((!customer || customer === '__ALL__') && activeFilter && activeFilter !== 'ALL') {
      customer = activeFilter;
    }

    // Fallback: if storage hasn't propagated into this frame yet, use the current tagging-session customer.
    if ((!customer || customer === '__ALL__') && currentTagCustomer) {
      customer = currentTagCustomer;
    }

    if (!customer || customer === '__ALL__') {
      console.log('[GS4PM Filter] No current customer/filter selected; ignoring tag request.');
      try { showFilterCycleToast('Tagging: select a customer first'); } catch (e) {}
      return;
    }

    const existingIndex = tags.findIndex(t => t.selector === selector && t.customer === customer);

    if (existingIndex !== -1) {
      // Toggle OFF: remove existing tag
      tags.splice(existingIndex, 1);
      console.log('[GS4PM Filter] Removed tag for customer', customer, selector);
      try { showFilterCycleToast(`Untagged: ${customer}`); } catch (e) {}
    } else {
      // Toggle ON: add new tag
      tags.push({ selector, customer });
      console.log('[GS4PM Filter] Tagged selector for customer', customer, selector);
      try { showFilterCycleToast(`Tagged: ${customer}`); } catch (e) {}
    }

    if (chrome.runtime && chrome.runtime.id) {
      safeStorageSet({ [pageKey]: tags }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[GS4PM Filter] Could not save tags:', chrome.runtime.lastError.message);
          try { showFilterCycleToast('Tagging failed: extension error'); } catch (e) {}
          return;
        }
        cachedTags = tags;
        // Re-read active filter in *this frame* to avoid cross-frame state drift.
        safeStorageGet([ACTIVE_FILTER_KEY], (f) => {
          const active = f[ACTIVE_FILTER_KEY] || 'ALL';
          currentFilterCustomer = active;
          applyFilter(active);
          if (shouldRenderBadges()) refreshBadges();
          try { scheduleBrandLibraryCardLabelRefresh(); } catch (e) {}
        });
      });
    } else {
      console.log('[GS4PM Filter] Cannot save tags - extension context unavailable');
      try { showFilterCycleToast('Tagging failed: reload page'); } catch (e) {}
    }
  });
}

// ===== Brand library cards: table tagging + hover highlight target =====

// Brand Library card labels rendered via an overlay layer (same approach as the
// blue dotted hover outline): we do NOT modify any shadow roots or card internals.
// This is the most reliable method under virtualization + Spectrum web components.
const BRAND_CARD_LABEL_STYLE_ID = 'gs4pm-brand-card-label-style';
const BRAND_CARD_LABEL_LAYER_ID = 'gs4pm-brand-card-label-layer';
const BRAND_CARD_LABEL_CLASS = 'gs4pm-brand-card-label';
const BRAND_CARD_SELECTOR = '[data-test-id^="library-grid-mosaic-card-"]';
let brandLibraryLabelLayerEl = null;
let brandLibraryLabelObserver = null;
let brandLibraryLabelObservedGrid = null;
let brandLibraryLabelRefreshTimeout = null;
let brandLibraryLabelScheduled = false;
let brandLibraryLabelInitAttempts = 0;
let brandLibraryLabelInitTimeout = null;
const brandLibraryLabelByCard = new Map(); // Element -> HTMLDivElement

function ensureBrandLibraryCardLabelStyles() {
  if (document.getElementById(BRAND_CARD_LABEL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = BRAND_CARD_LABEL_STYLE_ID;
  style.textContent = `
    /* Overlay layer for brand labels */
    #${BRAND_CARD_LABEL_LAYER_ID}{
      position: fixed !important;
      left: 0 !important;
      top: 0 !important;
      width: 0 !important;
      height: 0 !important;
      z-index: 2147483646 !important;
      pointer-events: none !important;
    }
    #${BRAND_CARD_LABEL_LAYER_ID} .${BRAND_CARD_LABEL_CLASS}{
      position: fixed !important;
      left: 0;
      top: 0;
      transform: translate(-9999px, -9999px);
      pointer-events: none !important;
      padding: 4px 8px !important;
      border-radius: 999px !important;
      background: rgba(0, 0, 0, 0.72) !important;
      border: 1px solid rgba(46, 224, 113, 0.28) !important;
      color: rgba(255, 255, 255, 0.92) !important;
      font: 750 11px system-ui, -apple-system, Segoe UI, sans-serif !important;
      line-height: 1.15 !important;
      letter-spacing: 0.01em !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      box-shadow: 0 10px 22px rgba(46,224,113,0.10), 0 10px 22px rgba(0,0,0,0.24) !important;
      backdrop-filter: blur(6px) !important;
      -webkit-backdrop-filter: blur(6px) !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function clearBrandLibraryCardLabels({ removeLayer = false } = {}) {
  // Remove all label elements and clear tracking.
  try {
    brandLibraryLabelByCard.forEach((labelEl) => {
      try { labelEl?.remove?.(); } catch (e) {}
    });
  } catch (e) {}
  brandLibraryLabelByCard.clear();

  if (removeLayer) {
    try { brandLibraryLabelLayerEl?.remove?.(); } catch (e) {}
    brandLibraryLabelLayerEl = null;
  } else if (brandLibraryLabelLayerEl && brandLibraryLabelLayerEl.isConnected) {
    // Keep the layer but empty it (safety).
    try { brandLibraryLabelLayerEl.innerHTML = ''; } catch (e) {}
  }

  // If the grid is gone, disconnect the observer so we don’t leak work.
  try { brandLibraryLabelObserver?.disconnect?.(); } catch (e) {}
  brandLibraryLabelObserver = null;
  brandLibraryLabelObservedGrid = null;
}

function getBrandLibraryGrid() {
  return deepQuerySelector('#library-grid[data-test-id="library-grid"]');
}

function ensureBrandLibraryLabelLayer() {
  if (brandLibraryLabelLayerEl && brandLibraryLabelLayerEl.isConnected) return brandLibraryLabelLayerEl;
  const existing = document.getElementById(BRAND_CARD_LABEL_LAYER_ID);
  if (existing) {
    brandLibraryLabelLayerEl = existing;
    return brandLibraryLabelLayerEl;
  }
  const layer = document.createElement('div');
  layer.id = BRAND_CARD_LABEL_LAYER_ID;
  (document.body || document.documentElement).appendChild(layer);
  brandLibraryLabelLayerEl = layer;
  return layer;
}

function deepQuerySelectorAll(selector, root = document) {
  // Collect matches from root + any open shadow roots beneath it.
  const results = new Set();
  const visited = new Set();
  const stack = [];

  const enqueueShadowRoots = (node) => {
    if (!node || typeof node.querySelectorAll !== 'function') return;
    let all;
    try {
      all = node.querySelectorAll('*');
    } catch (e) {
      return;
    }
    all.forEach((el) => {
      const sr = el && el.shadowRoot;
      if (sr && !visited.has(sr)) {
        visited.add(sr);
        stack.push(sr);
      }
    });
  };

  const addMatches = (node) => {
    if (!node || typeof node.querySelectorAll !== 'function') return;
    try {
      node.querySelectorAll(selector).forEach((el) => results.add(el));
    } catch (e) {}
  };

  addMatches(root);
  enqueueShadowRoots(root);
  while (stack.length) {
    const sr = stack.pop();
    addMatches(sr);
    enqueueShadowRoots(sr);
  }

  return Array.from(results);
}

function getBrandKeyFromCard(cardEl) {
  if (!(cardEl instanceof Element)) return null;
  // First try direct/closest (fast path)
  try {
    const direct = cardEl.getAttribute('data-key');
    if (direct) return direct;
  } catch {}
  try {
    const c = cardEl.closest('div.library-list-item-container[data-key]');
    const k = c?.getAttribute('data-key');
    if (k) return k;
  } catch {}

  // Cross shadow boundaries by walking up through shadow hosts.
  let node = cardEl;
  for (let i = 0; i < 40 && node; i++) {
    if (node instanceof Element) {
      const k = node.getAttribute('data-key');
      if (k) return k;
      if (node.parentElement) {
        node = node.parentElement;
        continue;
      }
      const root = node.getRootNode?.();
      if (root && root instanceof ShadowRoot && root.host) {
        node = root.host;
        continue;
      }
    }
    break;
  }
  return null;
}

function getBrandLibraryCardLabel(cardEl) {
  if (!(cardEl instanceof Element)) return 'Brand';
  const aria = (cardEl.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  if (aria) return aria;
  try {
    const heading = cardEl.querySelector('[slot="heading"]');
    const txt = (heading?.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt) return txt;
  } catch (e) {}
  return 'Brand';
}

function buildCustomerSetByBrandKey(tags) {
  const map = new Map(); // key -> Set(customers)
  (tags || []).forEach((t) => {
    const customer = t?.customer;
    const key = extractAttrFromSelector(t?.selector, 'data-key');
    if (!customer || !key) return;
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(customer);
  });
  return map;
}

function upsertBrandLibraryCardLabel(cardEl, text) {
  if (!(cardEl instanceof Element)) return;
  const layer = ensureBrandLibraryLabelLayer();

  let labelEl = brandLibraryLabelByCard.get(cardEl) || null;
  if (!labelEl || !labelEl.isConnected) {
    labelEl = document.createElement('div');
    labelEl.className = BRAND_CARD_LABEL_CLASS;
    labelEl.setAttribute('aria-hidden', 'true');
    layer.appendChild(labelEl);
    brandLibraryLabelByCard.set(cardEl, labelEl);
  }

  labelEl.textContent = String(text || '').trim() || 'Brand';

  const rect = cardEl.getBoundingClientRect?.();
  if (!rect || rect.width < 2 || rect.height < 2) {
    labelEl.style.transform = 'translate(-9999px, -9999px)';
    return;
  }

  // Skip offscreen cards (virtualization can keep lots of nodes around).
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  if (rect.bottom < -40 || rect.top > vh + 40 || rect.right < -40 || rect.left > vw + 40) {
    labelEl.style.transform = 'translate(-9999px, -9999px)';
    return;
  }

  const x = Math.max(0, rect.left + 8);
  const y = Math.max(0, rect.top + 8);
  labelEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  // Clamp width to card width so long customer lists don't overflow.
  const maxW = Math.max(80, Math.round(rect.width - 16));
  labelEl.style.maxWidth = `${maxW}px`;
}

function removeBrandLibraryCardLabel(cardEl) {
  const labelEl = brandLibraryLabelByCard.get(cardEl);
  if (labelEl && labelEl.remove) labelEl.remove();
  brandLibraryLabelByCard.delete(cardEl);
}

function applyBrandLibraryCardLabels(root = document) {
  // If we're neither tagging nor filtering, don't show persistent brand labels.
  if (!shouldRenderBrandLibraryCardLabels()) {
    clearBrandLibraryCardLabels({ removeLayer: false });
    return;
  }

  const grid = getBrandLibraryGrid();
  if (!grid) {
    // If we navigated away from Brands Library, ensure labels don’t “stick” on screen.
    clearBrandLibraryCardLabels({ removeLayer: false });
    return;
  }
  ensureBrandLibraryCardLabelStyles();
  ensureBrandLibraryLabelLayer();

  // Performance: scope to grid or a node within grid; include open shadow roots under that scope.
  let scope = grid;
  if (root instanceof Element && grid.contains(root)) scope = root;

  const tagMap = buildCustomerSetByBrandKey(cachedTags);

  const candidates = [];
  if (scope instanceof Element && scope.matches(BRAND_CARD_SELECTOR)) candidates.push(scope);
  deepQuerySelectorAll(BRAND_CARD_SELECTOR, scope).forEach((el) => candidates.push(el));

  const currentCards = new Set();

  candidates.forEach((el) => {
    if (!(el instanceof Element)) return;
    const testId = el.getAttribute('data-test-id') || '';
    if (!testId || !testId.startsWith('library-grid-mosaic-card-')) return;
    currentCards.add(el);

    const key = getBrandKeyFromCard(el);
    const customers = key ? Array.from(tagMap.get(key) || []) : [];

    // Only show a label when the brand is tagged (this matches “see what it’s tagged as”).
    if (!customers.length) {
      removeBrandLibraryCardLabel(el);
      return;
    }

    const text = customers.sort().join(', ') || getBrandLibraryCardLabel(el);
    upsertBrandLibraryCardLabel(el, text);
  });

  // Cleanup labels for cards that were recycled/removed.
  // Only do a full cleanup when we scanned the whole grid; avoid removing labels
  // for cards outside a partial subtree refresh.
  if (scope === grid) {
    Array.from(brandLibraryLabelByCard.keys()).forEach((card) => {
      if (!(card instanceof Element) || !card.isConnected || !currentCards.has(card)) {
        removeBrandLibraryCardLabel(card);
      }
    });
  } else {
    // Still clean up disconnected cards (safe).
    Array.from(brandLibraryLabelByCard.keys()).forEach((card) => {
      if (!(card instanceof Element) || !card.isConnected) removeBrandLibraryCardLabel(card);
    });
  }
}

function scheduleBrandLibraryCardLabelRefresh(root) {
  if (brandLibraryLabelScheduled) return;
  brandLibraryLabelScheduled = true;

  // Small debounce for bursts of mutations.
  if (brandLibraryLabelRefreshTimeout) clearTimeout(brandLibraryLabelRefreshTimeout);
  brandLibraryLabelRefreshTimeout = setTimeout(() => {
    requestAnimationFrame(() => {
      brandLibraryLabelScheduled = false;
      try {
        applyBrandLibraryCardLabels(root || getBrandLibraryGrid() || document);
      } catch (e) {}
    });
  }, 60);
}

function initBrandLibraryCardLabels() {
  const grid = getBrandLibraryGrid();
  if (!grid) {
    // Grid can mount late (SPA + virtualization). Retry briefly.
    if (brandLibraryLabelInitAttempts < 20) {
      brandLibraryLabelInitAttempts++;
      if (brandLibraryLabelInitTimeout) clearTimeout(brandLibraryLabelInitTimeout);
      brandLibraryLabelInitTimeout = setTimeout(() => {
        try { initBrandLibraryCardLabels(); } catch (e) {}
      }, 250);
    }
    return;
  }
  brandLibraryLabelInitAttempts = 0;
  if (brandLibraryLabelInitTimeout) {
    clearTimeout(brandLibraryLabelInitTimeout);
    brandLibraryLabelInitTimeout = null;
  }

  // Apply once immediately.
  scheduleBrandLibraryCardLabelRefresh(grid);

  // Attach a scoped observer to handle virtualization/remounts.
  if (brandLibraryLabelObserver && brandLibraryLabelObservedGrid === grid && grid.isConnected) return;
  try {
    brandLibraryLabelObserver?.disconnect?.();
  } catch (e) {}

  brandLibraryLabelObservedGrid = grid;
  brandLibraryLabelObserver = new MutationObserver((mutations) => {
    // Debounce to avoid thrashing under rapid virtualization churn.
    let shouldRefresh = false;
    for (const m of mutations) {
      if (m.type === 'childList' && (m.addedNodes?.length || m.removedNodes?.length)) {
        shouldRefresh = true;
        break;
      }
      if (m.type === 'attributes') {
        shouldRefresh = true;
        break;
      }
    }
    if (!shouldRefresh) return;
    scheduleBrandLibraryCardLabelRefresh(grid);
  });

  brandLibraryLabelObserver.observe(grid, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'data-test-id']
  });
}

function getBrandLibraryHoverTarget(dropTargetEl) {
  if (!(dropTargetEl instanceof Element)) return null;
  if (!dropTargetEl.matches('div[data-test-id^="library-drop-target"]')) return dropTargetEl;
  // Brand library mosaic: outline the actual <sp-card...> host for a crisp highlight.
  return dropTargetEl.querySelector('[data-test-id^="library-grid-mosaic-card-"]') || dropTargetEl;
}

function tagBrandLibraryAsTable() {
  const grid = getBrandLibraryGrid();
  if (!grid) return;

  const containers = Array.from(
    grid.querySelectorAll('div.library-list-item-container[data-type="library"][data-key]')
  );
  if (!containers.length) return;

  // Mark the grid once (preserve any pre-existing role).
  if (grid.dataset.gs4pmBrandOrigRole === undefined) {
    grid.dataset.gs4pmBrandOrigRole = grid.getAttribute('role') || '';
  }
  grid.dataset.gs4pmTable = 'brand-library';
  grid.setAttribute('role', 'table');

  const parsePx = (v) => {
    if (!v) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  // Determine columns/rows based on absolute-positioned top/left values.
  const leftVals = containers
    .map(c => parsePx(c.style.left))
    .filter(v => typeof v === 'number')
    .sort((a, b) => a - b);
  const topVals = containers
    .map(c => parsePx(c.style.top))
    .filter(v => typeof v === 'number')
    .sort((a, b) => a - b);

  const dedupeNear = (vals, tol = 10) => {
    const out = [];
    vals.forEach(v => {
      const last = out[out.length - 1];
      if (last === undefined || Math.abs(v - last) > tol) out.push(v);
    });
    return out;
  };

  const cols = dedupeNear(leftVals);
  const rows = dedupeNear(topVals);
  const colCount = Math.max(1, cols.length || 1);
  const rowCount = Math.max(1, rows.length || containers.length);
  grid.setAttribute('aria-colcount', String(colCount));
  grid.setAttribute('aria-rowcount', String(rowCount));

  const nearestIndex1 = (anchors, value) => {
    if (!anchors.length) return 1;
    let bestI = 0;
    let bestD = Infinity;
    anchors.forEach((a, i) => {
      const d = Math.abs(a - value);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    });
    return bestI + 1; // 1-based for ARIA
  };

  containers.forEach(container => {
    const left = parsePx(container.style.left) ?? 0;
    const top = parsePx(container.style.top) ?? 0;
    const rowIndex = nearestIndex1(rows, top);
    const colIndex = nearestIndex1(cols, left);

    container.dataset.gs4pmTable = 'brand-library';
    container.dataset.gs4pmRow = String(rowIndex);
    container.dataset.gs4pmCol = String(colIndex);

    // Assign the "cell" role to the container (least invasive; avoids re-wrapping).
    if (container.dataset.gs4pmBrandOrigRole === undefined) {
      container.dataset.gs4pmBrandOrigRole = container.getAttribute('role') || '';
    }
    container.setAttribute('role', 'cell');
    container.setAttribute('aria-rowindex', String(rowIndex));
    container.setAttribute('aria-colindex', String(colIndex));
  });
}

function cleanupBrandLibraryTable() {
  const grid = getBrandLibraryGrid();
  if (grid && grid.dataset.gs4pmTable === 'brand-library') {
    const orig = grid.dataset.gs4pmBrandOrigRole || '';
    if (orig) grid.setAttribute('role', orig);
    else grid.removeAttribute('role');
    grid.removeAttribute('aria-colcount');
    grid.removeAttribute('aria-rowcount');
    delete grid.dataset.gs4pmTable;
    delete grid.dataset.gs4pmBrandOrigRole;
  }

  document
    .querySelectorAll('div.library-list-item-container[data-type="library"][data-key][data-gs4pm-table="brand-library"]')
    .forEach(container => {
      const orig = container.dataset.gs4pmBrandOrigRole || '';
      if (orig) container.setAttribute('role', orig);
      else container.removeAttribute('role');
      container.removeAttribute('aria-rowindex');
      container.removeAttribute('aria-colindex');
      delete container.dataset.gs4pmTable;
      delete container.dataset.gs4pmRow;
      delete container.dataset.gs4pmCol;
      delete container.dataset.gs4pmBrandOrigRole;
    });
}

function startTagging(customer) {
  if (tagging) return;
  tagging = true;
  currentTagCustomer = customer;

  showTaggingBanner();

  const clearHoverOutline = () => {
    if (lastOutlinedContainer) {
      lastOutlinedContainer = null;
    }
    hideHoverHighlight();
  };

  const hasCards = Boolean(
    document.querySelector('article[data-omega-attribute-referenceid], article[data-testid^="card-"]')
  );

  const getHoverTarget = el => {
    if (!el || !(el instanceof Element)) return null;
    const card = el.closest && el.closest('article[data-omega-attribute-referenceid], article[data-testid^="card-"], div[data-omega-element="explore-card"]');
    if (card) return card;

    // Content/assets + templates: outline the stable container so it's obvious what will be tagged.
    const contentContainer = el.closest && el.closest('[data-item-id],[data-omega-attribute-contentid]');
    if (contentContainer) return contentContainer;
    if (!hasCards && (el.getAttribute('role') === 'option' || el.closest('[role="option"]'))) {
      return getDisplayContainer(el) || el;
    }
    if (!hasCards && el.matches('div[data-test-id^="library-drop-target"]')) {
      return getBrandLibraryHoverTarget(el);
    }
    return null;
  };

  const applyHoverOutline = target => {
    if (!target) {
      clearHoverOutline();
      return;
    }
    if (lastOutlinedContainer && lastOutlinedContainer !== target) {
      clearHoverOutline();
    }
    lastOutlinedContainer = target;
    positionHoverHighlight(lastOutlinedContainer);
  };

  repositionHighlight = () => {
    if (!tagging) return;
    if (!lastOutlinedContainer || !(lastOutlinedContainer instanceof Element)) return;
    positionHoverHighlight(lastOutlinedContainer);
  };

  escapeHandler = (e) => {
    if (!tagging) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    // Stop tagging in all frames (GenStudio runs inside iframes).
    // Background can infer tabId from sender.tab and broadcast to all frames.
    if (chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({ type: 'ESC_STOP_TAGGING' }, () => {
        // Even if background isn't available, stop locally.
        stopTagging();
        chrome.storage.local.set({ [TAGGING_ENABLED_KEY]: false });
      });
    } else {
      stopTagging();
    }
  };

  hoverHandler = e => {
    if (!tagging) return;
    // Allow interacting with the workspace bar while tagging is enabled.
    if (e?.target instanceof Element && e.target.closest && e.target.closest(`#${OVERLAY_ID}`)) return;
    const el = findTaggableElement(e);
    // Keep brand library table tagging up-to-date while hovering (virtualized DOM can recycle nodes).
    tagBrandLibraryAsTable();
    applyHoverOutline(getHoverTarget(el));
  };

  clickHandler = e => {
    if (!tagging) return;
    // Allow interacting with the workspace bar while tagging is enabled.
    if (e?.target instanceof Element && e.target.closest && e.target.closest(`#${OVERLAY_ID}`)) return;
    // Some GS surfaces (notably brand library tiles) can suppress native clicks.
    // We tag on pointerup and ignore the follow-up click to avoid double toggles.
    if (Date.now() - lastTagPointerUpAt < 450) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const taggableEl = findTaggableElement(e);
    if (!taggableEl) return;

    clearHoverOutline();

    const selector = getUniqueSelector(taggableEl);
    console.log('[GS4PM Filter] Click-to-tag selector', selector);
    tagSelectorForCurrentCustomer(selector);
  };

  // Pointer-based tagging: more reliable than `click` on draggable / virtualized tiles.
  // We tag on pointerup with a small movement threshold to avoid tagging during drag.
  const pointerState = {
    active: false,
    pointerId: null,
    x: 0,
    y: 0,
  };

  pointerDownHandler = (e) => {
    if (!tagging) return;
    if (e?.target instanceof Element && e.target.closest && e.target.closest(`#${OVERLAY_ID}`)) return;
    // Only primary button / primary pointer.
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (e.isPrimary === false) return;

    pointerState.active = true;
    pointerState.pointerId = e.pointerId;
    pointerState.x = typeof e.clientX === 'number' ? e.clientX : 0;
    pointerState.y = typeof e.clientY === 'number' ? e.clientY : 0;
  };

  pointerUpHandler = (e) => {
    if (!tagging) return;
    if (!pointerState.active) return;
    if (pointerState.pointerId !== null && e.pointerId !== pointerState.pointerId) return;
    if (e?.target instanceof Element && e.target.closest && e.target.closest(`#${OVERLAY_ID}`)) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (e.isPrimary === false) return;

    const dx = (typeof e.clientX === 'number' ? e.clientX : 0) - pointerState.x;
    const dy = (typeof e.clientY === 'number' ? e.clientY : 0) - pointerState.y;
    pointerState.active = false;
    pointerState.pointerId = null;

    // Ignore if the pointer moved meaningfully (likely drag/scroll/selection).
    if ((dx * dx + dy * dy) > (8 * 8)) return;

    // Mirror click-to-tag behavior.
    e.preventDefault();
    e.stopPropagation();

    const taggableEl = findTaggableElement(e);
    if (!taggableEl) return;

    clearHoverOutline();

    const selector = getUniqueSelector(taggableEl);
    console.log('[GS4PM Filter] PointerUp-to-tag selector', selector);
    lastTagPointerUpAt = Date.now();
    tagSelectorForCurrentCustomer(selector);
  };

  // Use pointermove so highlight is stable across shadow DOM retargeting.
  document.addEventListener('pointermove', hoverHandler, true);
  document.addEventListener('pointerdown', pointerDownHandler, true);
  document.addEventListener('pointerup', pointerUpHandler, true);
  document.addEventListener('click', clickHandler, true);
  document.addEventListener('keydown', escapeHandler, true);
  window.addEventListener('scroll', repositionHighlight, true);
  window.addEventListener('resize', repositionHighlight, false);
  // Banner is rendered only in top frame, so only top frame needs resize handling.
  if (window.top === window) {
    if (bannerResizeHandler) {
      window.removeEventListener('resize', bannerResizeHandler, false);
    }
    bannerResizeHandler = () => positionTaggingBanner();
    window.addEventListener('resize', bannerResizeHandler, false);
  }

  console.log('[GS4PM Filter] Tagging mode ON for customer:', customer, 'in frame', window.location.href);

  loadTags(() => {
    refreshBadges();
    // Brand library card labels are an overlay that won’t re-render unless we
    // explicitly schedule it (the virtualized grid often doesn't mutate).
    try { initBrandLibraryCardLabels(); } catch (e) {}
    try { scheduleBrandLibraryCardLabelRefresh(); } catch (e) {}
  });
}

function stopTagging() {
  tagging = false;
  currentTagCustomer = null;

  if (hoverHandler) document.removeEventListener('pointermove', hoverHandler, true);
  if (pointerDownHandler) document.removeEventListener('pointerdown', pointerDownHandler, true);
  if (pointerUpHandler) document.removeEventListener('pointerup', pointerUpHandler, true);
  if (clickHandler) document.removeEventListener('click', clickHandler, true);
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
  }
  if (bannerResizeHandler) {
    window.removeEventListener('resize', bannerResizeHandler, false);
  }
  if (repositionHighlight) {
    window.removeEventListener('scroll', repositionHighlight, true);
    window.removeEventListener('resize', repositionHighlight, false);
  }

  hoverHandler = null;
  clickHandler = null;
  pointerDownHandler = null;
  pointerUpHandler = null;
  escapeHandler = null;
  repositionHighlight = null;
  bannerResizeHandler = null;

  if (lastOutlinedContainer) {
    lastOutlinedContainer = null;
  }
  hideHoverHighlight();

  // Remove ARIA/data "table" tagging applied for brand library cards (only while tagging mode is active).
  try { cleanupBrandLibraryTable(); } catch (e) {}

  // Tags/badges should never persist outside tagging mode (even if a filter is active).
  removeAllBadges(true);

  // Brand library labels should never persist outside tagging mode.
  try { clearBrandLibraryCardLabels({ removeLayer: false }); } catch (e) {}
  removeTaggingBanner();

  console.log('[GS4PM Filter] Tagging mode OFF in frame', window.location.href);
}

function showTaggingBanner() {
  // Avoid duplicate banners when content script runs in multiple iframes.
  if (window.top !== window) return;
  if (document.getElementById(TAGGING_BANNER_ID)) return;
  const banner = document.createElement('div');
  banner.id = TAGGING_BANNER_ID;
  banner.textContent = 'Press Esc to exit tagging mode';
  banner.style.position = 'fixed';
  banner.style.left = '0px'; // positioned by positionTaggingBanner()
  banner.style.bottom = '28px'; // may be overridden in positionTaggingBanner()
  banner.style.transform = 'translateX(-50%)';
  banner.style.padding = '10px 14px';
  banner.style.borderRadius = '999px';
  banner.style.background = 'rgba(0, 0, 0, 0.55)';
  banner.style.border = '1px solid rgba(255, 255, 255, 0.22)';
  banner.style.color = '#ffffff';
  banner.style.fontSize = '14px';
  banner.style.fontWeight = '650';
  banner.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  banner.style.letterSpacing = '0.02em';
  banner.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.25)';
  banner.style.backdropFilter = 'blur(6px)';
  banner.style.textShadow = '0 1px 2px rgba(0, 0, 0, 0.35)';
  banner.style.pointerEvents = 'none';
  banner.style.zIndex = '2147483647';
  (document.body || document.documentElement).appendChild(banner);
  positionTaggingBanner();
}

function removeTaggingBanner() {
  const banner = document.getElementById(TAGGING_BANNER_ID);
  if (banner) banner.remove();
}

function detectLeftNavWidth() {
  const vh = window.innerHeight || 0;
  const maxReasonable = Math.min(360, Math.floor((window.innerWidth || 0) * 0.6));

  const nodes = new Set();
  document.querySelectorAll(
    'nav, aside, [role="navigation"], [aria-label*="nav" i], [class*="nav"], [class*="Nav"], [class*="sidebar"], [class*="Sidebar"], [class*="rail"], [class*="Rail"]'
  ).forEach(n => nodes.add(n));
  // Many SPAs mount fixed rails as body children.
  (document.body?.children ? Array.from(document.body.children) : []).forEach(n => nodes.add(n));

  let best = 0;
  nodes.forEach((el) => {
    if (!(el instanceof Element)) return;
    const cs = window.getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
    const rect = el.getBoundingClientRect();
    if (rect.left > 1) return;
    if (rect.top > 1) return;
    if (rect.height < vh * 0.7) return;
    if (rect.width < 48) return;
    if (rect.width > maxReasonable) return;
    best = Math.max(best, rect.width);
  });

  return Math.round(best);
}

function positionTaggingBanner() {
  const banner = document.getElementById(TAGGING_BANNER_ID);
  if (!banner) return;

  // When the workspace bar is visible (or a custom dropdown is open),
  // place the banner at the top so it never blocks the bar/menu.
  const overlay = document.getElementById(OVERLAY_ID);
  const overlayVisible = overlay && overlay.getAttribute('data-hidden') !== 'true';
  const anyMenuOpen = overlay && overlay.querySelector('.dd[data-open="true"]');
  if (overlayVisible || anyMenuOpen) {
    banner.style.top = '14px';
    banner.style.bottom = '';
  } else {
    banner.style.top = '';
    banner.style.bottom = '28px';
  }

  const navW = detectLeftNavWidth();
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const contentW = Math.max(0, vw - navW);
  const centerX = navW + contentW / 2;
  banner.style.left = `${Math.round(centerX)}px`;
}

// ===== Right-click tracking =====

document.addEventListener('contextmenu', (e) => {
  const el = findTaggableElement(e);
  if (!el) {
    lastRightClickedSelector = null;
    // Right-clicking whitespace/non-cards is common in GenStudio; keep this silent.
    // (Chrome's Extensions "Errors" UI surfaces console.warn entries, which is noisy.)
    return;
  }
  lastRightClickedSelector = getUniqueSelector(el);
  console.log('[GS4PM Filter] Recorded right-click on selector', lastRightClickedSelector, 'in frame', window.location.href);
}, true);

// ===== Message handler =====

if (chrome.runtime && chrome.runtime.id) {
  chrome.runtime.onMessage.addListener(msg => {
  console.log('[GS4PM Filter] Message received in frame', window.location.href, msg);
  if (msg.type === 'START_TAGGING') {
    startTagging(msg.customer);
  } else if (msg.type === 'STOP_TAGGING') {
    stopTagging();
  } else if (msg.type === 'SET_FILTER') {
    const customer = msg.customer === 'ALL' ? 'ALL' : msg.customer;
    
    // Don't re-filter if the filter hasn't actually changed
    if (currentFilterCustomer === customer) {
      console.log('[GS4PM Filter] Filter unchanged, skipping re-apply:', customer);
      return;
    }
    
    currentFilterCustomer = customer;
    // Persist (best effort) and apply immediately in this frame.
    safeStorageSet({ [ACTIVE_FILTER_KEY]: customer }, () => {
      applyFilter(customer);
      if (shouldRenderBadges()) refreshBadges();
      // Filtering can hide/move cards without DOM mutations; refresh label overlays explicitly.
      try { scheduleBrandLibraryCardLabelRefresh(); } catch (e) {}
    });
  } else if (msg.type === 'TAG_LAST_RIGHT_CLICKED') {
    if (lastRightClickedSelector) {
      console.log('[GS4PM Filter] Tagging last right-clicked selector', lastRightClickedSelector, 'in frame', window.location.href);
      tagSelectorForCurrentCustomer(lastRightClickedSelector);
    } else {
      console.warn('[GS4PM Filter] No right-clicked element recorded to tag.');
    }
  } else if (msg.type === 'SET_OVERLAY_VISIBLE') {
    // Only the top frame owns the workspace bar DOM.
    if (!isTopFrame()) return;
    try { ensureWorkspaceBar(); } catch {}
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      const visible = !!msg.visible;
      overlay.setAttribute('data-hidden', visible ? 'false' : 'true');
      if (visible) {
        try { overlay.focus(); } catch {}
      }
    }
  }
  });
} else {
  console.log('[GS4PM Filter] Message listener not registered - extension context unavailable');
}

// React when storage filter changes from another tab/popup
if (chrome.runtime && chrome.runtime.id) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[TAGGING_ENABLED_KEY]) {
      const enabled = !!changes[TAGGING_ENABLED_KEY].newValue;
      if (!enabled) {
        try { stopTagging(); } catch (e) {}
      } else {
        // If a tab/frame missed the broadcast, recover from storage state.
        safeStorageGet([CURRENT_CUSTOMER_KEY], (data) => {
          const c = data[CURRENT_CUSTOMER_KEY];
          if (!c || c === '__ALL__' || c === 'ALL') return;
          try { startTagging(c); } catch (e) {}
        });
      }
    }
    if (changes[ACTIVE_FILTER_KEY]) {
      const newVal = changes[ACTIVE_FILTER_KEY].newValue || 'ALL';
      console.log('[GS4PM Filter] ACTIVE_FILTER_KEY changed, applying:', newVal, 'in frame', window.location.href);
      currentFilterCustomer = newVal;
      applyFilter(newVal);
      try { scheduleBrandLibraryCardLabelRefresh(); } catch (e) {}
      
      // Also explicitly re-filter any open dropdowns (in case timing is off)
      setTimeout(() => {
        console.log('[GS4PM Filter] Re-scanning for open dropdowns after filter change...');
        const openDropdowns = document.querySelectorAll('[role="listbox"]');
        openDropdowns.forEach(listbox => {
          console.log('[GS4PM Filter] Found open dropdown, re-filtering...');
          applyFilterToNode(listbox.parentElement);
        });
      }, 100);
    }
  });
} else {
  console.log('[GS4PM Filter] Storage change listener not registered - extension context unavailable');
}

// ===== Mutation observer: keep new nodes filtered & badged =====

let dropdownCheckTimeout = null;
let badgeRefreshScheduled = false;
let brandFilterRefreshScheduled = false;

function scheduleBadgeRefresh() {
  if (!shouldRenderBadges()) return;
  if (!cachedTags.length) return;
  if (badgeRefreshScheduled) return;
  badgeRefreshScheduled = true;
  requestAnimationFrame(() => {
    badgeRefreshScheduled = false;
    refreshBadges();
  });
}

function scheduleBrandFilterRefresh() {
  if (brandFilterRefreshScheduled) return;
  if (!isBrandLibraryPage()) return;
  if (!currentFilterCustomer || currentFilterCustomer === 'ALL') return;
  brandFilterRefreshScheduled = true;
  requestAnimationFrame(() => {
    brandFilterRefreshScheduled = false;
    // Re-apply brand filtering to handle virtualization re-mounts.
    updateBrandLibraryCssFilter(currentFilterCustomer, cachedTags);
    try { scheduleBrandLibraryCardLabelRefresh(); } catch (e) {}
  });
}

const observer = new MutationObserver((mutations) => {
  // Most of the time, we can skip work if there are no tags.
  // But if a brand filter is active, we still need to remove/reinsert brand tiles as they mount.
  const needsBrandFiltering =
    currentFilterCustomer && currentFilterCustomer !== 'ALL' && isBrandLibraryPage();
  if (!cachedTags.length && !needsBrandFiltering) return;
  
  let hasDropdownMutation = false;
  
  mutations.forEach(m => {
    if (m.type === 'attributes') {
      // Content/assets + templates reuse DOM nodes; re-apply badges when ids change.
      scheduleBadgeRefresh();
      scheduleBrandFilterRefresh();
      return;
    }
    m.addedNodes.forEach(node => {
      // Check if this is a dropdown-related node FIRST
      if (node instanceof Element) {
        // Check if this node is part of a dropdown structure
        const isDropdownContainer = node.matches('[role="listbox"], [role="presentation"]') || 
                                    node.querySelector('[role="listbox"], [role="option"]');
        
        // Check if this node's parent is a dropdown (catches individual option wrappers)
        const parentIsDropdown = node.parentElement?.closest('[role="listbox"], [role="presentation"]');
        
        // Check if this node contains or will contain dropdown options
        const willContainOptions = node.getAttribute('role') === 'presentation' && 
                                   (node.style.position === 'absolute' || !node.style.position);
        
        if (isDropdownContainer || parentIsDropdown || willContainOptions) {
          hasDropdownMutation = true;
          
          // Find the listbox and call applyFilterToNode on it
          // The debounce inside applyFilterToNode will handle accumulation
          const listbox = node.matches('[role="listbox"]') ? node :
                         node.closest('[role="listbox"]') || 
                         node.querySelector('[role="listbox"]');
          
          if (listbox) {
            // Skip if already filtering this listbox
            if (!filteringListboxes.has(listbox)) {
              applyFilterToNode(listbox);
            }
          }
          
          // Don't also filter this node as a regular node
          return;
        }
      }
      
      // For non-dropdown nodes, filter immediately
      applyFilterToNode(node);
      // Brands grid virtualization: re-apply hide/show when brand tiles mount.
      if (
        node instanceof Element &&
        (node.id === 'library-grid' ||
         node.matches?.('#library-grid, div.library-list-item-container, div[data-test-id^="library-drop-target"]') ||
         node.querySelector?.('#library-grid, div.library-list-item-container, div[data-test-id^="library-drop-target"]'))
      ) {
        scheduleBrandFilterRefresh();
      }
    });
  });
});

observer.observe(document.documentElement || document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['data-item-id', 'data-omega-attribute-contentid']
});

// Keep tag badges visible during scroll virtualization.
window.addEventListener(
  'scroll',
  () => {
    scheduleBadgeRefresh();
    try { scheduleBrandLibraryCardLabelRefresh(); } catch (e) {}
  },
  true
);

// Watch for SPA-style route changes (pathname changes without full reload)
function handleRouteChange() {
  console.log('[GS4PM Filter] Route changed to', location.pathname, 're-applying filter:', currentFilterCustomer);
  // Ensure brand labels don’t persist across routes.
  try { clearBrandLibraryCardLabels({ removeLayer: false }); } catch (e) {}
  cachedTags = [];
  applyFilter(currentFilterCustomer || 'ALL');
  try { initBrandLibraryCardLabels(); } catch (e) {}
}

setInterval(() => {
  if (location.pathname !== lastPathname) {
    lastPathname = location.pathname;
    handleRouteChange();
  }
}, 500);

// Debug function to inspect filtering state
window.debugGS4PMFilter = function() {
  if (!chrome.runtime || !chrome.runtime.id) {
    console.warn('[GS4PM Filter] Cannot debug - extension context unavailable');
    return;
  }
  
  const pageKey = getPageKey();
  chrome.storage.local.get([pageKey, ACTIVE_FILTER_KEY, CURRENT_CUSTOMER_KEY], data => {
    const tags = data[pageKey] || [];
    const activeFilter = data[ACTIVE_FILTER_KEY];
    const currentCustomer = data[CURRENT_CUSTOMER_KEY];
    
    console.log('=== GS4PM Filter Debug Info ===');
    console.log('Page Key:', pageKey);
    console.log('Active Filter:', activeFilter);
    console.log('Current Customer:', currentCustomer);
    console.log('Total Tags:', tags.length);
    console.log('\nTags:', tags);
    
    console.log('\n=== Testing Selectors ===');
    tags.forEach((tag, i) => {
      const matches = document.querySelectorAll(tag.selector);
      console.log(`Tag ${i + 1} (${tag.customer}):`, tag.selector);
      console.log('  Matches:', matches.length, 'elements');
      if (matches.length > 0) {
        console.log('  First match:', matches[0]);
      }
    });
    
    console.log('\n=== Dropdown Options ===');
    const dropdownOptions = document.querySelectorAll('[role="option"]');
    console.log('Found', dropdownOptions.length, 'dropdown options');
    dropdownOptions.forEach((opt, i) => {
      const key = opt.getAttribute('data-key');
      const label = opt.querySelector('.gO9Mdq_spectrum-Menu-itemLabel')?.textContent;
      console.log(`  Option ${i + 1}: "${label}" [data-key="${key}"]`);
    });
  });
};

console.log('[GS4PM Filter] 💡 Tip: Run debugGS4PMFilter() in console to see filtering state');

// Helper function to extract persona data-keys from current page
window.extractPersonaKeys = function() {
  console.log('=== Extracting Persona Data Keys ===');
  
  // From cards
  const cards = document.querySelectorAll('article[data-omega-attribute-referenceid]');
  console.log('\nFrom Cards:', cards.length);
  cards.forEach(card => {
    const refId = card.getAttribute('data-omega-attribute-referenceid');
    const label = card.querySelector('[class*="Card-title"]')?.textContent || 'Unknown';
    console.log(`  "${label}": ${refId}`);
  });
  
  // From dropdown (if open)
  const options = document.querySelectorAll('[role="option"]');
  console.log('\nFrom Dropdown Options:', options.length);
  options.forEach(opt => {
    const dataKey = opt.getAttribute('data-key');
    const label = opt.querySelector('[class*="Menu-itemLabel"]')?.textContent || 'Unknown';
    console.log(`  "${label}": ${dataKey}`);
  });
};

console.log('[GS4PM Filter] 💡 Tip: Run extractPersonaKeys() to see all persona IDs');

// Debug function to inspect dropdown state
window.inspectDropdown = function() {
  const listbox = document.querySelector('[role="listbox"]');
  if (!listbox) {
    console.log('❌ No dropdown open');
    return;
  }
  
  console.log('\n🔍 DROPDOWN INSPECTION:');
  console.log('Listbox height:', listbox.style.height, 'maxHeight:', listbox.style.maxHeight);
  
  const parent = listbox.querySelector('[role="presentation"]');
  if (parent) {
    console.log('Parent height:', parent.style.height, 'maxHeight:', parent.style.maxHeight);
  }
  
  const wrappers = Array.from(listbox.querySelectorAll('[role="presentation"]')).filter(w => 
    w.querySelector('[role="option"]') && w.style.position === 'absolute'
  );
  
  console.log('\nTotal wrappers:', wrappers.length);
  console.log('Visible wrappers (top >= 0):');
  
  wrappers.forEach(wrapper => {
    const option = wrapper.querySelector('[role="option"]');
    const text = option ? option.textContent.trim() : 'unknown';
    const top = wrapper.style.top;
    const display = wrapper.style.display;
    const isVisible = parseInt(top) >= 0 && display !== 'none';
    
    console.log('  ' + (isVisible ? '✅' : '❌') + ' "' + text + '" - top: ' + top + ', display: ' + display);
  });
};

console.log('[GS4PM Filter] 💡 Tip: Run inspectDropdown() to see dropdown item positions');

// Add responsive layout support: reapply filter on window resize
// TODO: Currently disabled for debugging - resize was interfering with dropdown state
window.addEventListener('resize', () => {
  console.log('[GS4PM Filter] Window resized - handler temporarily disabled for debugging');
  return; // DISABLED FOR NOW
  
  // Only reapply if actively filtering
  if (currentFilterCustomer === 'ALL') return;
  
  // Debounce resize events
  if (resizeTimeout) {
    clearTimeout(resizeTimeout);
  }
  
  resizeTimeout = setTimeout(() => {
    console.log('[GS4PM Filter] Window resized, reapplying filter...');
    
    // Store current filter
    const activeFilter = currentFilterCustomer;
    
    // Step 1: Fully restore to ALL to let GenStudio recalculate native layout
    const allContainers = [];
    document.querySelectorAll('div[style*="position: absolute"]').forEach(div => {
      // Skip any element that is, contains, or is inside dropdown structures
      const role = div.getAttribute('role');
      const isListbox = role === 'listbox';
      const isPresentation = role === 'presentation';
      const containsListbox = div.querySelector('[role="listbox"]') !== null;
      const insideListbox = div.closest('[role="listbox"]') !== null;
      const containsOptions = div.querySelector('[role="option"]') !== null;
      const insidePopover = div.closest('[role="presentation"][data-testid="popover"]') !== null;
      const hasPopoverClass = div.className && div.className.includes('Popover');
      const insidePopoverClass = div.closest('[class*="Popover"]') !== null;
      
      // CRITICAL: If role="presentation" and inside a listbox, ALWAYS skip
      if (isPresentation && insideListbox) {
        return;
      }
      
      if (isListbox || containsListbox || insideListbox || containsOptions || 
          insidePopover || hasPopoverClass || insidePopoverClass) {
        return;
      }
      
      // Only include if it contains an article (card), not dropdown options
      if (div.querySelector('article')) {
        allContainers.push(div);
      }
    });
    
    // Restore all containers to their original positions
    restoreVirtualizedGrid(allContainers);
    
    // Step 2: Wait for GenStudio's layout engine to settle with new window size
    setTimeout(() => {
      // Step 3: Reapply the filter with fresh grid detection
      applyFilter(activeFilter);
    }, 150);
  }, 300); // Wait 300ms after resize stops
});

console.log('[GS4PM Filter] Resize handler registered for responsive layout');

// Initial state: use the saved active filter on this page
if (chrome.runtime && chrome.runtime.id) {
  chrome.storage.local.get([ACTIVE_FILTER_KEY], data => {
    if (chrome.runtime.lastError) {
      console.log('[GS4PM Filter] Could not load saved filter, using default');
      currentFilterCustomer = 'ALL';
      applyFilter('ALL');
      return;
    }
    const saved = data[ACTIVE_FILTER_KEY];
    const initial = !saved ? 'ALL' : saved;
    console.log('[GS4PM Filter] Initial active filter for this page:', initial);
    currentFilterCustomer = initial;
    applyFilter(initial);
  });
} else {
  console.log('[GS4PM Filter] Extension context not available - page reload needed');
}
}