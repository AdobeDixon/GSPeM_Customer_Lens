# GenStudio Customer Lens 🎯

A Chrome extension that adds customer-focused filtering and tagging to **GenStudio for Performance Marketing (GS4PM)** on `experience.adobe.com`.

## What it does ✨

- Filters GS4PM content by customer (personas, products, assets, templates, and dropdown options).
- Lets you tag tiles/cards and dropdown options with a customer.
- Adds visual badges during tagging so you can see what’s tagged.
- Keeps your active filter and customer list across GS4PM sections.
- Adds a right‑click menu to tag the last clicked item.

## How it works 🧠

- **Popup UI** (`popup.html`, `popup.js`)
  - Choose an active filter.
  - Pick a customer to tag against.
  - Toggle tagging mode on/off.
  - Add new customers.
- **Content script** (`contentScript.js`)
  - Watches the GS4PM DOM and applies filters in real time.
  - Tags elements by storing a unique selector + customer.
  - Adds on‑screen badges while tagging is enabled.
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

## Notes & tips 📝

- The extension is only active on `experience.adobe.com` URLs that include `genstudio`.
- If you reload the extension, refresh the GS4PM tab to re‑initialize content scripts.
- Tags are local to your browser profile (not synced between machines).