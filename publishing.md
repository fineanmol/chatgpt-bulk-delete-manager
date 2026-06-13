# Publishing Guide: ChatGPT Bulk Delete Manager

This guide walks you through the steps to package, list, and publish your new extension on the **Chrome Web Store**.

---

## Step 1: Package the Extension into a ZIP file

Chrome Web Store submissions require a single ZIP file containing your extension assets.

1. Open your terminal.
2. Navigate to your project directory.
3. Run the following command to compress only the required files (excluding system junk like `.DS_Store` or `.git` files):
   ```bash
   cd "/Users/fineanmol/Desktop/Browser Extension/chatgpt-bulk-delete"
   zip -r chatgpt-bulk-delete.zip manifest.json content.js styles.css icon16.png icon48.png icon128.png publishing.md
   ```
4. This will output a file named `chatgpt-bulk-delete.zip` inside the extension directory.

---

## Step 2: Create a Chrome Web Store Developer Account

1. Go to the **[Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole)**.
2. Sign in with the Google Account you wish to associate with your extension.
3. Accept the Developer Agreement.
4. Pay the one-time **$5 USD** developer registration fee (required by Google to prevent spam store submissions).

---

## Step 3: Upload Your ZIP File

1. In the Chrome Developer Console, click the **"New Item"** button in the top right.
2. Click **"Browse files"** and select the `chatgpt-bulk-delete.zip` file you created in Step 1.
3. Google will parse the `manifest.json` and create your item draft.

---

## Step 4: Complete the Store Listing Metadata

Fill in the following details on the **"Store listing"** page:

* **Product Title:** `ChatGPT Bulk Delete Manager`
* **Short Description:** `Multi-select, preview, backup, and batch delete ChatGPT conversations directly in the browser for free.`
* **Detailed Description:** Use a professional summary detailing the features:
  ```text
  Quickly manage, backup, and bulk delete your ChatGPT history!

  Are you running out of sidebar space or looking to clean up hundreds of old ChatGPT conversations? ChatGPT Bulk Delete Manager gives you a desktop-grade dashboard to clean up your workspace in seconds for free!

  Key Features:
  - 🚀 Live Dialogue Previews: View full message logs directly inside the preview drawer before selecting or deleting, so you never lose important chats.
  - 💾 Mass Markdown Backups: Download selected chats as a single Markdown document to keep local archives before deletion.
  - 🔄 Invert & Quick Filters: Select untitled "New Chats", chats older than 7d/30d, or invert your current selection in one click.
  - 🛡️ Safe Deletion Queue: Sequentially deletes chats with customizable safety delays to prevent API rate limiting.
  - ⌨️ Keyboard Shortcut: Press Alt+B (or Option+B on Mac) to instantly toggle the dashboard.
  - 🔒 100% Private & Local: Operates entirely in your browser using your active session. No external servers, no tracking, and no third-party APIs.
  ```
* **Category:** Select `Productivity` or `Developer Tools`.
* **Language:** Select `English`.
* **Graphics Assets:**
  * **Icon:** The `icon128.png` we created matches Chrome's 128x128 requirement.
  * **Screenshots:** Provide at least one 1280x800 or 640x400 screenshot of the open 3-panel dashboard.

---

## Step 5: Configure Privacy & Justify Permissions (Crucial!)

Google holds extension developers to strict privacy policies. Fill out the **"Privacy"** tab with these details:

1. **Single Purpose Description:**
   * *State clearly:* `The single purpose of this extension is to provide a local dashboard interface to allow users to search, preview, backup, and batch delete conversations from their active ChatGPT web session.`
2. **Permission Justifications:**
   * **`activeTab`**: `This permission is used to inject the manager overlay stylesheet and logic elements into the active ChatGPT page when the user opens the dashboard.`
   * **Host Permissions (`https://chatgpt.com/*`, `https://chat.openai.com/*`)**: `These host permissions are required to allow the content script to query the web session endpoint (/api/auth/session) for authentication, retrieve conversation pagination lists (/backend-api/conversations), pull chat logs for live previewing (/backend-api/conversation/{id}), and send visibility updates to delete conversations on those specific domains.`
3. **Data Usage Declaration:**
   * Select **"No"** to: *“Does this extension collect or transmit user data?”*
   * Check the boxes confirming you do not sell data, use data for marketing, or transfer data to third-party brokers. (The extension runs 100% locally in the sandbox).

---

## Step 6: Submit for Review

1. Click the **"Submit for review"** button in the top right.
2. Select whether to publish the extension automatically after approval, or manually.
3. Review times typically take **1 to 3 business days** (Google will run automated scanners on the code and verify the permission declarations before pushing it live to the Chrome Web Store).
