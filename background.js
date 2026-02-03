const CUSTOMER_KEY = 'gs4pm_customers';
const OPEN_ADD_CUSTOMER_KEY = 'gs4pm_open_add_customer';
const MENU_ROOT_ID = 'gs4pm_tag_root';
const MENU_ITEM_PREFIX = 'gs4pm_tag_customer__';
const MENU_SEPARATOR_ID = 'gs4pm_tag_separator';
const MENU_ADD_CUSTOMER_ID = 'gs4pm_tag_add_customer';
const GS4PM_HOST = 'experience.adobe.com';
const GS4PM_TOKEN = 'genstudio';

function isGs4pmUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === GS4PM_HOST && url.toLowerCase().includes(GS4PM_TOKEN);
  } catch (error) {
    return false;
  }
}

function encodeCustomerMenuId(customer) {
  return `${MENU_ITEM_PREFIX}${encodeURIComponent(customer)}`;
}

function decodeCustomerMenuId(menuItemId) {
  if (!menuItemId || !menuItemId.startsWith(MENU_ITEM_PREFIX)) return null;
  return decodeURIComponent(menuItemId.slice(MENU_ITEM_PREFIX.length));
}

function rebuildContextMenu() {
  chrome.storage.local.get([CUSTOMER_KEY], (data) => {
    const customers = Array.isArray(data[CUSTOMER_KEY]) ? data[CUSTOMER_KEY].filter(Boolean) : [];

    // Remove existing context menus first to avoid duplicate ID errors
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_ROOT_ID,
        title: 'Tag element',
        contexts: ['all'],
        documentUrlPatterns: ['https://experience.adobe.com/*']
      });

      if (!customers.length) {
        chrome.contextMenus.create({
          id: `${MENU_ITEM_PREFIX}__none__`,
          title: 'No customers yet',
          parentId: MENU_ROOT_ID,
          enabled: false,
          contexts: ['all'],
          documentUrlPatterns: ['https://experience.adobe.com/*']
        });
      } else {
        customers.forEach((customer) => {
          chrome.contextMenus.create({
            id: encodeCustomerMenuId(customer),
            title: customer,
            parentId: MENU_ROOT_ID,
            contexts: ['all'],
            documentUrlPatterns: ['https://experience.adobe.com/*']
          });
        });
      }

      chrome.contextMenus.create({
        id: MENU_SEPARATOR_ID,
        parentId: MENU_ROOT_ID,
        type: 'separator',
        contexts: ['all'],
        documentUrlPatterns: ['https://experience.adobe.com/*']
      });

      chrome.contextMenus.create({
        id: MENU_ADD_CUSTOMER_ID,
        title: 'Add new customer…',
        parentId: MENU_ROOT_ID,
        contexts: ['all'],
        documentUrlPatterns: ['https://experience.adobe.com/*']
      });
    });
  });
}

// Create context menu items for right-click tagging
chrome.runtime.onInstalled.addListener(() => rebuildContextMenu());
chrome.runtime.onStartup.addListener(() => rebuildContextMenu());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[CUSTOMER_KEY]) rebuildContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (!isGs4pmUrl(tab.url || '')) return;

  if (info.menuItemId === MENU_ADD_CUSTOMER_ID) {
    chrome.storage.local.set({ [OPEN_ADD_CUSTOMER_KEY]: true }, () => {
      if (chrome.action && chrome.action.openPopup) {
        chrome.action.openPopup({ windowId: tab.windowId }).catch((err) => {
          console.warn('[GS4PM Filter] Could not open popup:', err);
        });
      }
    });
    return;
  }

  const customer = decodeCustomerMenuId(info.menuItemId);
  if (customer && customer !== '__none__') {
    broadcastToAllFrames(tab.id, { type: 'TAG_LAST_RIGHT_CLICKED', customer });
  }
});

function broadcastToAllFrames(tabId, message, done) {
  if (!tabId) {
    done?.({ ok: false, error: 'Missing tabId' });
    return;
  }

  // `chrome.webNavigation.getAllFrames` is reliable in the service worker.
  chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
    if (chrome.runtime.lastError || !frames || !frames.length) {
      // Fallback: top frame only
      chrome.tabs.sendMessage(tabId, message, () => {
        done?.({
          ok: !chrome.runtime.lastError,
          fallback: true,
          error: chrome.runtime.lastError?.message
        });
      });
      return;
    }

    let pending = frames.length;
    let successCount = 0;
    let errorCount = 0;

    frames.forEach((frame) => {
      chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId }, () => {
        if (chrome.runtime.lastError) errorCount++;
        else successCount++;

        pending--;
        if (pending === 0) {
          done?.({ ok: true, frameCount: frames.length, successCount, errorCount });
        }
      });
    });
  });
}

// Popup -> background broadcaster (needed for iframe-based apps like GenStudio Thunderbird).
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (!req || req.type !== 'GS4PM_BROADCAST') return;

  const { tabId, message } = req;
  broadcastToAllFrames(tabId, message, (result) => sendResponse(result));
  return true; // keep message channel open for async sendResponse
});