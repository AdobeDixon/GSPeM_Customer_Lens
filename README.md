# GenStudio Customer Lens 🎯

A Chrome extension that adds customer-focused filtering and tagging to **GenStudio for Performance Marketing (GS4PM)** on `experience.adobe.com`.

## What it does ✨

- Filters GS4PM content by customer (personas, products, assets, templates, and dropdown options).
- Lets you tag tiles/cards and dropdown options with a customer.
- Adds visual badges during tagging so you can see what’s tagged.
- Keeps your active filter and customer list across GS4PM sections.
- Adds a right‑click menu to tag the last clicked item.
- Optional on-page **Workspace bar** (bottom overlay) so you don’t need to reopen the extension popup.
- Keyboard shortcuts for power-users (see below).

## How it works 🧠

- **Popup UI** (`popup.html`, `popup.js`)
  - Choose an active filter.
  - Pick a customer to tag against.
  - Toggle tagging mode on/off.
  - Add new customers.
- **On-page Workspace bar** (`contentScript.js`)
  - Optional bottom overlay (top-frame only) with quick access to filter, tagging target, and tagging toggle.
- **Content script** (`contentScript.js`)
  - Watches the GS4PM DOM and applies filters in real time.
  - Tags elements by storing a unique selector + customer.
  - Adds on‑screen badges while tagging is enabled.
  - Shows an “Esc to exit tagging” banner (top-frame only) while tagging is enabled.
  - Tracks right‑click targets to support context‑menu tagging.
- **Background service worker** (`background.js`)
  - Builds the right‑click context menu.
  - Broadcasts tag actions to all frames (GS4PM uses iframes).
- **Storage**
  - Customers, active filter, and tags are stored in `chrome.storage.local`.
  - Tag data is scoped per GS4PM page key.

## Install (Chrome) 🧩

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the folder: `GSPeM Demo Extension`.
5. Open GS4PM at `https://experience.adobe.com/...genstudio...`.

## Usage 🚀

1. Click the extension icon to open the popup.
2. Add customers (if you don’t have any yet).
3. Choose **Show content for** to filter the view.
4. Pick a customer in **Tagging** and click **Enable tagging**.
5. Click a tile/card/option in GS4PM to toggle its tag.
6. (Optional) Right‑click any item and choose **Tag element → [customer]**.
7. (Optional) Toggle the **Workspace bar** to get on-page controls without reopening the popup.

## UI overview 🧩

- **Popup**
  - **Filter → “Show content for”**: sets the active customer filter (or “Show all customers”).
  - **Tagging → “Tag items for”**: selects the customer you’ll tag items against.
  - **Enable/Disable tagging**: when enabled, clicks on supported GS4PM tiles/cards/options toggle that item’s tag for the selected customer.
  - **Workspace bar**: shows/hides the bottom on-page overlay (and displays its shortcut).
  - **Add customer**: stored locally; also reachable via right-click → **Tag element → Add new customer…**
  - **Disabled state**: the popup disables controls when the active tab is not a GS4PM URL (must be on `experience.adobe.com` and include `genstudio`).

- **Workspace bar (bottom overlay, optional)**
  - Appears at the bottom of the GS4PM page (top frame only).
  - Provides quick access to: active filter, tagging target, tagging toggle, and a Hide button.
  - Designed to stay usable even when tagging mode is enabled (so you can change settings without exiting tagging).

## Keyboard shortcuts ⌨️

- **Cycle active filter customer**: `Cmd/Ctrl + K`
  - Cycles through `All customers` → each customer in your list.
  - **Reverse direction**: hold **Shift** (`Cmd/Ctrl + Shift + K`).
  - Does not trigger while typing in inputs/textareas/contenteditable fields.

- **Toggle Workspace bar**: `Cmd/Ctrl + Shift + O`
  - Shows/hides the bottom overlay bar.

- **Exit tagging mode**: `Esc`
  - While tagging is enabled, press **Esc** to stop tagging (it broadcasts across frames).

## Notes & tips 📝

- The extension is only active on `experience.adobe.com` URLs that include `genstudio`.
- If you reload the extension, refresh the GS4PM tab to re‑initialize content scripts.
- Tags are local to your browser profile (not synced between machines).