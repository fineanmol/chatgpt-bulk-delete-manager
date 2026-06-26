# 🤖 Bulk Delete ChatGPT History & Chat Cleaner (v1.2.3)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Brave-emerald)](https://developer.chrome.com/docs/extensions/)
[![Manifest Version](https://img.shields.io/badge/Manifest-V3-green)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Local-blue)](#-privacy--security)

A modern, desktop-grade dashboard Chrome Extension to bulk-select, preview, backup, and batch-delete or archive your ChatGPT conversations directly in the browser for free. No OpenAI API keys required!

🔒 **[View Our Privacy Policy](https://fineanmol.github.io/chatgpt-bulk-delete-manager/privacy.html)**

---

## ✨ Features

* **3-Panel Dashboard Layout:**
  * **Left Panel:** Statistics (Total Chats, Selected Chats, Est. Process Time), delay controls, action mode selection, and quick filters.
  * **Center Panel:** Scrollable list of chats rendered in a clean, single-column card grid to prevent title overlap.
  * **Right Panel:** A **live dialogue preview window** showing user and ChatGPT dialogue bubbles.
* **Native Archive & Delete Modes:** Switch between permanently deleting conversations (`is_visible: false`) or natively archiving them (`is_archived: true`) to keep your ChatGPT sidebar tidy.
* **Deep Dialogue Search:** Search through chat titles AND the full dialogue contents of previewed chats instantly to locate specific topics.
* **Celebratory Growth Loop:** Interactive success-share toasts appear after bulk cleanups, allowing users to tweet their clean workspace to Twitter/X or leave a review in one click.
* **Mass Backup Export:** Download selected conversations in a single, structured Markdown (`.md`) file to keep a local archive of your chats.
* **On-Demand Previews:** Fetches dialogues from the private web session, tracing nodes dynamically from the active leaf pointer up to the root to build chronological threads.
* **Quick Filter Buttons:** Select untitled placeholder chats ("New Chat", "Untitled"), chats older than 7 days, or chats older than 30 days.
* **Select All on Page:** A checkbox to instantly toggle selection for all 10 visible card items on the current page.
* **Invert Selections:** Instantly toggle checkboxes to inverse your current search selection.
* **Safe Deletion Queue:** Sequentially deletes/archives conversations with custom safety delays (`0.5s` to `3.0s`) to avoid triggering ChatGPT's API rate limits or account warnings.
* **Bulletproof Visibility Fallbacks:** Launch the dashboard via:
  * Injected sidebar button.
  * A floating, glowing green **"Bulk Clean"** capsule in the bottom-right corner of the page.
  * Pressing **`Option + B`** (or **`Alt + B`** on Windows) at any time.

---

## 🔒 Privacy & Security

* 📑 **[Read our official Privacy Policy](https://fineanmol.github.io/chatgpt-bulk-delete-manager/privacy.html)**
* **100% Local Execution:** Runs completely within your active browser tab sandbox.
* **No Telemetry / External Servers:** The extension does not collect, track, or transmit any user data. Your session tokens and chat contents remain private to you.
* **Open Source:** Review, build, and modify the source code locally.

---

## 🚀 Installation (Load Unpacked Developer Mode)

Since this is a developer extension, you can load it locally:

1. Clone or download this repository to your computer.
2. Open **Google Chrome** and navigate to `chrome://extensions/`.
3. Toggle the **"Developer mode"** switch in the top-right corner to **ON**.
4. In the top-left corner, click the **"Load unpacked"** button.
5. Select the `chatgpt-bulk-delete` folder.
6. Navigate to **[chatgpt.com](https://chatgpt.com)** and log in.
7. Open the manager by clicking the **"Bulk Clean"** capsule widget or pressing **`Option + B`**!

---

## 🛠️ Tech Stack

* **Core:** Vanilla JavaScript (Manifest V3 Content Scripts)
* **Styling:** Custom CSS incorporating ChatGPT brand green accents, backdrop blurs, HSL-tailored colors, smooth animations, and glowing highlights.
* **APIs:** Integrates directly with ChatGPT's internal endpoints:
  * `/api/auth/session` (gets access token)
  * `/backend-api/conversations` (reads chat history page list)
  * `/backend-api/conversation/{id}` (reads dialogue messages thread)
  * `PATCH /backend-api/conversation/{id}` (marks chats as invisible or archived)

---

## 📄 License

Licensed under the **MIT License**. See [LICENSE](LICENSE) for details.
