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

const SHOULD_RUN = isGs4pmUrl(window.location.href);

if (!SHOULD_RUN) {
  console.log('[GS4PM Filter] Skipping non-GS4PM page:', window.location.href);
} else {
let tagging = false;
let currentTagCustomer = null;
let hoverHandler = null;
let clickHandler = null;
let escapeHandler = null;
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

const CUSTOMER_KEY = 'gs4pm_customers';
const CURRENT_CUSTOMER_KEY = 'gs4pm_current_customer';
const ACTIVE_FILTER_KEY = 'gs4pm_active_filter_customer';
const TAGGING_ENABLED_KEY = 'gs4pm_tagging_enabled';
const TAGGING_BANNER_ID = 'gs4pm-tagging-banner';
const OVERLAY_VISIBLE_KEY = 'gs4pm_overlay_visible';
const OVERLAY_ID = 'gs4pm-workspace-bar';
const OVERLAY_STYLE_ID = 'gs4pm-workspace-bar-style';

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
      --gs4pm-overlay-bg: rgba(38, 38, 38, 0.84);
      --gs4pm-overlay-border: rgba(255, 255, 255, 0.12);
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
      box-shadow: 0 18px 42px rgba(0,0,0,0.50);
      color: var(--gs4pm-overlay-text);
      font: 650 12px system-ui, -apple-system, Segoe UI, sans-serif;
      letter-spacing: 0.01em;
    }
    #${OVERLAY_ID} *{ box-sizing: border-box; }
    #${OVERLAY_ID}[data-hidden="true"]{ display:none; }

    #${OVERLAY_ID} .gs4pm-row{
      display:flex;
      align-items:center;
      gap:10px;
      padding:10px 12px;
    }
    #${OVERLAY_ID} .gs4pm-left{
      display:flex;
      align-items:center;
      gap:10px;
      min-width:0;
      flex:1;
    }
    #${OVERLAY_ID} .gs4pm-right{
      display:flex;
      align-items:center;
      gap:8px;
      flex:0 0 auto;
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
      padding:8px 10px;
      border-radius:14px;
      border:1px solid rgba(255,255,255,0.10);
      background: rgba(0,0,0,0.18);
      min-width:0;
    }
    #${OVERLAY_ID} .gs4pm-label{
      color: var(--gs4pm-overlay-muted);
      font-weight:800;
      white-space:nowrap;
    }
    #${OVERLAY_ID} .gs4pm-btn{
      border:1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.20);
      color: var(--gs4pm-overlay-text);
      border-radius:999px;
      padding:8px 10px;
      font-weight:800;
      cursor:pointer;
      transition: background 120ms ease, border-color 120ms ease, transform 60ms ease;
      white-space:nowrap;
    }
    #${OVERLAY_ID} .gs4pm-btn:hover{ background: rgba(255,255,255,0.08); }
    #${OVERLAY_ID} .gs4pm-btn:active{ transform: translateY(1px); }

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
    #${OVERLAY_ID} .dd{ position:relative; min-width:200px; max-width:320px; }
    #${OVERLAY_ID} .dd button{
      width:100%;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      border:1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.22);
      color: var(--gs4pm-overlay-text);
      border-radius:12px;
      padding:8px 10px;
      cursor:pointer;
      font-weight:700;
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
  if (!chrome.runtime || !chrome.runtime.id) return;
  chrome.runtime.sendMessage({ type: 'GS4PM_BROADCAST', message }, () => {});
}

function ensureWorkspaceBar() {
  if (!isTopFrame()) return;
  injectOverlayStyles();
  if (document.getElementById(OVERLAY_ID)) return;

  const bar = document.createElement('div');
  bar.id = OVERLAY_ID;
  bar.setAttribute('data-hidden', 'true');

  const row = document.createElement('div');
  row.className = 'gs4pm-row';

  const left = document.createElement('div');
  left.className = 'gs4pm-left';

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
  filterPill.className = 'gs4pm-pill';
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
      chrome.storage.local.set({ [ACTIVE_FILTER_KEY]: normalized });
    }
  });

  filterPill.appendChild(filterLabel);
  filterPill.appendChild(filterDd.el);

  const tagPill = document.createElement('div');
  tagPill.className = 'gs4pm-pill';
  const tagLabel = document.createElement('div');
  tagLabel.className = 'gs4pm-label';
  tagLabel.textContent = 'Tag';

  const tagDd = createDropdown({
    label: 'Tag customer',
    placeholder: 'Select customer…',
    options: [{ value: '__NONE__', label: 'Select customer…' }],
    value: '__NONE__',
    onChange: (val) => {
      if (!val || val === '__NONE__') {
        chrome.storage.local.set({ [CURRENT_CUSTOMER_KEY]: '__ALL__' });
        return;
      }
      chrome.storage.local.set({ [CURRENT_CUSTOMER_KEY]: val });
      chrome.storage.local.get([TAGGING_ENABLED_KEY], (data) => {
        if (!data[TAGGING_ENABLED_KEY]) return;
        sendBroadcastFromContent({ type: 'STOP_TAGGING' });
        sendBroadcastFromContent({ type: 'START_TAGGING', customer: val });
      });
    }
  });

  tagPill.appendChild(tagLabel);
  tagPill.appendChild(tagDd.el);

  const toggleTagBtn = document.createElement('button');
  toggleTagBtn.type = 'button';
  toggleTagBtn.className = 'gs4pm-btn gs4pm-btn-primary';
  toggleTagBtn.setAttribute('data-off', 'true');
  toggleTagBtn.textContent = 'Enable tagging';

  const updateToggleBtn = (enabled) => {
    toggleTagBtn.setAttribute('data-off', enabled ? 'false' : 'true');
    toggleTagBtn.textContent = enabled ? 'Disable tagging' : 'Enable tagging';
  };

  toggleTagBtn.addEventListener('click', () => {
    chrome.storage.local.get([TAGGING_ENABLED_KEY], (data) => {
      const enabled = !!data[TAGGING_ENABLED_KEY];
      if (enabled) {
        chrome.storage.local.set({ [TAGGING_ENABLED_KEY]: false }, () => {
          updateToggleBtn(false);
          sendBroadcastFromContent({ type: 'STOP_TAGGING' });
        });
        return;
      }

      const selected = tagDd.getValue();
      if (!selected || selected === '__NONE__' || selected === 'ALL') return;

      chrome.storage.local.set(
        { [TAGGING_ENABLED_KEY]: true, [CURRENT_CUSTOMER_KEY]: selected },
        () => {
          updateToggleBtn(true);
          sendBroadcastFromContent({ type: 'START_TAGGING', customer: selected });
        }
      );
    });
  });

  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.className = 'gs4pm-btn';
  hideBtn.textContent = 'Hide';
  hideBtn.addEventListener('click', () => chrome.storage.local.set({ [OVERLAY_VISIBLE_KEY]: false }));

  const right = document.createElement('div');
  right.className = 'gs4pm-right';
  right.appendChild(toggleTagBtn);
  right.appendChild(hideBtn);

  left.appendChild(icon);
  left.appendChild(filterPill);
  left.appendChild(tagPill);

  row.appendChild(left);
  row.appendChild(right);
  bar.appendChild(row);

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
    chrome.storage.local.get(
      [CUSTOMER_KEY, ACTIVE_FILTER_KEY, CURRENT_CUSTOMER_KEY, TAGGING_ENABLED_KEY, OVERLAY_VISIBLE_KEY],
      (data) => {
        const customers = Array.isArray(data[CUSTOMER_KEY]) ? data[CUSTOMER_KEY].filter(Boolean) : [];

        const filterOptions = [{ value: 'ALL', label: 'All customers' }, ...customers.map((c) => ({ value: c, label: c }))];
        filterDd.setOptions(filterOptions);

        const active = data[ACTIVE_FILTER_KEY] && (data[ACTIVE_FILTER_KEY] === 'ALL' || customers.includes(data[ACTIVE_FILTER_KEY]))
          ? data[ACTIVE_FILTER_KEY]
          : 'ALL';
        filterDd.setValue(active, active === 'ALL' ? 'All customers' : active);

        const tagOptions = [{ value: '__NONE__', label: 'Select customer…' }, ...customers.map((c) => ({ value: c, label: c }))];
        tagDd.setOptions(tagOptions);

        const current = data[CURRENT_CUSTOMER_KEY];
        if (current && current !== '__ALL__' && customers.includes(current)) {
          tagDd.setValue(current, current);
        } else if (active !== 'ALL') {
          tagDd.setValue(active, active);
        } else {
          tagDd.setValue('__NONE__', 'Select customer…');
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

function removeAllBadges(restorePosition = false) {
  Array.from(document.querySelectorAll('.gs4pm-tag-badge')).forEach(badge => {
    const parent = badge.parentElement;
    badge.remove();
    if (restorePosition && parent && parent.dataset && parent.dataset.gs4pmOriginalPosition === 'static') {
      parent.style.position = '';
      delete parent.dataset.gs4pmOriginalPosition;
    }
  });
}

function ensureBadgeContainer(container) {
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
  if (!tagging) return;
  const badge = ensureBadgeContainer(container);
  let names = badge.dataset.customers ? badge.dataset.customers.split('|') : [];
  if (!names.includes(customer)) {
    names.push(customer);
    badge.dataset.customers = names.join('|');
  }
  badge.textContent = names.join(', ');
}

function refreshBadges() {
  if (!tagging) return;
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

  // Update/create badges for all current containers.
  byContainer.forEach((customerSet, container) => {
    const badge = ensureBadgeContainer(container);
    const names = Array.from(customerSet);
    badge.dataset.customers = names.join('|');
    badge.textContent = names.join(', ');
  });
}

// ===== Grid Reordering: For virtualized grids with absolute positioning =====

function reorderVirtualizedGrid(visibleContainers, hiddenContainers) {
  if (visibleContainers.length === 0) return;
  
  // SAFETY: Filter out any dropdown elements that somehow got through
  const safeVisible = visibleContainers.filter(c => {
    return c.querySelector('article') !== null && 
           c.closest('[role="listbox"]') === null &&
           !c.className.includes('Popover');
  });
  
  const safeHidden = hiddenContainers.filter(c => {
    return c.querySelector('article') !== null &&
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
    const newLeft = col * columnWidth;
    const newTop = row * rowHeight;
    
    // Store original position if not already stored
    if (!container.dataset.gs4pmOrigLeft) {
      container.dataset.gs4pmOrigLeft = container.style.left;
      container.dataset.gs4pmOrigTop = container.style.top;
    }
    
    container.style.left = newLeft + 'px';
    container.style.top = newTop + 'px';
    container.style.display = '';
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
      
      // Check if we have fewer items than expected (React might not have rendered all items)
      const expectedCounts = { 'Ladbrokes': 4, 'WKND': 7 };
      const expectedCount = expectedCounts[currentFilterCustomer];
      if (expectedCount && freshWrappers.length < expectedCount) {
        console.log('[GS4PM Filter] ⚠️ Watchdog: Only', freshWrappers.length, 'items visible, expected', expectedCount, '- container too small!');
        // Container is too small - React hasn't rendered all expected items
        // Increase height to force React to render all items, then re-filter
        const listboxContainer = parent.closest('[role="listbox"]') || parent.parentElement;
        if (listboxContainer && document.body.contains(listboxContainer)) {
          console.log('[GS4PM Filter] 🔄 Increasing height to force React to render all items...');
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
      } else if (freshWrappers.length > 0) {
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
      if (tagging) refreshBadges();
      return;
    }

    // Clean filtering for Templates: CSS-driven to avoid scroll flicker on virtualization.
    if (isTemplatesPage()) {
      updateTemplatesCssFilter(activeCustomer, tags);
      cachedTags = tags;
      if (tagging) refreshBadges();
      return;
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
        c.querySelector('article') !== null
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
      
      if (tagging) refreshBadges();
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
          if (tagging) addBadge(container, tag.customer);
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
    
    // IMMEDIATE FILTERING: Filter items synchronously BEFORE React renders them
    // This prevents any flash of wrong items
    if (currentFilterCustomer !== 'ALL') {
      const expectedKeys = {
        'Ladbrokes': ['Rc691c7ec72417932481c122f7', 'Rc691c7ecc770c9e030959527a', 'Rc691dcb1f770c9e0309817a12', 'Rc691c7ed02417932481c12568'],
        'WKND': ['Rc677bf0a47dc0b924845c6e17', 'Rc677bf1098c4eb7177f7882ca', 'Rc677bf2057dc0b924845c6e2c', 'Rc677bf30eaf536d72a095c1bd', 'Rc677bf4bbaf536d72a095c1ce', 'Rc677bf1948c4eb7177f7882f8', 'Rc677bf2668c4eb7177f788332']
      };
      const expectedKeysForCustomer = expectedKeys[currentFilterCustomer] || [];
      
      // Filter items immediately and synchronously
      const immediateFilter = () => {
        const allWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
          wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
        );
        allWrappers.forEach(wrapper => {
          const option = wrapper.querySelector('[role="option"]');
          if (option) {
            const optionKey = option.getAttribute('data-key');
            if (optionKey && !expectedKeysForCustomer.includes(optionKey)) {
              wrapper.style.top = '-9999px';
              wrapper.style.left = '-9999px';
              wrapper.style.visibility = 'hidden';
              wrapper.style.opacity = '0';
            }
          }
        });
      };
      
      // Run immediately
      immediateFilter();
      
      // Also run in next frame to catch items added in the same frame
      requestAnimationFrame(() => {
        immediateFilter();
        requestAnimationFrame(() => {
          immediateFilter();
        });
      });
      
      // IMMEDIATE HEIGHT & SORTING: Set filtered height and sort items immediately
      const parent = listboxContainer.querySelector('[role="presentation"]');
      if (parent) {
        const expectedCounts = { 'Ladbrokes': 4, 'WKND': 7 };
        const expectedCount = expectedCounts[currentFilterCustomer] || 11;
        const itemHeight = 32;
        const baseOffset = currentFilterCustomer === 'Ladbrokes' ? 36 : 4;
        const heightBuffer = 24;
        const filteredHeight = baseOffset + (expectedCount * itemHeight) + heightBuffer;
        
        // Set filtered height immediately to prevent gaps
        parent.style.setProperty('height', filteredHeight + 'px', 'important');
        parent.style.setProperty('max-height', filteredHeight + 'px', 'important');
        parent.style.setProperty('overflow', 'hidden', 'important');
        
        const listbox = listboxContainer;
        if (listbox) {
          listbox.style.setProperty('height', filteredHeight + 'px', 'important');
          listbox.style.setProperty('max-height', filteredHeight + 'px', 'important');
        }
        
        const outerContainer = listboxContainer.closest('[role="presentation"]');
        if (outerContainer && outerContainer !== parent) {
          outerContainer.style.setProperty('height', filteredHeight + 'px', 'important');
          outerContainer.style.setProperty('max-height', filteredHeight + 'px', 'important');
        }
        
        const popover = listboxContainer.closest('[data-testid="popover"]') || 
                       listboxContainer.closest('.spectrum-Popover') ||
                       listboxContainer.closest('[role="presentation"][class*="Popover"]');
        if (popover) {
          popover.style.setProperty('height', filteredHeight + 'px', 'important');
          popover.style.setProperty('max-height', filteredHeight + 'px', 'important');
          popover.style.setProperty('min-height', filteredHeight + 'px', 'important');
        }
        
        // Sort and reposition visible items immediately
        const allWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
          wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
        );
        
        const visibleWrappers = allWrappers.filter(wrapper => {
          const option = wrapper.querySelector('[role="option"]');
          if (option) {
            const optionKey = option.getAttribute('data-key');
            return optionKey && expectedKeysForCustomer.includes(optionKey);
          }
          return false;
        });
        
        if (visibleWrappers.length > 0) {
          // Store original positions
          visibleWrappers.forEach(wrapper => {
            if (!wrapper.dataset.gs4pmOrigTop) {
              wrapper.dataset.gs4pmOrigTop = wrapper.style.top || '0px';
            }
          });
          
          // Sort by original position
          const sortedVisible = visibleWrappers.sort((a, b) => {
            const aTop = parseInt(a.dataset.gs4pmOrigTop) || 0;
            const bTop = parseInt(b.dataset.gs4pmOrigTop) || 0;
            return aTop - bTop;
          });
          
          // Reposition items immediately
          sortedVisible.forEach((wrapper, index) => {
            const newTop = (index * itemHeight) + baseOffset;
            wrapper.style.top = newTop + 'px';
            wrapper.style.display = '';
            wrapper.style.visibility = 'visible';
            wrapper.style.opacity = '1';
          });
          
        }
      }
    }
    
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
      
      // CRITICAL FIX: Set container height to show ALL items FIRST
      // This forces React to render all items (virtualization only renders visible items)
      const parent = listboxContainer.querySelector('[role="presentation"]');
      let immediateFilterObserver = null; // Declare outside if block for cleanup
      let immediateFilterInterval = null; // Declare outside if block for cleanup
      
      if (parent && attempt === 1) {
        // Check if filtered height is already set (from immediate filtering)
        const currentHeight = parent.style.height;
        const expectedCounts = { 'Ladbrokes': 4, 'WKND': 7 };
        const expectedCount = expectedCounts[currentFilterCustomer] || 11;
        const itemHeight = 32;
        const baseOffset = currentFilterCustomer === 'Ladbrokes' ? 36 : 4;
        const heightBuffer = 24;
        const filteredHeight = baseOffset + (expectedCount * itemHeight) + heightBuffer;
        const fullHeight = 11 * 32; // All personas
        
        // If filtered height is already set, temporarily expand to force React to render all items
        // Then immediately shrink back to filtered height (happens synchronously)
        if (currentHeight && currentHeight.includes(filteredHeight.toString())) {
          // Temporarily expand to full height synchronously
          parent.style.setProperty('height', fullHeight + 'px', 'important');
          parent.style.setProperty('max-height', fullHeight + 'px', 'important');
          
          const listbox = listboxContainer;
          if (listbox) {
            listbox.style.setProperty('height', fullHeight + 'px', 'important');
            listbox.style.setProperty('max-height', fullHeight + 'px', 'important');
          }
          
          const outerContainer = listboxContainer.closest('[role="presentation"]');
          if (outerContainer && outerContainer !== parent) {
            outerContainer.style.setProperty('height', fullHeight + 'px', 'important');
            outerContainer.style.setProperty('max-height', fullHeight + 'px', 'important');
          }
          
          const popover = listboxContainer.closest('[data-testid="popover"]') || 
                         listboxContainer.closest('.spectrum-Popover') ||
                         listboxContainer.closest('[role="presentation"][class*="Popover"]');
          if (popover) {
            if (!popover.dataset.gs4pmOrigHeight) {
              popover.dataset.gs4pmOrigHeight = popover.style.height || '';
              popover.dataset.gs4pmOrigMaxHeight = popover.style.maxHeight || '';
            }
            popover.style.setProperty('height', fullHeight + 'px', 'important');
            popover.style.setProperty('max-height', fullHeight + 'px', 'important');
            popover.style.setProperty('min-height', fullHeight + 'px', 'important');
          }
          
          console.log('[GS4PM Filter] 🔧 Temporarily expanded to', fullHeight, 'px to force React render (will shrink back to', filteredHeight, 'px)');
          
          // Shrink back to filtered height after React renders (use requestAnimationFrame to run before paint)
          requestAnimationFrame(() => {
            // Check if we have all items rendered before shrinking
            const checkWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
              wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
            );
            
            if (checkWrappers.length >= 11) {
              // All items rendered, shrink back to filtered height
              parent.style.setProperty('height', filteredHeight + 'px', 'important');
              parent.style.setProperty('max-height', filteredHeight + 'px', 'important');
              if (listbox) {
                listbox.style.setProperty('height', filteredHeight + 'px', 'important');
                listbox.style.setProperty('max-height', filteredHeight + 'px', 'important');
              }
              if (outerContainer) {
                outerContainer.style.setProperty('height', filteredHeight + 'px', 'important');
                outerContainer.style.setProperty('max-height', filteredHeight + 'px', 'important');
              }
              if (popover) {
                popover.style.setProperty('height', filteredHeight + 'px', 'important');
                popover.style.setProperty('max-height', filteredHeight + 'px', 'important');
                popover.style.setProperty('min-height', filteredHeight + 'px', 'important');
              }
              console.log('[GS4PM Filter] ✅ Shrunk back to filtered height', filteredHeight + 'px');
            } else {
              // Not all items rendered yet, wait another frame
              requestAnimationFrame(() => {
                parent.style.setProperty('height', filteredHeight + 'px', 'important');
                parent.style.setProperty('max-height', filteredHeight + 'px', 'important');
                if (listbox) {
                  listbox.style.setProperty('height', filteredHeight + 'px', 'important');
                  listbox.style.setProperty('max-height', filteredHeight + 'px', 'important');
                }
                if (outerContainer) {
                  outerContainer.style.setProperty('height', filteredHeight + 'px', 'important');
                  outerContainer.style.setProperty('max-height', filteredHeight + 'px', 'important');
                }
                if (popover) {
                  popover.style.setProperty('height', filteredHeight + 'px', 'important');
                  popover.style.setProperty('max-height', filteredHeight + 'px', 'important');
                  popover.style.setProperty('min-height', filteredHeight + 'px', 'important');
                }
              });
            }
          });
        } else {
          // Filtered height not set yet, set full height normally
          parent.style.setProperty('height', fullHeight + 'px', 'important');
          parent.style.setProperty('max-height', fullHeight + 'px', 'important');
          parent.style.setProperty('overflow', 'hidden', 'important');
          
          const listbox = listboxContainer;
          if (listbox) {
            listbox.style.setProperty('height', fullHeight + 'px', 'important');
            listbox.style.setProperty('max-height', fullHeight + 'px', 'important');
          }
          
          const outerContainer = listboxContainer.closest('[role="presentation"]');
          if (outerContainer && outerContainer !== parent) {
            outerContainer.style.setProperty('height', fullHeight + 'px', 'important');
            outerContainer.style.setProperty('max-height', fullHeight + 'px', 'important');
          }
          
          const popover = listboxContainer.closest('[data-testid="popover"]') || 
                         listboxContainer.closest('.spectrum-Popover') ||
                         listboxContainer.closest('[role="presentation"][class*="Popover"]');
          if (popover) {
            if (!popover.dataset.gs4pmOrigHeight) {
              popover.dataset.gs4pmOrigHeight = popover.style.height || '';
              popover.dataset.gs4pmOrigMaxHeight = popover.style.maxHeight || '';
            }
            popover.style.setProperty('height', fullHeight + 'px', 'important');
            popover.style.setProperty('max-height', fullHeight + 'px', 'important');
            popover.style.setProperty('min-height', fullHeight + 'px', 'important');
          }
        }
        
        // IMMEDIATE FILTERING: Hide items immediately to prevent flash
        // First, hide any existing items that don't match the filter
        const expectedKeys = {
          'Ladbrokes': ['Rc691c7ec72417932481c122f7', 'Rc691c7ecc770c9e030959527a', 'Rc691dcb1f770c9e0309817a12', 'Rc691c7ed02417932481c12568'], // Darts, Football, Live Casino, Responsible Returner
          'WKND': ['Rc677bf0a47dc0b924845c6e17', 'Rc677bf1098c4eb7177f7882ca', 'Rc677bf2057dc0b924845c6e2c', 'Rc677bf30eaf536d72a095c1bd', 'Rc677bf4bbaf536d72a095c1ce', 'Rc677bf1948c4eb7177f7882f8', 'Rc677bf2668c4eb7177f788332'] // All WKND personas
        };
        const expectedKeysForCustomer = expectedKeys[currentFilterCustomer] || [];
        
        // SIMPLE APPROACH: Just hide items that don't match as they're added
        // Don't watch style changes to avoid infinite loops
        if (currentFilterCustomer !== 'ALL') {
          // Hide existing items that don't match
          const existingWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
            wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
          );
          existingWrappers.forEach(wrapper => {
            const option = wrapper.querySelector('[role="option"]');
            if (option) {
              const optionKey = option.getAttribute('data-key');
              if (optionKey && !expectedKeysForCustomer.includes(optionKey)) {
                wrapper.style.top = '-9999px';
                wrapper.style.left = '-9999px';
                wrapper.style.visibility = 'hidden';
                wrapper.style.opacity = '0';
              }
            }
          });
        }
        
        // AGGRESSIVE SYNCHRONOUS OBSERVER: Filter ALL items immediately when any are added
        immediateFilterObserver = new MutationObserver((mutations) => {
          if (currentFilterCustomer !== 'ALL') {
            // Filter ALL items synchronously, not just new ones
            const allWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
              wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
            );
            allWrappers.forEach(wrapper => {
              const option = wrapper.querySelector('[role="option"]');
              if (option) {
                const optionKey = option.getAttribute('data-key');
                if (optionKey && !expectedKeysForCustomer.includes(optionKey)) {
                  // Hide synchronously - no delay
                  wrapper.style.top = '-9999px';
                  wrapper.style.left = '-9999px';
                  wrapper.style.visibility = 'hidden';
                  wrapper.style.opacity = '0';
                }
              }
            });
          }
        });
        
        // Watch for child additions with immediate callback
        immediateFilterObserver.observe(listboxContainer, { 
          childList: true, 
          subtree: true,
          // Use flush: 'sync' if available, otherwise rely on synchronous callback
        });
        
        // Also filter immediately after setting height
        if (currentFilterCustomer !== 'ALL') {
          const allWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
            wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
          );
          allWrappers.forEach(wrapper => {
            const option = wrapper.querySelector('[role="option"]');
            if (option) {
              const optionKey = option.getAttribute('data-key');
              if (optionKey && !expectedKeysForCustomer.includes(optionKey)) {
                wrapper.style.top = '-9999px';
                wrapper.style.left = '-9999px';
                wrapper.style.visibility = 'hidden';
                wrapper.style.opacity = '0';
              }
            }
          });
        }
        
        // Use requestAnimationFrame for immediate filtering (runs before paint)
        let filterLoopCount = 0;
        immediateFilterInterval = requestAnimationFrame(function filterLoop() {
          filterLoopCount++;
          if (currentFilterCustomer !== 'ALL' && document.body.contains(listboxContainer)) {
            const allWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
              wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
            );
            
            let hiddenCount = 0;
            allWrappers.forEach(wrapper => {
              const option = wrapper.querySelector('[role="option"]');
              if (option) {
                const optionKey = option.getAttribute('data-key');
                if (optionKey && !expectedKeysForCustomer.includes(optionKey)) {
                  if (wrapper.style.top !== '-9999px') {
                    hiddenCount++;
                  }
                  wrapper.style.top = '-9999px';
                  wrapper.style.left = '-9999px';
                  wrapper.style.visibility = 'hidden';
                  wrapper.style.opacity = '0';
                }
              }
            });
            
            // Continue until we have all items, then stop
            if (allWrappers.length < 11) {
              immediateFilterInterval = requestAnimationFrame(filterLoop);
            } else {
              immediateFilterInterval = null;
            }
          }
        });
        
        // Force React to re-render by triggering a resize event
        const resizeEvent = new Event('resize', { bubbles: true });
        window.dispatchEvent(resizeEvent);
        
        // Also try to trigger React's internal update by modifying a data attribute
        listboxContainer.setAttribute('data-gs4pm-force-render', Date.now().toString());
        
        // Try scrolling the container to trigger React's virtualization to render more items
        // React's virtualization checks scroll position to determine what's visible
        if (parent.scrollHeight > parent.clientHeight) {
          parent.scrollTop = parent.scrollHeight; // Scroll to bottom
          setTimeout(() => {
            parent.scrollTop = 0; // Scroll back to top
          }, 50);
        }
        
        // Set up observer to watch for new items being added
        const heightChangeObserver = new MutationObserver((mutations) => {
          const checkWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
            wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
          );
          
          if (checkWrappers.length >= 11) {
            console.log('[GS4PM Filter] ✅ Height change triggered React to render all', checkWrappers.length, 'items!');
            heightChangeObserver.disconnect();
            if (immediateFilterObserver) {
              immediateFilterObserver.disconnect(); // Disconnect immediate filter observer
            }
            if (immediateFilterInterval) {
              cancelAnimationFrame(immediateFilterInterval); // Cancel animation frame
              immediateFilterInterval = null;
            }
            // Only proceed if not already filtering (prevent duplicate filtering)
            if (!filteringListboxes.has(listboxContainer)) {
              filterDropdownWithRetry(attempt + 1, maxAttempts);
            } else {
              console.log('[GS4PM Filter] ⏸️ Skipping filterDropdownWithRetry - already filtering this listbox');
            }
          }
        });
        
        heightChangeObserver.observe(listboxContainer, { childList: true, subtree: true });
        
        // Fallback: if observer doesn't trigger, retry after delay
        const timeoutId = setTimeout(() => {
          heightChangeObserver.disconnect();
          if (immediateFilterObserver) {
            immediateFilterObserver.disconnect(); // Disconnect immediate filter observer
          }
          if (immediateFilterInterval) {
            cancelAnimationFrame(immediateFilterInterval); // Cancel animation frame
            immediateFilterInterval = null;
          }
          // Only proceed if not already filtering (prevent duplicate filtering)
          if (!filteringListboxes.has(listboxContainer)) {
            const checkWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
              wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
            );
            filterDropdownWithRetry(attempt + 1, maxAttempts);
          } else {
            console.log('[GS4PM Filter] ⏸️ Fallback timeout skipped - already filtering this listbox');
          }
        }, 500); // Increased to 500ms
        dropdownRetryTimeouts.push(timeoutId);
        return;
      }
      
      // Query FRESH wrappers from DOM (not stale references)
      const freshWrappers = Array.from(listboxContainer.querySelectorAll('[role="presentation"]')).filter(wrapper => 
        wrapper.querySelector('[role="option"]') && wrapper.style.position === 'absolute'
      );
      
      // Also check for options directly by data-key (more reliable than wrapper count)
      const allOptions = Array.from(listboxContainer.querySelectorAll('[role="option"]'));
      const expectedKeys = {
        'Ladbrokes': ['Rc691c7ec72417932481c122f7', 'Rc691c7ecc770c9e030959527a', 'Rc691dcb1f770c9e0309817a12', 'Rc691c7ed02417932481c12568'], // Darts, Football, Live Casino, Responsible Returner
        'WKND': ['Rc677bf0a47dc0b924845c6e17', 'Rc677bf1098c4eb7177f7882ca', 'Rc677bf2057dc0b924845c6e2c', 'Rc677bf30eaf536d72a095c1bd', 'Rc677bf4bbaf536d72a095c1ce', 'Rc677bf1948c4eb7177f7882f8', 'Rc677bf2668c4eb7177f788332'] // All WKND personas
      };
      
      const expectedKeysForCustomer = expectedKeys[currentFilterCustomer] || [];
      const foundKeys = allOptions.map(opt => opt.getAttribute('data-key')).filter(Boolean);
      const missingKeys = expectedKeysForCustomer.filter(key => !foundKeys.includes(key));
      
      // Log what we found
      const foundItems = freshWrappers.map(w => {
        const opt = w.querySelector('[role="option"]');
        const key = opt ? opt.getAttribute('data-key') : 'no-key';
        const text = opt ? opt.textContent.trim() : 'unknown';
        return text + ' (' + key + ')';
      });
      // Only log if keys are missing
      if (missingKeys.length > 0) {
        console.log('[GS4PM Filter] ⚠️ Missing keys:', missingKeys);
      }
      
      // Check if missing items exist elsewhere in DOM (React might render them outside listbox initially)
      if (missingKeys.length > 0) {
        const missingInDOM = missingKeys.filter(key => {
          const found = document.querySelector(`[data-key="${key}"]`);
          return found !== null;
        });
        if (missingInDOM.length > 0) {
          console.log('[GS4PM Filter] 🔍 Found', missingInDOM.length, 'missing items elsewhere in DOM:', missingInDOM.join(', '));
          // Items exist but not in listbox - might need to wait for React to move them
        }
      }
      
      // If we're missing expected keys, React hasn't rendered them yet - wait longer
      if (missingKeys.length > 0 && attempt < maxAttempts) {
        const delay = Math.min(attempt * 300, 1000); // 300ms, 600ms, 900ms, max 1000ms
        console.log('[GS4PM Filter] ⏳ Missing keys:', missingKeys.join(', '), '- retrying in', delay + 'ms...');
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
      
      // If we're filtering for a specific customer and found fewer items than expected, retry
      // Expected: Ladbrokes = 4 visible, WKND = 7 visible, ALL = all items
      // But we need to check TOTAL wrappers first - if React hasn't rendered all items yet,
      // we won't have enough total wrappers to filter from
      const expectedCounts = { 'Ladbrokes': 4, 'WKND': 7 };
      const expectedCount = expectedCounts[currentFilterCustomer];
      
      // For Ladbrokes, we expect 4 visible + 7 hidden = 11 total
      // For WKND, we expect 7 visible + 4 hidden = 11 total
      const expectedTotal = 11; // Both customers have 11 total personas
      
      // If we don't have enough total wrappers, React hasn't finished rendering
      if (freshWrappers.length < expectedTotal && attempt < maxAttempts) {
        const delay = attempt * 200; // 200ms, 400ms, 600ms, 800ms
        console.log('[GS4PM Filter] ⏳ Only found', freshWrappers.length, 'total wrappers, expected', expectedTotal, '- retrying in', delay + 'ms...');
        const timeoutId = setTimeout(() => filterDropdownWithRetry(attempt + 1, maxAttempts), delay);
        dropdownRetryTimeouts.push(timeoutId);
        return;
      }
      
      // If we have enough total wrappers but not enough visible, that's a filtering issue
      if (expectedCount && visibleDropdownWrappers.length < expectedCount && attempt < maxAttempts) {
        const delay = attempt * 200;
        console.log('[GS4PM Filter] ⏳ Found', freshWrappers.length, 'total but only', visibleDropdownWrappers.length, 'visible, expected', expectedCount, '- retrying in', delay + 'ms...');
        const timeoutId = setTimeout(() => filterDropdownWithRetry(attempt + 1, maxAttempts), delay);
        dropdownRetryTimeouts.push(timeoutId);
        return;
      }
      
      // REMOVED: Pre-setting height before filtering was causing React to remove items
      // Instead, we'll filter first, then set height after items are positioned
      // This ensures React has all items rendered before we adjust heights
      
      // Fallback: filter without pre-setting height
      if (visibleDropdownWrappers.length > 0 || hiddenDropdownWrappers.length > 0) {
        console.log('[GS4PM Filter] 📞 Calling reorderVirtualizedDropdown from filterDropdownWithRetry (visible:', visibleDropdownWrappers.length, 'hidden:', hiddenDropdownWrappers.length + ')');
        reorderVirtualizedDropdown(visibleDropdownWrappers, hiddenDropdownWrappers);
        
        // Mark filtering as complete after a delay to allow React to settle
        // Only clear if this was the final attempt (no more retries scheduled)
        if (attempt >= maxAttempts || freshWrappers.length >= expectedTotal) {
          setTimeout(() => {
            filteringListboxes.delete(listboxContainer);
          }, 1000); // Increased delay to ensure all retries complete
        }
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
      
      // If count has been stable for 2 observations, filter
      const expectedCounts = { 'Ladbrokes': 4, 'WKND': 7 };
      const expectedCount = expectedCounts[currentFilterCustomer];
      
      if (stableCount >= 2) {
        console.log('[GS4PM Filter] ✅ Item count stable at', currentWrappers.length, 'items, filtering now');
        dropdownItemObserver.disconnect();
        dropdownItemObserver = null;
        filterDropdownWithRetry();
      } else if (!expectedCount || currentWrappers.length >= expectedCount || currentWrappers.length >= 10) {
        // Have enough items, filter immediately
        console.log('[GS4PM Filter] ✅ Found', currentWrappers.length, 'items (expected', expectedCount || 'any', '), filtering now');
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
  chrome.storage.local.get([CURRENT_CUSTOMER_KEY, ACTIVE_FILTER_KEY, pageKey], data => {
    let customer = data[CURRENT_CUSTOMER_KEY];
    const activeFilter = data[ACTIVE_FILTER_KEY];
    const tags = data[pageKey] || [];

    // Fallback: if no explicit current customer, but a specific filter is active, tag against that
    if ((!customer || customer === '__ALL__') && activeFilter && activeFilter !== 'ALL') {
      customer = activeFilter;
    }

    if (!customer || customer === '__ALL__') {
      console.log('[GS4PM Filter] No current customer/filter selected; ignoring tag request.');
      return;
    }

    const existingIndex = tags.findIndex(t => t.selector === selector && t.customer === customer);

    if (existingIndex !== -1) {
      // Toggle OFF: remove existing tag
      tags.splice(existingIndex, 1);
      console.log('[GS4PM Filter] Removed tag for customer', customer, selector);
    } else {
      // Toggle ON: add new tag
      tags.push({ selector, customer });
      console.log('[GS4PM Filter] Tagged selector for customer', customer, selector);
    }

    if (chrome.runtime && chrome.runtime.id) {
      chrome.storage.local.set({ [pageKey]: tags }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[GS4PM Filter] Could not save tags:', chrome.runtime.lastError.message);
          return;
        }
        cachedTags = tags;
        applyFilter(currentFilterCustomer || 'ALL');
        if (tagging) refreshBadges();
      });
    } else {
      console.log('[GS4PM Filter] Cannot save tags - extension context unavailable');
    }
  });
}

function startTagging(customer) {
  if (tagging) return;
  tagging = true;
  currentTagCustomer = customer;

  showTaggingBanner();

  const clearHoverOutline = () => {
    if (lastOutlinedContainer) {
      lastOutlinedContainer.style.outline = '';
      lastOutlinedContainer.style.outlineOffset = '';
      lastOutlinedContainer = null;
    }
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
      return el;
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
    lastOutlinedContainer.style.outline = '2px dashed #00bcd4';
    lastOutlinedContainer.style.outlineOffset = '2px';
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
    applyHoverOutline(getHoverTarget(el));
  };

  const mouseoutHandler = e => {
    if (!lastOutlinedContainer) return;
    const related = e.relatedTarget;
    const targetIsWithinOutline = e.target instanceof Element
      && (e.target === lastOutlinedContainer || lastOutlinedContainer.contains(e.target));
    const relatedIsWithinOutline = related instanceof Element
      && (related === lastOutlinedContainer || lastOutlinedContainer.contains(related));
    if (targetIsWithinOutline && !relatedIsWithinOutline) {
      clearHoverOutline();
    }
  };
  startTagging.mouseoutHandler = mouseoutHandler;

  clickHandler = e => {
    if (!tagging) return;
    // Allow interacting with the workspace bar while tagging is enabled.
    if (e?.target instanceof Element && e.target.closest && e.target.closest(`#${OVERLAY_ID}`)) return;
    e.preventDefault();
    e.stopPropagation();

    const taggableEl = findTaggableElement(e);
    if (!taggableEl) return;

    clearHoverOutline();

    const selector = getUniqueSelector(taggableEl);
    console.log('[GS4PM Filter] Click-to-tag selector', selector);
    tagSelectorForCurrentCustomer(selector);
  };

  document.addEventListener('mouseover', hoverHandler, true);
  document.addEventListener('mouseout', mouseoutHandler, true);
  document.addEventListener('click', clickHandler, true);
  document.addEventListener('keydown', escapeHandler, true);
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
  });
}

function stopTagging() {
  tagging = false;
  currentTagCustomer = null;

  document.removeEventListener('mouseover', hoverHandler, true);
  document.removeEventListener('click', clickHandler, true);
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
  }
  if (startTagging.mouseoutHandler) {
    document.removeEventListener('mouseout', startTagging.mouseoutHandler, true);
  }
  if (bannerResizeHandler) {
    window.removeEventListener('resize', bannerResizeHandler, false);
  }

  hoverHandler = null;
  clickHandler = null;
  escapeHandler = null;
  bannerResizeHandler = null;

  if (lastOutlinedContainer) {
    lastOutlinedContainer.style.outline = '';
    lastOutlinedContainer.style.outlineOffset = '';
    lastOutlinedContainer = null;
  }

  removeAllBadges(true);
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
    if (chrome.runtime && chrome.runtime.id) {
      chrome.storage.local.set({ [ACTIVE_FILTER_KEY]: customer }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[GS4PM Filter] Could not save filter preference:', chrome.runtime.lastError.message);
        }
        applyFilter(customer);
        if (tagging) refreshBadges();
      });
    } else {
      console.log('[GS4PM Filter] Applying filter without saving preference - extension context unavailable');
      applyFilter(customer);
      if (tagging) refreshBadges();
    }
  } else if (msg.type === 'TAG_LAST_RIGHT_CLICKED') {
    if (lastRightClickedSelector) {
      console.log('[GS4PM Filter] Tagging last right-clicked selector', lastRightClickedSelector, 'in frame', window.location.href);
      tagSelectorForCurrentCustomer(lastRightClickedSelector);
    } else {
      console.warn('[GS4PM Filter] No right-clicked element recorded to tag.');
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
    if (changes[ACTIVE_FILTER_KEY]) {
      const newVal = changes[ACTIVE_FILTER_KEY].newValue || 'ALL';
      console.log('[GS4PM Filter] ACTIVE_FILTER_KEY changed, applying:', newVal, 'in frame', window.location.href);
      currentFilterCustomer = newVal;
      applyFilter(newVal);
      
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

function scheduleBadgeRefresh() {
  if (!tagging) return;
  if (!cachedTags.length) return;
  if (!isContentAssetsPage() && !isTemplatesPage()) return;
  if (badgeRefreshScheduled) return;
  badgeRefreshScheduled = true;
  requestAnimationFrame(() => {
    badgeRefreshScheduled = false;
    refreshBadges();
  });
}

const observer = new MutationObserver((mutations) => {
  if (!cachedTags.length) return;
  
  let hasDropdownMutation = false;
  
  mutations.forEach(m => {
    if (m.type === 'attributes') {
      // Content/assets + templates reuse DOM nodes; re-apply badges when ids change.
      scheduleBadgeRefresh();
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
  },
  true
);

// Watch for SPA-style route changes (pathname changes without full reload)
function handleRouteChange() {
  console.log('[GS4PM Filter] Route changed to', location.pathname, 're-applying filter:', currentFilterCustomer);
  cachedTags = [];
  applyFilter(currentFilterCustomer || 'ALL');
}

setInterval(() => {
  if (location.pathname !== lastPathname) {
    lastPathname = location.pathname;
    handleRouteChange();
  }
}, 500);

// Seed test data for demo purposes
function seedTestTags() {
  if (!chrome.runtime || !chrome.runtime.id) {
    console.log('[GS4PM Filter] Skipping test data seed - extension context unavailable');
    return;
  }
  
  const pageKey = getPageKey();
  
  chrome.storage.local.get([pageKey, 'gs4pm_customers'], data => {
    if (chrome.runtime.lastError) {
      console.warn('[GS4PM Filter] Could not check for existing tags:', chrome.runtime.lastError.message);
      return;
    }
    const existingTags = data[pageKey] || [];
    
    // Only seed if no tags exist yet
    if (existingTags.length > 0) {
      console.log('[GS4PM Filter] Tags already exist, skipping seed');
      return;
    }
    
    console.log('[GS4PM Filter] Seeding test tags...');
    
    // Ensure customers exist
    const customers = data['gs4pm_customers'] || [];
    const updatedCustomers = [...customers];
    if (!updatedCustomers.includes('Ladbrokes')) updatedCustomers.push('Ladbrokes');
    if (!updatedCustomers.includes('WKND')) updatedCustomers.push('WKND');
    
    // Hardcoded test tags based on reference IDs from the personas
    // Using compound selectors to match BOTH cards AND dropdown options
    // CORRECTED BASED ON ACTUAL HTML data-key VALUES
    const testTags = [
      // Ladbrokes personas (verified from HTML)
      { selector: '[data-omega-attribute-referenceid="Rc691c7ec72417932481c122f7"], [data-key="Rc691c7ec72417932481c122f7"]', customer: 'Ladbrokes' }, // Darts Devotee
      { selector: '[data-omega-attribute-referenceid="Rc691c7ecc770c9e030959527a"], [data-key="Rc691c7ecc770c9e030959527a"]', customer: 'Ladbrokes' }, // Football Fanatic
      { selector: '[data-omega-attribute-referenceid="Rc691dcb1f770c9e0309817a12"], [data-key="Rc691dcb1f770c9e0309817a12"]', customer: 'Ladbrokes' }, // Live Casino Enthusiast
      { selector: '[data-omega-attribute-referenceid="Rc691c7ed02417932481c12568"], [data-key="Rc691c7ed02417932481c12568"]', customer: 'Ladbrokes' }, // Responsible Returner (needs to be found)
      
      // WKND personas (7 cards)
      { selector: '[data-omega-attribute-referenceid="Rc677bf4bbaf536d72a095c1ce"], [data-key="Rc677bf4bbaf536d72a095c1ce"]', customer: 'WKND' },
      { selector: '[data-omega-attribute-referenceid="Rc677bf30eaf536d72a095c1bd"], [data-key="Rc677bf30eaf536d72a095c1bd"]', customer: 'WKND' },
      { selector: '[data-omega-attribute-referenceid="Rc677bf2668c4eb7177f788332"], [data-key="Rc677bf2668c4eb7177f788332"]', customer: 'WKND' },
      { selector: '[data-omega-attribute-referenceid="Rc677bf2057dc0b924845c6e2c"], [data-key="Rc677bf2057dc0b924845c6e2c"]', customer: 'WKND' },
      { selector: '[data-omega-attribute-referenceid="Rc677bf1948c4eb7177f7882f8"], [data-key="Rc677bf1948c4eb7177f7882f8"]', customer: 'WKND' },
      { selector: '[data-omega-attribute-referenceid="Rc677bf1098c4eb7177f7882ca"], [data-key="Rc677bf1098c4eb7177f7882ca"]', customer: 'WKND' },
      { selector: '[data-omega-attribute-referenceid="Rc677bf0a47dc0b924845c6e17"], [data-key="Rc677bf0a47dc0b924845c6e17"]', customer: 'WKND' }
    ];
    
    chrome.storage.local.set({ 
      [pageKey]: testTags,
      'gs4pm_customers': updatedCustomers
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[GS4PM Filter] Could not save test tags:', chrome.runtime.lastError.message);
        return;
      }
      console.log('[GS4PM Filter] Seeded', testTags.length, 'test tags for Ladbrokes and WKND');
      cachedTags = testTags;
    });
  });
}

// Call seed function on load (only runs if no tags exist)
seedTestTags();

// Expose function to console for manual re-seeding
window.reseedGS4PMTags = function() {
  if (!chrome.runtime || !chrome.runtime.id) {
    console.warn('[GS4PM Filter] Cannot reseed - extension context unavailable. Please reload the page first.');
    return;
  }
  
  const pageKey = getPageKey();
  chrome.storage.local.set({ [pageKey]: [] }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[GS4PM Filter] Could not clear tags:', chrome.runtime.lastError.message);
      return;
    }
    console.log('[GS4PM Filter] Cleared existing tags, re-seeding...');
    seedTestTags();
    setTimeout(() => {
      location.reload();
    }, 500);
  });
};

console.log('[GS4PM Filter] 💡 Tip: Run reseedGS4PMTags() in console to reset test data');

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