# GenStudio Customer Lens

Customer Lens is a Chrome extension that helps you organize **GenStudio for Performance Marketing (GS4PM)** content by customer.

It works on `experience.adobe.com` pages where the URL includes `genstudio`.

Repository: [https://github.com/AdobeDixon/GSPeM_Customer_Lens](https://github.com/AdobeDixon/GSPeM_Customer_Lens)

## Why this extension exists

GS4PM can contain many items across different customers. Customer Lens lets you:

- tag GS4PM items with a customer name
- filter the page to show items for one customer
- keep your customer setup and filter saved locally

This makes it easier to focus on one customer at a time.

## What it can do

- **Filter content by customer**
  - Filter personas, products, assets, templates, and supported dropdown options.
- **Tag items in the page**
  - Turn on tagging mode, click an item, and toggle whether it belongs to the selected customer.
- **Right-click tagging**
  - Right-click an item and choose `Tag element -> [customer]`.
  - You can also choose `Add new customer...` from the same menu.
- **Visual tagging helpers**
  - Shows badges/overlays in tagging mode so you can see tagged targets clearly.
- **Keyboard shortcuts**
  - `Cmd/Ctrl + K`: cycle active filter customer
  - `Cmd/Ctrl + Shift + K`: cycle filter in reverse
  - `Cmd/Ctrl + Shift + O`: show/hide Workspace bar
  - `Esc`: exit tagging mode
- **Workspace bar (optional, on-page controls)**
  - A bottom overlay in the top frame for quick filter/tag controls without reopening the popup.
- **Works across iframe-based GS4PM UI**
  - Broadcasts actions to all frames so filtering and tagging stay consistent.
- **Local persistence**
  - Customers, active filter, and tags are saved in `chrome.storage.local`.

## Installation (Chrome, step-by-step)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this project folder: `GSPeM Demo Extension`.
5. Pin the extension (optional but recommended).
6. Open GS4PM on `https://experience.adobe.com/...genstudio...`.

If the extension was already loaded and you made code changes:

- click **Reload** on the extension card in `chrome://extensions`
- refresh the GS4PM tab

## First-time setup (recommended)

1. Open GS4PM in Chrome.
2. Click the Customer Lens extension icon.
3. Add one or more customers in **Add customer**.
4. In **Filter**, choose which customer to show.
5. In **Tagging**, select a customer and click **Enable tagging**.
6. Click GS4PM items to add/remove tags for that customer.
7. Press `Esc` when you want to stop tagging.

## How to use each area

### Popup

- **Filter -> Show content for**
  - Applies your current customer filter immediately.
- **Tagging -> Tag items for**
  - Sets the customer used for tagging clicks.
- **Enable/Disable tagging**
  - Turns tagging mode on/off.
- **Add customer**
  - Stores a new customer name locally in your browser.
- **GitHub link**
  - Opens the project repository.

### Workspace bar (optional)

- Appears on the GS4PM page (top frame).
- Gives quick controls for filter, tag target, tagging toggle, and quick-add customer.
- Useful when you want to keep working without reopening the popup.

## Data and scope

- This extension runs only on `experience.adobe.com` URLs that include `genstudio`.
- GS4PM may render content in iframes; this extension is designed to handle that.
- Data is stored locally in your browser profile (not synced automatically between machines).

## Troubleshooting

- **Popup controls are disabled**
  - Make sure the active tab is a GS4PM URL on `experience.adobe.com` that includes `genstudio`.
- **Tagging/filter changes are not visible**
  - Refresh the GS4PM page and try again.
  - If you recently reloaded the extension, refresh the tab after reload.
- **Right-click menu not appearing**
  - Right-click directly on a supported GS4PM item and ensure the extension is loaded.

## Project files (quick reference)

- `manifest.json`: Chrome extension configuration
- `background.js`: context menu and message broadcasting
- `contentScript.js`: filtering, tagging logic, overlays, workspace bar
- `popup.html` and `popup.js`: popup interface and controls

