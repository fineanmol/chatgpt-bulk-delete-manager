// ChatGPT Bulk Delete Manager - Content Script (Live Preview, Backup & Toast Edition)

(function() {
  let accessToken = null;
  let allConversations = [];
  let selectedIds = new Set();
  let currentPreviewId = null;
  let isDeleting = false;
  let cancelRequested = false;

  // Initialize
  function init() {
    // Inject launcher elements periodically to handle dynamic SPA changes
    setInterval(injectSidebarButton, 2000);
    setInterval(injectFloatingCapsule, 2000);

    // Initial triggers
    injectSidebarButton();
    injectFloatingCapsule();

    // Register Keyboard Shortcut: Alt + B (Option + B on Mac)
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        toggleManagerModal();
      }
    });
  }

  // Toggle modal display state
  function toggleManagerModal() {
    const modal = document.querySelector('.cbd-modal-overlay');
    if (!modal) {
      openManagerModal();
    } else {
      if (modal.classList.contains('active')) {
        closeManagerModal();
      } else {
        openManagerModal();
      }
    }
  }

  // Inject sidebar button
  function injectSidebarButton() {
    if (document.querySelector('.cbd-sidebar-btn')) return;

    const sidebarNav = document.querySelector('nav') || 
                      document.querySelector('#stage-slideover-sidebar nav') ||
                      document.querySelector('[role="navigation"]');

    if (sidebarNav) {
      const btn = document.createElement('button');
      btn.className = 'cbd-sidebar-btn';
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
        Bulk Manager
      `;
      btn.addEventListener('click', openManagerModal);

      const firstChild = sidebarNav.firstChild;
      if (firstChild) {
        sidebarNav.insertBefore(btn, firstChild.nextSibling || firstChild);
      } else {
        sidebarNav.appendChild(btn);
      }
    }
  }

  // Inject floating action capsule
  function injectFloatingCapsule() {
    if (document.querySelector('.cbd-capsule-launcher')) return;

    const capsule = document.createElement('div');
    capsule.className = 'cbd-capsule-launcher';
    capsule.title = 'Open ChatGPT Bulk Manager (Alt + B)';
    capsule.innerHTML = `
      <div class="cbd-capsule-pulse"></div>
      <div class="cbd-capsule-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </div>
      <span class="cbd-capsule-text">Bulk Clean</span>
    `;

    capsule.addEventListener('click', toggleManagerModal);
    document.body.appendChild(capsule);
  }

  // Fetch Session Access Token
  async function fetchAccessToken() {
    try {
      const response = await fetch('/api/auth/session');
      if (!response.ok) throw new Error('Session request failed');
      const data = await response.json();
      if (!data.accessToken) throw new Error('No access token in session JSON');
      accessToken = data.accessToken;
      return accessToken;
    } catch (error) {
      console.error('[Bulk Manager] Error getting token:', error);
      return null;
    }
  }

  // Fetch and Load Chats History
  async function loadConversations(gridEl) {
    gridEl.innerHTML = `
      <div class="cbd-loader-container">
        <div class="cbd-spinner"></div>
        <span>Connecting to session...</span>
      </div>
    `;

    const token = await fetchAccessToken();
    if (!token) {
      gridEl.innerHTML = `
        <div class="cbd-loader-container">
          <span style="color: #f87171; text-align: center; font-size: 14px;">
            🔒 Session Expired or Unauthorized.<br>Please refresh ChatGPT and log in.
          </span>
          <button class="cbd-action-btn cbd-btn-secondary" id="cbd-retry-auth">Retry Connection</button>
        </div>
      `;
      document.getElementById('cbd-retry-auth')?.addEventListener('click', () => loadConversations(gridEl));
      return;
    }

    gridEl.innerHTML = `
      <div class="cbd-loader-container">
        <div class="cbd-spinner"></div>
        <span>Retrieving conversations...</span>
      </div>
    `;

    let offset = 0;
    const limit = 50;
    allConversations = [];
    selectedIds.clear();
    currentPreviewId = null;
    updateStats();
    resetPreviewPanel();

    try {
      let hasMore = true;
      while (hasMore) {
        gridEl.innerHTML = `
          <div class="cbd-loader-container">
            <div class="cbd-spinner"></div>
            <span>Fetched ${allConversations.length} items...</span>
          </div>
        `;

        const response = await fetch(`/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch offset ${offset}`);
        }

        const data = await response.json();

        if (data.items && data.items.length > 0) {
          allConversations = allConversations.concat(data.items);
          offset += data.items.length;
          
          if (data.items.length < limit || allConversations.length >= data.total) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }

        await new Promise(r => setTimeout(r, 100));
      }

      renderConversationsGrid(allConversations);
      updateStats();

    } catch (error) {
      console.error('[Bulk Manager] Error fetching conversation list:', error);
      gridEl.innerHTML = `
        <div class="cbd-loader-container">
          <span style="color: #f87171;">Failed to fetch chat history.</span>
          <button class="cbd-action-btn cbd-btn-secondary" id="cbd-retry-load">Retry Loading</button>
        </div>
      `;
      document.getElementById('cbd-retry-load')?.addEventListener('click', () => loadConversations(gridEl));
    }
  }

  // Render conversations inside the central grid
  function renderConversationsGrid(conversations) {
    const gridEl = document.querySelector('.cbd-grid-container');
    if (!gridEl) return;

    if (conversations.length === 0) {
      gridEl.innerHTML = `
        <div style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px; color: #8e8ea0;">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 12px; opacity: 0.5;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="8" y1="12" x2="16" y2="12"></line>
          </svg>
          No conversations found.
        </div>
      `;
      return;
    }

    let html = '';
    conversations.forEach(chat => {
      const isChecked = selectedIds.has(chat.id) ? 'checked' : '';
      const isPreviewing = currentPreviewId === chat.id ? 'previewing' : '';
      const formattedDate = formatDate(chat.update_time || chat.create_time);
      const relativeTime = getRelativeTime(chat.update_time || chat.create_time);
      const isUntitled = isChatUntitled(chat);
      const untitledBadge = isUntitled ? '<span class="cbd-card-badge-untitled">Untitled</span>' : '';

      html += `
        <div class="cbd-card ${isChecked ? 'selected' : ''} ${isPreviewing}" data-id="${chat.id}">
          <div class="cbd-card-checkbox-wrapper">
            <input type="checkbox" class="cbd-checkbox cbd-card-cb" data-id="${chat.id}" ${isChecked}>
          </div>
          <div class="cbd-card-info">
            <div class="cbd-card-title-row">
              <span class="cbd-card-title" title="${escapeHTML(chat.title || 'Untitled Chat')}">${escapeHTML(chat.title || 'Untitled Chat')}</span>
              ${untitledBadge}
            </div>
            <div class="cbd-card-time" title="Last updated: ${formattedDate}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline; vertical-align:middle; margin-right:4px;">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              ${relativeTime}
            </div>
          </div>
        </div>
      `;
    });

    gridEl.innerHTML = html;

    // Attach click listeners to cards
    gridEl.querySelectorAll('.cbd-card').forEach(card => {
      const cb = card.querySelector('.cbd-card-cb');
      const id = card.getAttribute('data-id');

      // Click card details: triggers live preview
      card.querySelector('.cbd-card-info').addEventListener('click', () => {
        triggerPreview(card, id);
      });

      // Click checkbox directly: toggles selection for deletion
      cb.addEventListener('change', () => {
        toggleCardSelection(card, id, cb.checked);
      });
    });
  }

  // Toggle card select state for deletion
  function toggleCardSelection(cardEl, id, isSelected) {
    if (isSelected) {
      selectedIds.add(id);
      cardEl.classList.add('selected');
    } else {
      selectedIds.delete(id);
      cardEl.classList.remove('selected');
    }
    updateStats();
  }

  // Update selection statistics in the sidebar
  function updateStats() {
    const totalCount = allConversations.length;
    const selectedCount = selectedIds.size;
    const delay = parseInt(document.getElementById('cbd-delay-slider')?.value || '1000', 10);
    const estSecs = Math.round((selectedCount * delay) / 1000);

    const totalEl = document.getElementById('cbd-stat-total');
    const selectedEl = document.getElementById('cbd-stat-selected');
    const timeEl = document.getElementById('cbd-stat-time');

    if (totalEl) totalEl.innerText = totalCount;
    if (selectedEl) selectedEl.innerText = selectedCount;
    if (timeEl) timeEl.innerText = `${estSecs}s`;

    const deleteBtn = document.getElementById('cbd-delete-btn');
    if (deleteBtn) {
      deleteBtn.innerText = `Delete Selected (${selectedCount})`;
      deleteBtn.disabled = selectedCount === 0;
    }

    const exportBtn = document.getElementById('cbd-export-btn');
    if (exportBtn) {
      exportBtn.innerText = `Backup Selected (${selectedCount})`;
      exportBtn.disabled = selectedCount === 0;
    }
  }

  // Open the main 3-panel split dashboard modal
  function openManagerModal() {
    let modal = document.querySelector('.cbd-modal-overlay');
    if (!modal) {
      modal = createDashboardDOM();
      document.body.appendChild(modal);
    }

    setTimeout(() => modal.classList.add('active'), 50);

    const gridContainer = modal.querySelector('.cbd-grid-container');
    loadConversations(gridContainer);
  }

  // Close the bulk manager modal
  function closeManagerModal() {
    const modal = document.querySelector('.cbd-modal-overlay');
    if (modal) {
      modal.classList.remove('active');
      if (isDeleting) {
        cancelRequested = true;
      }
    }
  }

  // Reset the right-hand preview panel back to the default empty state
  function resetPreviewPanel() {
    const titleEl = document.getElementById('cbd-preview-title');
    const externalLink = document.getElementById('cbd-preview-external');
    const bodyEl = document.getElementById('cbd-preview-body');

    if (titleEl) titleEl.innerText = 'Dialogue Preview';
    if (externalLink) {
      externalLink.style.display = 'none';
      externalLink.href = '#';
    }
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="cbd-preview-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="36" height="36" style="margin-bottom: 12px; opacity: 0.4;">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <span>Select any conversation card on the left to preview its chat history.</span>
        </div>
      `;
    }
  }

  // Fetch chat history for selected conversation and render dialogue thread
  async function triggerPreview(cardEl, id) {
    // Remove previewing highlights from all other cards
    document.querySelectorAll('.cbd-card').forEach(card => card.classList.remove('previewing'));
    
    // Highlight active card
    cardEl.classList.add('previewing');
    currentPreviewId = id;

    const titleEl = document.getElementById('cbd-preview-title');
    const externalLink = document.getElementById('cbd-preview-external');
    const bodyEl = document.getElementById('cbd-preview-body');

    const chat = allConversations.find(c => c.id === id);
    const title = chat ? (chat.title || 'Untitled Chat') : 'Selected Chat';
    
    titleEl.innerText = title;
    externalLink.style.display = 'flex';
    externalLink.href = `https://chatgpt.com/c/${id}`;

    bodyEl.innerHTML = `
      <div class="cbd-preview-loading">
        <div class="cbd-spinner"></div>
        <span>Retrieving messages...</span>
      </div>
    `;

    try {
      const token = accessToken || await fetchAccessToken();
      if (!token) throw new Error('No auth token available');

      const response = await fetch(`/backend-api/conversation/${id}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) throw new Error('Failed to retrieve chat messages');

      const data = await response.json();
      
      if (currentPreviewId !== id) return;

      const messages = getActiveConversationThread(data);
      renderMessages(bodyEl, messages);

    } catch (error) {
      console.error('[Bulk Manager] Error previewing conversation:', error);
      if (currentPreviewId === id) {
        bodyEl.innerHTML = `
          <div class="cbd-preview-empty" style="color: #fca5a5;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24" style="margin-bottom: 8px;">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>Could not load chat dialogue.<br>Verify you are logged in and connected.</span>
          </div>
        `;
      }
    }
  }

  // Trace thread from leaf node to root node
  function getActiveConversationThread(data) {
    const thread = [];
    if (!data || !data.mapping || !data.current_node) return [];

    let currentNodeId = data.current_node;
    const mapping = data.mapping;

    while (currentNodeId && mapping[currentNodeId]) {
      const node = mapping[currentNodeId];
      const msg = node.message;

      if (msg && msg.content && msg.content.parts && msg.author) {
        const role = msg.author.role;
        if (role === 'user' || role === 'assistant') {
          const text = msg.content.parts.map(part => {
            if (typeof part === 'string') return part;
            if (typeof part === 'object' && part.text) return part.text;
            return '';
          }).join('\n').trim();

          if (text) {
            thread.push({
              id: msg.id,
              role: role,
              text: text
            });
          }
        }
      }
      currentNodeId = node.parent;
    }

    return thread.reverse();
  }

  // Render dialogue thread list
  function renderMessages(containerEl, messages) {
    if (messages.length === 0) {
      containerEl.innerHTML = `
        <div class="cbd-preview-empty">
          <span>Conversation has no message history.</span>
        </div>
      `;
      return;
    }

    let html = '';
    messages.forEach(msg => {
      const isUser = msg.role === 'user';
      const bubbleClass = isUser ? 'cbd-bubble-user' : 'cbd-bubble-assistant';
      const avatarSvg = isUser ? 
        `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cbd-avatar-svg"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>` : 
        `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cbd-avatar-svg"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path><path d="M2 12h20"></path></svg>`;

      html += `
        <div class="cbd-bubble-wrapper ${isUser ? 'align-right' : 'align-left'}">
          <div class="cbd-bubble-meta">
            ${avatarSvg}
            <span>${isUser ? 'You' : 'ChatGPT'}</span>
          </div>
          <div class="cbd-bubble ${bubbleClass}">
            ${escapeHTML(msg.text).replace(/\n/g, '<br>')}
          </div>
        </div>
      `;
    });

    containerEl.innerHTML = html;
    containerEl.scrollTop = containerEl.scrollHeight;
  }

  // Invert Selection Toggle
  function invertSelection() {
    const query = document.getElementById('cbd-search').value.toLowerCase();
    const filtered = allConversations.filter(c => 
      (c.title || '').toLowerCase().includes(query)
    );

    filtered.forEach(chat => {
      if (selectedIds.has(chat.id)) {
        selectedIds.delete(chat.id);
      } else {
        selectedIds.add(chat.id);
      }
    });

    renderConversationsGrid(filtered);
    updateStats();
  }

  // Backup and Export Selected Conversations to Markdown File
  async function exportSelectedConversations() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const exportBtn = document.getElementById('cbd-export-btn');
    const originalText = exportBtn.innerText;
    exportBtn.disabled = true;

    let markdownContent = `# ChatGPT Conversation Backup\n*Generated on ${new Date().toLocaleDateString()}*\n\n---\n\n`;
    
    try {
      const token = accessToken || await fetchAccessToken();
      if (!token) throw new Error('Session unauthorized or expired');

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const chat = allConversations.find(c => c.id === id);
        const title = chat ? (chat.title || 'Untitled Chat') : 'Untitled Chat';

        exportBtn.innerText = `Backing Up ${i + 1}/${ids.length}...`;

        const response = await fetch(`/backend-api/conversation/${id}`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (response.ok) {
          const data = await response.json();
          const messages = getActiveConversationThread(data);

          markdownContent += `## Chat: ${title}\n*Link: [Open in ChatGPT](https://chatgpt.com/c/${id})*\n\n`;
          
          if (messages.length === 0) {
            markdownContent += `*No message history found.*\n\n`;
          } else {
            messages.forEach(msg => {
              const sender = msg.role === 'user' ? 'User' : 'ChatGPT';
              markdownContent += `### **${sender}**\n${msg.text}\n\n`;
            });
          }
          markdownContent += `\n---\n\n`;
        } else {
          markdownContent += `## Chat: ${title}\n*⚠️ Failed to fetch dialogue logs.*\n\n---\n\n`;
        }

        await new Promise(r => setTimeout(r, 150));
      }

      // Trigger file download
      const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `chatgpt-backup-${Date.now()}.md`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      showToast(`Backup successfully created for ${ids.length} chat(s)!`, 'success');

    } catch (error) {
      console.error('[Bulk Manager] Error exporting backups:', error);
      showToast('Failed to generate backup: ' + error.message, 'error');
    } finally {
      exportBtn.disabled = false;
      updateStats();
    }
  }

  // Deletion process loop
  async function startDeletionProcess() {
    const count = selectedIds.size;
    if (count === 0) return;

    const confirmed = confirm(`🛑 WARNING: You are about to permanently delete ${count} conversation(s).\n\nThis action cannot be undone. Are you sure you want to proceed?`);
    if (!confirmed) return;

    const overlay = document.querySelector('.cbd-modal-overlay');
    const progressOverlay = overlay.querySelector('.cbd-progress-overlay');
    const progressBarFill = overlay.querySelector('.cbd-progress-bar-fill');
    const progressPercent = overlay.querySelector('.cbd-progress-percentage');
    const progressStats = overlay.querySelector('.cbd-progress-stats');
    const currentTitleEl = overlay.querySelector('#cbd-current-title');
    const cancelBtn = overlay.querySelector('#cbd-cancel-btn');

    isDeleting = true;
    cancelRequested = false;
    cancelBtn.innerText = 'Abort Queue';
    cancelBtn.disabled = false;
    progressOverlay.classList.add('active');

    const idsToDelete = Array.from(selectedIds);
    const delay = parseInt(document.getElementById('cbd-delay-slider').value, 10);
    
    let deletedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < idsToDelete.length; i++) {
      if (cancelRequested) break;

      const id = idsToDelete[i];
      const chat = allConversations.find(c => c.id === id);
      const chatTitle = chat ? (chat.title || 'Untitled') : 'Unknown';

      const percent = Math.round((i / idsToDelete.length) * 100);
      progressBarFill.style.width = `${percent}%`;
      progressPercent.innerText = `${percent}%`;
      progressStats.innerText = `Deleting conversation ${i + 1} of ${idsToDelete.length}`;
      currentTitleEl.innerText = `Current: "${chatTitle}"`;

      const success = await deleteConversationAPI(id);
      if (success) {
        deletedCount++;
        allConversations = allConversations.filter(c => c.id !== id);
        selectedIds.delete(id);
        
        if (currentPreviewId === id) {
          resetPreviewPanel();
        }
      } else {
        failedCount++;
      }

      await new Promise(r => setTimeout(r, delay));
    }

    isDeleting = false;
    progressOverlay.classList.remove('active');

    if (cancelRequested) {
      showToast(`Deletion aborted. Deleted: ${deletedCount}, Failed: ${failedCount}`, 'info');
    } else {
      progressBarFill.style.width = '100%';
      progressPercent.innerText = '100%';
      showToast(`Bulk deletion complete. Deleted: ${deletedCount}, Failed: ${failedCount}`, 'success');
    }

    document.getElementById('cbd-search').value = '';
    renderConversationsGrid(allConversations);
    updateStats();
  }

  // Patch visibility endpoint
  async function deleteConversationAPI(conversationId) {
    if (!accessToken) return false;
    try {
      const response = await fetch(`/backend-api/conversation/${conversationId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ is_visible: false })
      });
      return response.ok;
    } catch (e) {
      console.error(`[Bulk Delete] Error deleting ${conversationId}:`, e);
      return false;
    }
  }

  // Custom Toast Notification System
  function showToast(message, type = 'success') {
    let container = document.querySelector('.cbd-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'cbd-toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `cbd-toast cbd-toast-${type}`;

    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#05f2a1" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="cbd-toast-icon-svg"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="cbd-toast-icon-svg"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="cbd-toast-icon-svg"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `
      <div class="cbd-toast-icon-wrapper">${iconSvg}</div>
      <div class="cbd-toast-content">${escapeHTML(message).replace(/\n/g, '<br>')}</div>
      <button class="cbd-toast-close">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    `;

    container.appendChild(toast);

    // Fade/slide in
    setTimeout(() => toast.classList.add('active'), 50);

    // Auto dismiss after 4 seconds
    const dismissTimer = setTimeout(() => {
      slideOutAndRemove(toast);
    }, 4000);

    // Manual dismiss button
    toast.querySelector('.cbd-toast-close').addEventListener('click', () => {
      clearTimeout(dismissTimer);
      slideOutAndRemove(toast);
    });
  }

  // Slide out and destroy node
  function slideOutAndRemove(toastNode) {
    toastNode.classList.remove('active');
    toastNode.addEventListener('transitionend', () => {
      toastNode.remove();
      // Destroy container if empty
      const container = document.querySelector('.cbd-toast-container');
      if (container && container.childNodes.length === 0) {
        container.remove();
      }
    });
  }

  // Create Dashboard DOM Split Panel Layout
  function createDashboardDOM() {
    const overlay = document.createElement('div');
    overlay.className = 'cbd-modal-overlay';

    overlay.innerHTML = `
      <div class="cbd-modal-container">
        <!-- Dashboard Split Panel Layout (3 Columns) -->
        <div class="cbd-dashboard-split">
          
          <!-- COLUMN 1: Sidebar Stats & Filters (25%) -->
          <div class="cbd-dash-sidebar">
            <div class="cbd-sidebar-logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="cbd-logo-svg">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              <span>Bulk Manager</span>
            </div>

            <!-- Stats grid -->
            <div class="cbd-stats-grid">
              <div class="cbd-stat-card">
                <span class="cbd-stat-label">Total Chats</span>
                <span class="cbd-stat-num" id="cbd-stat-total">0</span>
              </div>
              <div class="cbd-stat-card border-green">
                <span class="cbd-stat-label">Selected</span>
                <span class="cbd-stat-num" id="cbd-stat-selected">0</span>
              </div>
              <div class="cbd-stat-card border-purple">
                <span class="cbd-stat-label">Est. Time</span>
                <span class="cbd-stat-num" id="cbd-stat-time">0s</span>
              </div>
            </div>

            <!-- Quick filters -->
            <div class="cbd-sidebar-section">
              <div class="cbd-section-title">QUICK SELECTION FILTERS</div>
              <div class="cbd-filter-buttons">
                <button class="cbd-filter-btn" id="cbd-filter-all">Select All Matching</button>
                <button class="cbd-filter-btn" id="cbd-filter-invert">Invert Selections</button>
                <button class="cbd-filter-btn" id="cbd-filter-untitled">Select Untitled / New Chats</button>
                <button class="cbd-filter-btn" id="cbd-filter-7d">Select Older than 7 Days</button>
                <button class="cbd-filter-btn" id="cbd-filter-30d">Select Older than 30 Days</button>
                <button class="cbd-filter-btn" id="cbd-filter-none">Clear Selections</button>
              </div>
            </div>

            <!-- Throttle speeds -->
            <div class="cbd-sidebar-section">
              <div class="cbd-section-title">DELETION DELAY</div>
              <div class="cbd-delay-widget">
                <div class="cbd-delay-display">Delay: <strong id="cbd-delay-val">1.0s</strong></div>
                <input type="range" id="cbd-delay-slider" class="cbd-slider" min="500" max="3000" step="100" value="1000">
              </div>
              <div class="cbd-warning-tag">
                ⚠️ Sequential delay prevents account lockouts.
              </div>
            </div>

            <!-- Action buttons stack -->
            <div class="cbd-sidebar-actions-stack">
              <button class="cbd-export-action-btn" id="cbd-export-btn" disabled>Backup Selected (0)</button>
              <button class="cbd-delete-action-btn" id="cbd-delete-btn" disabled>Delete Selected (0)</button>
            </div>
          </div>

          <!-- COLUMN 2: Conversations List & Grid (40%) -->
          <div class="cbd-dash-main">
            <div class="cbd-main-header">
              <div class="cbd-search-wrapper">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cbd-search-icon">
                  <circle cx="11" cy="11" r="8"></circle>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <input type="text" id="cbd-search" class="cbd-search-input" placeholder="Search conversations by title...">
              </div>
              
              <button class="cbd-action-btn cbd-btn-secondary" id="cbd-refresh-btn" title="Refresh List">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                </svg>
                Refresh
              </button>
            </div>

            <div class="cbd-grid-container"></div>
          </div>

          <!-- COLUMN 3: Live Preview Panel Drawer (35%) -->
          <div class="cbd-dash-preview">
            <div class="cbd-preview-header">
              <div class="cbd-preview-header-left">
                <div class="cbd-preview-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                  </svg>
                </div>
                <h3 id="cbd-preview-title" class="cbd-preview-title-text">Dialogue Preview</h3>
              </div>
              
              <div class="cbd-preview-header-right">
                <a href="#" target="_blank" class="cbd-external-link" id="cbd-preview-external" style="display: none;">
                  View Full Chat
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-left: 3px;">
                    <line x1="7" y1="17" x2="17" y2="7"></line>
                    <polyline points="7 7 17 7 17 17"></polyline>
                  </svg>
                </a>
                <button class="cbd-close-dashboard-btn" id="cbd-close-modal">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>

            <div class="cbd-preview-body" id="cbd-preview-body"></div>
          </div>

        </div>

        <!-- Progress Dialog -->
        <div class="cbd-progress-overlay">
          <div class="cbd-progress-card">
            <div class="cbd-progress-title">Executing Mass Deletion</div>
            <div class="cbd-progress-bar-bg">
              <div class="cbd-progress-bar-fill"></div>
            </div>
            <div class="cbd-progress-percentage">0%</div>
            <div class="cbd-progress-stats">Deleting conversation 0 of 0</div>
            <div class="cbd-status-label" id="cbd-current-title"></div>
            <button class="cbd-action-btn cbd-btn-secondary" id="cbd-cancel-btn">Abort Queue</button>
          </div>
        </div>
      </div>
    `;

    // Hook up Events
    overlay.querySelectorAll('#cbd-close-modal').forEach(el => {
      el.addEventListener('click', closeManagerModal);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeManagerModal();
    });

    const searchEl = overlay.querySelector('#cbd-search');
    searchEl.addEventListener('input', handleSearch);

    overlay.querySelector('#cbd-refresh-btn').addEventListener('click', () => {
      const gridContainer = overlay.querySelector('.cbd-grid-container');
      loadConversations(gridContainer);
    });

    // Slider
    const slider = overlay.querySelector('#cbd-delay-slider');
    const sliderVal = overlay.querySelector('#cbd-delay-val');
    slider.addEventListener('input', (e) => {
      const secs = (e.target.value / 1000).toFixed(1);
      sliderVal.innerText = `${secs}s`;
      updateStats();
    });

    // Filters
    overlay.querySelector('#cbd-filter-all').addEventListener('click', () => selectFiltered(true));
    overlay.querySelector('#cbd-filter-none').addEventListener('click', () => selectFiltered(false));
    overlay.querySelector('#cbd-filter-untitled').addEventListener('click', selectUntitledChats);
    overlay.querySelector('#cbd-filter-7d').addEventListener('click', () => selectOlderChats(7));
    overlay.querySelector('#cbd-filter-30d').addEventListener('click', () => selectOlderChats(30));
    overlay.querySelector('#cbd-filter-invert').addEventListener('click', invertSelection);

    // CTA Actions
    overlay.querySelector('#cbd-delete-btn').addEventListener('click', startDeletionProcess);
    overlay.querySelector('#cbd-export-btn').addEventListener('click', exportSelectedConversations);
    
    // Abort
    overlay.querySelector('#cbd-cancel-btn').addEventListener('click', () => {
      cancelRequested = true;
      overlay.querySelector('#cbd-cancel-btn').innerText = 'Aborting...';
      overlay.querySelector('#cbd-cancel-btn').disabled = true;
    });

    return overlay;
  }

  // Filter list search
  function handleSearch(e) {
    const query = e.target.value.toLowerCase();
    const filtered = allConversations.filter(c => 
      (c.title || '').toLowerCase().includes(query)
    );
    renderConversationsGrid(filtered);
  }

  // Select/deselect all filtered chats
  function selectFiltered(shouldSelect) {
    const query = document.getElementById('cbd-search').value.toLowerCase();
    const filtered = allConversations.filter(c => 
      (c.title || '').toLowerCase().includes(query)
    );

    filtered.forEach(chat => {
      if (shouldSelect) {
        selectedIds.add(chat.id);
      } else {
        selectedIds.delete(chat.id);
      }
    });

    renderConversationsGrid(filtered);
    updateStats();
  }

  // Select untitled chats
  function selectUntitledChats() {
    allConversations.forEach(chat => {
      if (isChatUntitled(chat)) {
        selectedIds.add(chat.id);
      }
    });
    
    const query = document.getElementById('cbd-search').value.toLowerCase();
    const filtered = allConversations.filter(c => 
      (c.title || '').toLowerCase().includes(query)
    );
    renderConversationsGrid(filtered);
    updateStats();
  }

  // Select older chats
  function selectOlderChats(days) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    allConversations.forEach(chat => {
      const chatTime = new Date(chat.update_time || chat.create_time).getTime();
      if (chatTime < cutoff) {
        selectedIds.add(chat.id);
      }
    });
    
    const query = document.getElementById('cbd-search').value.toLowerCase();
    const filtered = allConversations.filter(c => 
      (c.title || '').toLowerCase().includes(query)
    );
    renderConversationsGrid(filtered);
    updateStats();
  }

  // Helper to check for default titles
  function isChatUntitled(chat) {
    const title = (chat.title || '').toLowerCase().trim();
    return title === '' || 
           title === 'new chat' || 
           title === 'untitled' || 
           title === 'untitled chat' || 
           title === 'new conversation';
  }

  // Formatting date
  function formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, { 
        month: 'short', 
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return dateStr;
    }
  }

  // Humanize relative time
  function getRelativeTime(dateStr) {
    if (!dateStr) return 'N/A';
    try {
      const timestamp = new Date(dateStr).getTime();
      const now = Date.now();
      const diffMs = now - timestamp;
      
      const diffMins = Math.floor(diffMs / (60 * 1000));
      const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
      const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 30) return `${diffDays}d ago`;
      
      const diffMonths = Math.floor(diffDays / 30);
      return `${diffMonths}mo ago`;
    } catch (e) {
      return 'N/A';
    }
  }

  // HTML escape helper
  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Run initializer
  init();
})();
