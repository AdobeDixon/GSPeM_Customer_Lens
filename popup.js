const CUSTOMER_KEY = 'gs4pm_customers';
const CURRENT_CUSTOMER_KEY = 'gs4pm_current_customer';
const ACTIVE_FILTER_KEY = 'gs4pm_active_filter_customer';
const TAGGING_ENABLED_KEY = 'gs4pm_tagging_enabled';
const OPEN_ADD_CUSTOMER_KEY = 'gs4pm_open_add_customer';
const DEFAULT_CUSTOMERS = [];
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

function sendMessageToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs.length) return;
    const activeTab = tabs[0];
    if (!isGs4pmUrl(activeTab.url || '')) return;
    const tabId = activeTab.id;
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        console.log('[GS4PM Filter][popup] No receiver for', message.type, '-', chrome.runtime.lastError.message);
      }
    });
  });
}

const filterSelect = document.getElementById('filter-customer-select');
const tagSelect = document.getElementById('tag-customer-select');
const toggleTaggingBtn = document.getElementById('toggle-tagging');
const newCustomerInput = document.getElementById('new-customer');
const addCustomerBtn = document.getElementById('add-customer');
const disabledSection = document.getElementById('disabled-section');

let taggingEnabled = false;

function setUiDisabled(disabled) {
  if (disabledSection) disabledSection.hidden = !disabled;
  [filterSelect, tagSelect, toggleTaggingBtn, newCustomerInput, addCustomerBtn].forEach((el) => {
    if (!el) return;
    el.disabled = !!disabled;
  });
}

function focusAddCustomerInput() {
  if (!newCustomerInput) return;
  newCustomerInput.scrollIntoView({ block: 'center' });
  newCustomerInput.focus();
  newCustomerInput.select();
}

function checkOpenAddCustomerFlag() {
  chrome.storage.local.get([OPEN_ADD_CUSTOMER_KEY], (data) => {
    if (!data[OPEN_ADD_CUSTOMER_KEY]) return;
    chrome.storage.local.set({ [OPEN_ADD_CUSTOMER_KEY]: false }, () => {
      focusAddCustomerInput();
    });
  });
}

function saveCurrentCustomer(value) {
  chrome.storage.local.set({ [CURRENT_CUSTOMER_KEY]: value });
}

function saveActiveFilter(value) {
  chrome.storage.local.set({ [ACTIVE_FILTER_KEY]: value });
}

function saveTaggingEnabled(value) {
  chrome.storage.local.set({ [TAGGING_ENABLED_KEY]: value });
}

function updateTaggingButtonUI() {
  if (taggingEnabled) {
    toggleTaggingBtn.classList.remove('off');
    toggleTaggingBtn.textContent = 'Disable tagging';
  } else {
    toggleTaggingBtn.classList.add('off');
    toggleTaggingBtn.textContent = 'Enable tagging';
  }
}

function renderCustomers(customers, currentTagCustomer, activeFilter) {
  // Build filter dropdown
  filterSelect.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'ALL';
  allOpt.textContent = 'Show all customers';
  filterSelect.appendChild(allOpt);

  customers.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    filterSelect.appendChild(opt);
  });

  const safeFilter =
    activeFilter && (activeFilter === 'ALL' || customers.includes(activeFilter))
      ? activeFilter
      : 'ALL';

  filterSelect.value = safeFilter;
  saveActiveFilter(safeFilter);

  // Build tag dropdown
  tagSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '__NONE__';
  placeholder.textContent = 'Select customer…';
  tagSelect.appendChild(placeholder);

  customers.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    tagSelect.appendChild(opt);
  });

  if (currentTagCustomer && currentTagCustomer !== '__ALL__' && customers.includes(currentTagCustomer)) {
    tagSelect.value = currentTagCustomer;
  } else if (safeFilter !== 'ALL') {
    tagSelect.value = safeFilter;
    saveCurrentCustomer(safeFilter);
  } else {
    tagSelect.value = '__NONE__';
    saveCurrentCustomer('__ALL__');
  }

  // Apply initial filter to active tab
  sendMessageToActiveTab({
    type: 'SET_FILTER',
    customer: safeFilter === 'ALL' ? 'ALL' : safeFilter
  });
}

function loadStateAndCustomers() {
  chrome.storage.local.get(
    [CUSTOMER_KEY, CURRENT_CUSTOMER_KEY, ACTIVE_FILTER_KEY, TAGGING_ENABLED_KEY],
    (data) => {
      let customers = data[CUSTOMER_KEY];
      const currentTagCustomer = data[CURRENT_CUSTOMER_KEY];
      const activeFilter = data[ACTIVE_FILTER_KEY];
      taggingEnabled = !!data[TAGGING_ENABLED_KEY];

      if (!customers || customers.length === 0) {
        customers = [...DEFAULT_CUSTOMERS];
        chrome.storage.local.set({ [CUSTOMER_KEY]: customers });
      }

      renderCustomers(customers, currentTagCustomer, activeFilter);
      updateTaggingButtonUI();

      // Sync tagging state with the active tab
      const effectiveTagCustomer =
        tagSelect.value && tagSelect.value !== '__NONE__' ? tagSelect.value : null;

      if (taggingEnabled && effectiveTagCustomer) {
        saveCurrentCustomer(effectiveTagCustomer);
        sendMessageToActiveTab({
          type: 'START_TAGGING',
          customer: effectiveTagCustomer
        });
      } else {
        sendMessageToActiveTab({ type: 'STOP_TAGGING' });
      }
    }
  );
}

// Add customer
addCustomerBtn.addEventListener('click', () => {
  const name = newCustomerInput.value.trim();
  if (!name) return;

  chrome.storage.local.get([CUSTOMER_KEY], (data) => {
    const existing = data[CUSTOMER_KEY] || [];
    if (!existing.includes(name)) {
      const updated = [...existing, name];
      chrome.storage.local.set({ [CUSTOMER_KEY]: updated }, () => {
        newCustomerInput.value = '';
        renderCustomers(updated, name, name);
        saveCurrentCustomer(name);
        saveActiveFilter(name);
      });
    } else {
      renderCustomers(existing, name, name);
      saveCurrentCustomer(name);
      saveActiveFilter(name);
    }
  });
});

// Filter select – automatically apply filter on change
filterSelect.addEventListener('change', () => {
  const val = filterSelect.value;
  const normalized = !val || val === 'ALL' ? 'ALL' : val;
  saveActiveFilter(normalized);

  if ((tagSelect.value === '__NONE__' || !tagSelect.value) && normalized !== 'ALL') {
    tagSelect.value = normalized;
    saveCurrentCustomer(normalized);
  }

  sendMessageToActiveTab({
    type: 'SET_FILTER',
    customer: normalized === 'ALL' ? 'ALL' : normalized
  });
});

// Tag select – controls CURRENT_CUSTOMER_KEY and live tagging target
tagSelect.addEventListener('change', () => {
  const val = tagSelect.value;
  if (!val || val === '__NONE__') {
    saveCurrentCustomer('__ALL__');
    if (taggingEnabled) {
      taggingEnabled = false;
      saveTaggingEnabled(false);
      updateTaggingButtonUI();
      sendMessageToActiveTab({ type: 'STOP_TAGGING' });
    }
    return;
  }

  saveCurrentCustomer(val);

  if (taggingEnabled) {
    sendMessageToActiveTab({ type: 'STOP_TAGGING' });
    sendMessageToActiveTab({ type: 'START_TAGGING', customer: val });
  }
});

// Tagging toggle button
toggleTaggingBtn.addEventListener('click', () => {
  let tagCustomer = tagSelect.value;

  if (!taggingEnabled) {
    // Turning ON
    if (!tagCustomer || tagCustomer === '__NONE__' || tagCustomer === 'ALL') {
      const filterVal = filterSelect.value;
      if (filterVal && filterVal !== 'ALL') {
        tagCustomer = filterVal;
        tagSelect.value = filterVal;
      }
    }

    if (!tagCustomer || tagCustomer === '__NONE__' || tagCustomer === 'ALL') {
      console.log('[GS4PM Filter][popup] Cannot enable tagging – no customer selected.');
      taggingEnabled = false;
      saveTaggingEnabled(false);
      updateTaggingButtonUI();
      return;
    }

    taggingEnabled = true;
    saveTaggingEnabled(true);
    updateTaggingButtonUI();

    console.log('[GS4PM Filter][popup] Enabling tagging for customer', tagCustomer);
    saveCurrentCustomer(tagCustomer);
    sendMessageToActiveTab({ type: 'START_TAGGING', customer: tagCustomer });
  } else {
    // Turning OFF
    taggingEnabled = false;
    saveTaggingEnabled(false);
    updateTaggingButtonUI();

    console.log('[GS4PM Filter][popup] Disabling tagging');
    sendMessageToActiveTab({ type: 'STOP_TAGGING' });
  }
});

// Initial load
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const activeTab = tabs && tabs.length ? tabs[0] : null;
  const isAllowed = isGs4pmUrl(activeTab?.url || '');
  setUiDisabled(!isAllowed);
  if (!isAllowed) return;
  loadStateAndCustomers();
  checkOpenAddCustomerFlag();
});
