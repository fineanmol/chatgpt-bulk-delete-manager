// ChatGPT Bulk Delete Manager - Content Script (Mockup Overhaul Edition)

(function() {
  // Safe wrapper: chrome.runtime can be undefined if the extension context
  // is invalidated (e.g. after a reload or update). Fall back to '' so the
  // img src is simply empty rather than throwing a TypeError.
  function getExtURL(path) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL(path);
      }
    } catch (e) {
      console.warn('[Bulk Manager] chrome.runtime not available:', e);
    }
    return '';
  }

  let accessToken = null;
  let allConversations = [];
  let selectedIds = new Set();
  let currentPreviewId = null;
  let isDeleting = false;
  let cancelRequested = false;
  let cancelLoadRequested = false;
  let isExportingChats = false;
  let cancelExportRequested = false;
  let previewCache = new Map(); // Snappy cache for chat messages (id -> thread list)

  // Pagination & Filtering state
  let currentPage = 0;
  const itemsPerPage = 10;
  let searchQuery = '';
  let timeFilter = 'all'; // 'all', '24h', '7d', '30d'
  let typeFilter = 'all'; // 'all', 'untitled', 'checked', 'unchecked'
  let activeTheme = 'light'; // 'light' or 'dark'
  let actionMode = 'delete'; // 'delete' (is_visible: false) or 'archive' (is_archived: true)

  // Initialize
  function init() {
    // Load saved theme preference
    activeTheme = localStorage.getItem('cbd-theme') || 'light';
    // Load saved action mode preference
    actionMode = localStorage.getItem('cbd-action-mode') || 'delete';

    // Register Keyboard Shortcut: Alt + B (Option + B on Mac)
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        toggleManagerModal();
      }
    });

    // Delay initial injection to allow React/Next.js hydration to complete safely
    if (document.readyState === 'complete') {
      setTimeout(startInjections, 2000);
    } else {
      window.addEventListener('load', () => {
        setTimeout(startInjections, 2000);
      });
    }
  }

  // Start periodic injection intervals after hydration
  function startInjections() {
    injectSidebarButton();
    injectFloatingCapsule();
    setInterval(injectSidebarButton, 3000);
    setInterval(injectFloatingCapsule, 3000);
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
        <img src="${getExtURL('icon16.png')}" alt="Bulk Manager" style="width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0; margin-right: 4px;">
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
      <div class="cbd-capsule-icon" style="display: flex; align-items: center; justify-content: center;">
        <img src="${getExtURL('icon48.png')}" alt="Bulk Clean" style="width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0;">
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

  // Fetch and Load Chats History (Parallel Polish Edition)
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

    currentPage = 0;
    allConversations = [];
    selectedIds.clear();
    previewCache.clear();
    currentPreviewId = null;
    cancelLoadRequested = false;
    updateStats();
    resetPreviewPanel();

    try {
      // 1. Fetch the first page to get total count
      const limit = 50;
      const firstResponse = await fetch(`/backend-api/conversations?offset=0&limit=${limit}&order=updated`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!firstResponse.ok) {
        throw new Error('Failed to fetch conversation list');
      }

      const firstData = await firstResponse.json();
      allConversations = firstData.items || [];
      const total = firstData.total || allConversations.length;

      // 2. Fetch remaining pages in parallel (concurrency limit of 5 for safety)
      if (total > limit && !cancelLoadRequested) {
        const offsets = [];
        for (let offset = limit; offset < total; offset += limit) {
          offsets.push(offset);
        }

        let completedCount = 0;
        const totalPagesToFetch = offsets.length;

        // Simple helper to fetch a page
        const fetchPage = async (offset) => {
          if (cancelLoadRequested) return [];
          try {
            const res = await fetch(`/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`, {
              headers: {
                'Authorization': `Bearer ${token}`
              }
            });
            if (!res.ok) return [];
            const data = await res.json();
            completedCount++;
            
            // Update UI progress
            const progressPercent = Math.min(100, Math.round((completedCount / totalPagesToFetch) * 100));
            gridEl.innerHTML = `
              <div class="cbd-loader-container">
                <div class="cbd-spinner"></div>
                <span>Retrieving conversations: ${progressPercent}% loaded...</span>
                <button class="cbd-action-btn cbd-btn-secondary" id="cbd-cancel-load-btn" style="margin-top: 8px; padding: 4px 10px; font-size: 11px;">Stop Loading</button>
              </div>
            `;
            // Hook up cancel button on every render
            gridEl.querySelector('#cbd-cancel-load-btn')?.addEventListener('click', () => {
              cancelLoadRequested = true;
              const btn = gridEl.querySelector('#cbd-cancel-load-btn');
              if (btn) {
                btn.innerText = 'Stopping...';
                btn.disabled = true;
              }
            });

            return data.items || [];
          } catch (e) {
            console.error(e);
            return [];
          }
        };

        // Fetch in batches of 5 concurrent requests
        const concurrencyLimit = 5;
        const results = [];
        for (let i = 0; i < offsets.length; i += concurrencyLimit) {
          if (cancelLoadRequested) break;
          const batch = offsets.slice(i, i + concurrencyLimit).map(fetchPage);
          const batchResults = await Promise.all(batch);
          results.push(...batchResults);
        }

        results.forEach(items => {
          allConversations = allConversations.concat(items);
        });
      }

      if (cancelLoadRequested) {
        showToast(`Loading stopped. Displaying ${allConversations.length} conversation(s).`, 'info');
      }

      renderList();
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

  // Get active filtered conversations
  function getFilteredConversations() {
    const now = Date.now();
    return allConversations.filter(chat => {
      // Search filter (Matches title or cached message logs)
      const title = (chat.title || '').toLowerCase().trim();
      if (searchQuery) {
        const titleMatch = title.includes(searchQuery);
        let contentMatch = false;
        
        const cachedMessages = previewCache.get(chat.id);
        if (cachedMessages) {
          contentMatch = cachedMessages.some(msg => 
            (msg.text || '').toLowerCase().includes(searchQuery)
          );
        }
        
        if (!titleMatch && !contentMatch) return false;
      }

      // Time range filter
      if (timeFilter !== 'all') {
        const chatTime = new Date(chat.update_time || chat.create_time).getTime();
        if (timeFilter === '24h') {
          if (chatTime < now - 24 * 60 * 60 * 1000) return false;
        } else if (timeFilter === '7d') {
          if (chatTime < now - 7 * 24 * 60 * 60 * 1000) return false;
        } else if (timeFilter === '30d') {
          if (chatTime < now - 30 * 24 * 60 * 60 * 1000) return false;
        } else if (timeFilter === 'older-7d') {
          if (chatTime >= now - 7 * 24 * 60 * 60 * 1000) return false;
        } else if (timeFilter === 'older-30d') {
          if (chatTime >= now - 30 * 24 * 60 * 60 * 1000) return false;
        }
      }

      // Type/Selection filter
      if (typeFilter !== 'all') {
        const isChecked = selectedIds.has(chat.id);
        if (typeFilter === 'checked' && !isChecked) return false;
        if (typeFilter === 'unchecked' && isChecked) return false;
        if (typeFilter === 'untitled' && !isChatUntitled(chat)) return false;
      }

      return true;
    });
  }

  // Render list items based on filter and pagination
  function renderList() {
    const gridEl = document.querySelector('.cbd-grid-container');
    if (!gridEl) return;

    const filtered = getFilteredConversations();
    const totalPages = Math.max(1, Math.ceil(filtered.length / itemsPerPage));
    
    // Bounds check
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    if (currentPage < 0) currentPage = 0;

    const startIndex = currentPage * itemsPerPage;
    const pageItems = filtered.slice(startIndex, startIndex + itemsPerPage);

    // Update Select All on Page checkbox state
    const selectAllCb = document.getElementById('cbd-select-all-cb');
    if (selectAllCb) {
      const allSelected = pageItems.length > 0 && pageItems.every(chat => selectedIds.has(chat.id));
      selectAllCb.checked = allSelected;
    }

    if (pageItems.length === 0) {
      gridEl.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; color: var(--text-muted); grid-column: 1/-1;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 8px; opacity: 0.5;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="8" y1="12" x2="16" y2="12"></line>
          </svg>
          No conversations match your filter criteria.
        </div>
      `;
      renderPaginationControls(0, 1);
      return;
    }

    let html = '';
    pageItems.forEach(chat => {
      const isChecked = selectedIds.has(chat.id) ? 'checked' : '';
      const isPreviewing = currentPreviewId === chat.id ? 'previewing' : '';
      const shortDate = formatShortDate(chat.update_time || chat.create_time);
      const isUntitled = isChatUntitled(chat);
      const untitledBadge = isUntitled ? '<span class="cbd-card-badge-untitled">Untitled</span>' : '';
      
      // ChatGPT doesn't expose message count directly, so we estimate, or display subtitle
      // We will parse message count or placeholder
      const msgCount = chat.message_count || (isUntitled ? 'No' : 'Multiple') + ' messages';

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
            <div class="cbd-card-time-row">
              <span class="cbd-card-msg-count">${msgCount}</span>
              <span class="cbd-card-date">${shortDate}</span>
            </div>
          </div>
        </div>
      `;
    });

    gridEl.innerHTML = html;

    // Attach click listeners
    gridEl.querySelectorAll('.cbd-card').forEach(card => {
      const cb = card.querySelector('.cbd-card-cb');
      const id = card.getAttribute('data-id');

      card.querySelector('.cbd-card-info').addEventListener('click', () => {
        triggerPreview(card, id);
      });

      cb.addEventListener('change', () => {
        toggleCardSelection(card, id, cb.checked);
      });
    });

    // Render pagination footer
    renderPaginationControls(currentPage, totalPages);
  }

  // Render pagination controls footer
  function renderPaginationControls(current, total) {
    const footerEl = document.querySelector('.cbd-pagination-container');
    if (!footerEl) return;

    let html = `
      <button class="cbd-pag-btn" id="cbd-pag-prev" ${current === 0 ? 'disabled' : ''}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
    `;

    // Simple paginator values: show surrounding pages
    const maxVisiblePages = 5;
    let startPage = Math.max(0, current - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(total, startPage + maxVisiblePages);

    if (endPage - startPage < maxVisiblePages) {
      startPage = Math.max(0, endPage - maxVisiblePages);
    }

    for (let i = startPage; i < endPage; i++) {
      const isActive = i === current ? 'active' : '';
      html += `<button class="cbd-pag-btn ${isActive} cbd-pag-num" data-page="${i}">${i + 1}</button>`;
    }

    html += `
      <button class="cbd-pag-btn" id="cbd-pag-next" ${current === total - 1 ? 'disabled' : ''}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
    `;

    footerEl.innerHTML = html;

    // Click events
    footerEl.querySelectorAll('.cbd-pag-num').forEach(btn => {
      btn.addEventListener('click', () => {
        currentPage = parseInt(btn.getAttribute('data-page'), 10);
        renderList();
      });
    });

    footerEl.querySelector('#cbd-pag-prev').addEventListener('click', () => {
      if (currentPage > 0) {
        currentPage--;
        renderList();
      }
    });

    footerEl.querySelector('#cbd-pag-next').addEventListener('click', () => {
      if (currentPage < total - 1) {
        currentPage++;
        renderList();
      }
    });
  }

  // Handle Select All on Page checkbox toggle action
  function handleSelectAllPageToggle(checked) {
    const filtered = getFilteredConversations();
    const startIndex = currentPage * itemsPerPage;
    const pageItems = filtered.slice(startIndex, startIndex + itemsPerPage);

    pageItems.forEach(chat => {
      if (checked) {
        selectedIds.add(chat.id);
      } else {
        selectedIds.delete(chat.id);
      }
    });

    renderList();
    updateStats();
  }

  // Toggle selection states
  function toggleCardSelection(cardEl, id, isSelected) {
    if (isSelected) {
      selectedIds.add(id);
      cardEl.classList.add('selected');
    } else {
      selectedIds.delete(id);
      cardEl.classList.remove('selected');
    }

    // Update Select All on Page checkbox state
    const filtered = getFilteredConversations();
    const startIndex = currentPage * itemsPerPage;
    const pageItems = filtered.slice(startIndex, startIndex + itemsPerPage);
    const selectAllCb = document.getElementById('cbd-select-all-cb');
    if (selectAllCb) {
      const allSelected = pageItems.length > 0 && pageItems.every(chat => selectedIds.has(chat.id));
      selectAllCb.checked = allSelected;
    }

    updateStats();
  }

  // Update statistics details
  function updateStats() {
    const totalCount = allConversations.length;
    const filtered = getFilteredConversations();
    const selectedCount = selectedIds.size;
    const delay = parseInt(document.getElementById('cbd-delay-slider')?.value || '1000', 10);
    const estSecs = Math.round((selectedCount * delay) / 1000);

    const statsLabel = document.getElementById('cbd-stats-count-label');
    if (statsLabel) {
      statsLabel.innerText = `${selectedCount} selected / ${totalCount} total`;
    }

    // Header buttons text and status updates
    const deleteBtn = document.getElementById('cbd-delete-btn');
    if (deleteBtn) {
      const btnText = actionMode === 'archive' ? 'Archive Selected' : 'Delete Selected';
      const iconSvg = actionMode === 'archive' ? 
        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:4px;">
          <polyline points="21 8 21 21 3 21 3 8"></polyline>
          <rect x="1" y="3" width="22" height="5" rx="1"></rect>
          <line x1="10" y1="12" x2="14" y2="12"></line>
        </svg>` :
        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:4px;">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>`;
      
      deleteBtn.innerHTML = `
        ${iconSvg}
        ${btnText} (${selectedCount})
      `;
      
      if (actionMode === 'archive') {
        deleteBtn.className = 'cbd-nav-btn';
      } else {
        deleteBtn.className = 'cbd-nav-btn-danger';
      }
      deleteBtn.disabled = selectedCount === 0;
    }

    const exportBtn = document.getElementById('cbd-export-btn');
    if (exportBtn) {
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

    // Set initial theme class
    setTheme(activeTheme);

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

  // Reset dialogue preview panel
  function resetPreviewPanel() {
    const titleEl = document.getElementById('cbd-preview-title');
    const externalLink = document.getElementById('cbd-preview-external');
    const bodyEl = document.getElementById('cbd-preview-body');
    const subtitleEl = document.getElementById('cbd-preview-msg-count');

    if (titleEl) titleEl.innerText = 'Preview Window';
    if (subtitleEl) subtitleEl.innerText = 'Select a conversation';
    if (externalLink) externalLink.style.display = 'none';
    
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="cbd-preview-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="36" height="36" style="margin-bottom: 12px; opacity: 0.35;">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <span>Select any conversation card on the left to preview its chat history.</span>
        </div>
      `;
    }
  }

  // Trigger preview fetch (with Snappy Caching)
  async function triggerPreview(cardEl, id) {
    document.querySelectorAll('.cbd-card').forEach(card => card.classList.remove('previewing'));
    cardEl.classList.add('previewing');
    currentPreviewId = id;

    const titleEl = document.getElementById('cbd-preview-title');
    const externalLink = document.getElementById('cbd-preview-external');
    const bodyEl = document.getElementById('cbd-preview-body');
    const subtitleEl = document.getElementById('cbd-preview-msg-count');

    const chat = allConversations.find(c => c.id === id);
    const title = chat ? (chat.title || 'Untitled Chat') : 'Selected Chat';
    
    titleEl.innerText = `Preview: ${title}`;
    
    if (externalLink) {
      externalLink.style.display = 'flex';
      externalLink.href = `https://chatgpt.com/c/${id}`;
    }

    // Snappy Cache Hit Check
    if (previewCache.has(id)) {
      const messages = previewCache.get(id);
      if (subtitleEl) subtitleEl.innerText = `${messages.length} messages`;
      renderMessages(bodyEl, messages);
      return;
    }

    if (subtitleEl) subtitleEl.innerText = 'Retrieving count...';

    bodyEl.innerHTML = `
      <div class="cbd-preview-loading">
        <div class="cbd-spinner"></div>
        <span>Retrieving dialogue...</span>
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
      
      // Save in cache
      previewCache.set(id, messages);

      if (subtitleEl) subtitleEl.innerText = `${messages.length} messages`;
      renderMessages(bodyEl, messages);

    } catch (error) {
      console.error('[Bulk Manager] Error previewing conversation:', error);
      if (currentPreviewId === id) {
        bodyEl.innerHTML = `
          <div class="cbd-preview-empty" style="color: #f87171;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24" style="margin-bottom: 8px;">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>Could not load chat dialogue.<br>Verify your connection.</span>
          </div>
        `;
      }
    }
  }

  // Parse active conversation branch
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
              text: text,
              time: msg.create_time || 0
            });
          }
        }
      }
      currentNodeId = node.parent;
    }

    return thread.reverse();
  }

  // Render messages in dialog container
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
      const formattedTime = formatFullDate(msg.time);
      
      const avatarSvg = isUser ? 
        `<div class="cbd-bubble-avatar cbd-avatar-user"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></div>` : 
        `<div class="cbd-bubble-avatar cbd-avatar-chatgpt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2a10 10 0 0 1 10 10c0 5.523-4.477 10-10 10S2 17.523 2 12A10 10 0 0 1 12 2z"></path><path d="M12 6v12M6 12h12M8.5 8.5l7 7M15.5 8.5l-7 7"></path></svg></div>`;

      html += `
        <div class="cbd-bubble-wrapper">
          <div class="cbd-bubble-header-row">
            ${avatarSvg}
            <span class="cbd-bubble-sender">${isUser ? 'You' : 'ChatGPT'}</span>
          </div>
          <div class="cbd-bubble-content-block">
            <div class="cbd-bubble ${bubbleClass}">
              ${escapeHTML(msg.text).replace(/\n/g, '<br>')}
            </div>
            <span class="cbd-bubble-timestamp">${formattedTime}</span>
          </div>
        </div>
      `;
    });

    containerEl.innerHTML = html;
    containerEl.scrollTop = containerEl.scrollHeight;
  }

  // Invert checkboxes selection states
  function invertSelection() {
    const filtered = getFilteredConversations();
    filtered.forEach(chat => {
      if (selectedIds.has(chat.id)) {
        selectedIds.delete(chat.id);
      } else {
        selectedIds.add(chat.id);
      }
    });

    renderList();
    updateStats();
  }

  // Select only untitled chats
  function selectUntitledChats() {
    selectedIds.clear();
    const visibleChats = getFilteredConversations();
    visibleChats.forEach(chat => {
      if (isChatUntitled(chat)) {
        selectedIds.add(chat.id);
      }
    });
    currentPage = 0;
    renderList();
    updateStats();
  }

  // Select chats older than N days
  function selectOlderChats(days) {
    selectedIds.clear();
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const visibleChats = getFilteredConversations();
    visibleChats.forEach(chat => {
      const chatTime = new Date(chat.update_time || chat.create_time).getTime();
      if (chatTime < cutoff) {
        selectedIds.add(chat.id);
      }
    });
    currentPage = 0;
    renderList();
    updateStats();
  }

  // Clear selections
  function clearSelections() {
    selectedIds.clear();
    renderList();
    updateStats();
  }

  // Toggle Theme mode
  function toggleTheme() {
    const nextTheme = activeTheme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
  }

  // Apply Theme styling
  function setTheme(theme) {
    activeTheme = theme;
    localStorage.setItem('cbd-theme', theme);
    
    const overlay = document.querySelector('.cbd-modal-overlay');
    if (!overlay) return;

    const themeBtn = document.getElementById('cbd-theme-toggle');

    if (theme === 'dark') {
      overlay.classList.add('cbd-dark-theme');
      if (themeBtn) {
        themeBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line>
            <line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
          </svg>
        `;
      }
    } else {
      overlay.classList.remove('cbd-dark-theme');
      if (themeBtn) {
        themeBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
        `;
      }
    }
  }

  // Export selected conversations to Markdown
  async function exportSelectedConversations() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const exportBtn = document.getElementById('cbd-export-btn');

    if (isExportingChats) {
      cancelExportRequested = true;
      exportBtn.innerHTML = 'Stopping...';
      exportBtn.disabled = true;
      return;
    }

    isExportingChats = true;
    cancelExportRequested = false;
    exportBtn.disabled = false;
    const originalText = exportBtn.innerHTML;

    let markdownContent = `# ChatGPT Conversation Export\n*Generated on ${new Date().toLocaleDateString()}*\n\n---\n\n`;
    
    try {
      const token = accessToken || await fetchAccessToken();
      if (!token) throw new Error('Session unauthorized or expired');

      for (let i = 0; i < ids.length; i++) {
        if (cancelExportRequested) break;

        const id = ids[i];
        const chat = allConversations.find(c => c.id === id);
        const title = chat ? (chat.title || 'Untitled Chat') : 'Untitled Chat';

        exportBtn.innerHTML = `
          <svg class="cbd-spinner-small" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="display:inline; margin-right:4px;"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg>
          Stop Export (${i + 1}/${ids.length})
        `;

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

        await new Promise(r => setTimeout(r, 120));
      }

      const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `chatgpt-export-${Date.now()}.md`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      if (cancelExportRequested) {
        showToast('Export process stopped. Partial export downloaded.', 'info');
      } else {
        showToast(`Markdown export successfully created for ${ids.length} chat(s)!`, 'success');
      }

    } catch (error) {
      console.error('[Bulk Manager] Error exporting conversations:', error);
      showToast('Failed to generate export: ' + error.message, 'error');
    } finally {
      isExportingChats = false;
      cancelExportRequested = false;
      exportBtn.innerHTML = originalText;
      exportBtn.disabled = false;
      updateStats();
    }
  }

  // Request confirmation via a custom toast notification with action buttons (Production-grade)
  function confirmDeletion() {
    const count = selectedIds.size;
    if (count === 0) return;

    // Show custom warning toast inside the dashboard toast container
    let container = document.querySelector('.cbd-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'cbd-toast-container';
      document.body.appendChild(container);
    }

    // Remove any existing confirm toasts to avoid duplicates
    const existing = container.querySelector('.cbd-toast-confirm-action');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'cbd-toast cbd-toast-confirm-action';
    
    const actionVerb = actionMode === 'archive' ? 'archive' : 'permanently delete';
    const actionWarning = actionMode === 'archive' ? 'They will be moved to your ChatGPT archive.' : 'This action cannot be undone.';
    const confirmButtonText = actionMode === 'archive' ? 'Yes, Archive' : 'Yes, Delete';
    const confirmButtonBg = actionMode === 'archive' ? 'var(--cbd-accent-green-start)' : 'var(--cbd-accent-danger-start)';
    const iconColor = actionMode === 'archive' ? 'var(--cbd-accent-green-start)' : 'var(--cbd-accent-danger-start)';
    
    toast.innerHTML = `
      <div style="display: flex; align-items: flex-start; gap: 10px; width: 100%;">
        <div class="cbd-toast-icon-wrapper" style="color: ${iconColor}; display: flex; align-items: center;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </div>
        <div class="cbd-toast-content" style="font-weight: 700; font-size: 12px; color: var(--cbd-text-main); line-height: 1.4;">
          Do you want to ${actionVerb} ${count} selected chat(s)? ${actionWarning}
        </div>
      </div>
      <div style="display: flex; gap: 8px; width: 100%; justify-content: flex-end; margin-top: 4px;">
        <button id="cbd-confirm-cancel-btn" class="cbd-pag-btn" style="padding: 6px 12px; font-size: 11px; border-radius: 6px; font-weight: 700; text-transform: none; border: 1px solid var(--cbd-border); background: transparent; color: var(--cbd-text-main);">Cancel</button>
        <button id="cbd-confirm-delete-btn" style="padding: 6px 12px; font-size: 11px; border-radius: 6px; font-weight: 700; text-transform: none; margin-left: 4px; background: ${confirmButtonBg}; border: none; color: #fff; cursor: pointer;">${confirmButtonText}</button>
      </div>
    `;

    container.appendChild(toast);
    setTimeout(() => toast.classList.add('active'), 50);

    toast.querySelector('#cbd-confirm-cancel-btn').addEventListener('click', () => {
      slideOutAndRemove(toast);
    });

    toast.querySelector('#cbd-confirm-delete-btn').addEventListener('click', () => {
      slideOutAndRemove(toast);
      executeDeletionQueue();
    });
  }

  // Deletion execution queue process loop (Production-grade)
  async function executeDeletionQueue() {
    const overlay = document.querySelector('.cbd-modal-overlay');
    const progressOverlay = overlay.querySelector('.cbd-progress-overlay');
    const progressBarFill = overlay.querySelector('.cbd-progress-bar-fill');
    const progressPercent = overlay.querySelector('.cbd-progress-percentage');
    const progressStats = overlay.querySelector('.cbd-progress-stats');
    const currentTitleEl = overlay.querySelector('#cbd-current-title');
    const cancelBtn = overlay.querySelector('#cbd-cancel-btn');

    isDeleting = true;
    cancelRequested = false;
    
    const processVerb = actionMode === 'archive' ? 'Archive' : 'Deletion';
    const activeVerb = actionMode === 'archive' ? 'Archiving' : 'Permanently deleting';
    const resultVerbPast = actionMode === 'archive' ? 'archived' : 'deleted';
    const resultVerbPastCapital = actionMode === 'archive' ? 'Archived' : 'Deleted';
    
    cancelBtn.innerText = `Stop ${processVerb}`;
    cancelBtn.disabled = false;
    progressOverlay.classList.add('active');
    
    const progressTitle = overlay.querySelector('.cbd-progress-title');
    if (progressTitle) {
      progressTitle.innerText = actionMode === 'archive' ? 'Processing Bulk Archive Queue' : 'Processing Bulk Deletion Queue';
    }

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
      progressStats.innerText = `${activeVerb} chat ${i + 1} of ${idsToDelete.length}...`;
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
      showToast(`${processVerb} stopped. ${resultVerbPastCapital} ${deletedCount} chat(s), failed ${failedCount}.`, 'info');
    } else {
      progressBarFill.style.width = '100%';
      progressPercent.innerText = '100%';
      if (failedCount > 0) {
        showToast(`${processVerb} complete. Successfully ${resultVerbPast} ${deletedCount} chat(s), failed ${failedCount}.`, 'warning');
      } else {
        if (deletedCount >= 5) {
          showToast(`Successfully ${resultVerbPast} ${deletedCount} chat(s).`, 'success-share');
        } else {
          showToast(`Successfully ${resultVerbPast} ${deletedCount} chat(s).`, 'success');
        }
      }
    }

    // Refresh view
    currentPage = 0;
    renderList();
    updateStats();
  }

  // Patch visibility or archived state (Production-grade)
  async function deleteConversationAPI(conversationId) {
    if (!accessToken) return false;
    try {
      const body = actionMode === 'archive' ? { is_archived: true } : { is_visible: false };
      const response = await fetch(`/backend-api/conversation/${conversationId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      return response.ok;
    } catch (e) {
      console.error(`[Bulk Process] Error processing ${conversationId}:`, e);
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
    if (type === 'success-share') {
      toast.className = `cbd-toast cbd-toast-success cbd-toast-confirm-action`;
    } else {
      toast.className = `cbd-toast cbd-toast-${type}`;
    }

    let iconSvg = '';
    if (type === 'success' || type === 'success-share') {
      iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10a37f" stroke-width="3" class="cbd-toast-icon-svg"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="3" class="cbd-toast-icon-svg"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></svg>`;
    } else {
      iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="3" class="cbd-toast-icon-svg"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></svg>`;
    }

    if (type === 'success-share') {
      const shareUrl = "https://chromewebstore.google.com/detail/chatgpt-bulk-delete-manag/ebchdiehpgnonjcndecjkficmoaddnfe";
      const tweetText = encodeURIComponent(`My ChatGPT sidebar is clean! Just cleared old chats in seconds using ChatGPT Bulk Delete Manager. Get it here: ${shareUrl}`);
      
      toast.innerHTML = `
        <div style="display: flex; align-items: flex-start; gap: 10px; width: 100%;">
          <div class="cbd-toast-icon-wrapper">${iconSvg}</div>
          <div class="cbd-toast-content" style="font-weight: 700; font-size: 13px;">
            ${escapeHTML(message)}
            <div style="font-weight: 400; font-size: 11px; color: var(--cbd-text-muted); margin-top: 4px; line-height: 1.4;">
              Enjoying the extension? Help others find it by sharing or leaving a rating!
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; width: 100%; justify-content: flex-end; margin-top: 4px;">
          <a href="https://twitter.com/intent/tweet?text=${tweetText}" target="_blank" style="padding: 6px 12px; font-size: 11px; border-radius: 6px; text-decoration: none; display: flex; align-items: center; background: #1da1f2; color: #fff; border: none; font-weight: 700; cursor: pointer; gap: 4px;">
            <svg width="10" height="10" fill="currentColor" viewBox="0 0 24 24"><path d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z"/></svg>
            Share on X
          </a>
          <a href="${shareUrl}/reviews" target="_blank" style="padding: 6px 12px; font-size: 11px; border-radius: 6px; text-decoration: none; display: flex; align-items: center; background: var(--cbd-accent-green-start); color: #fff; border: none; font-weight: 700; cursor: pointer;">
            Rate 5★
          </a>
          <button class="cbd-toast-close" style="padding: 6px; margin-left: 4px;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      `;
    } else {
      toast.innerHTML = `
        <div class="cbd-toast-icon-wrapper">${iconSvg}</div>
        <div class="cbd-toast-content">${escapeHTML(message).replace(/\n/g, '<br>')}</div>
        <button class="cbd-toast-close">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      `;
    }

    container.appendChild(toast);

    setTimeout(() => toast.classList.add('active'), 50);

    const dismissTimer = setTimeout(() => {
      slideOutAndRemove(toast);
    }, type === 'success-share' ? 12000 : 4000);

    toast.querySelector('.cbd-toast-close').addEventListener('click', () => {
      clearTimeout(dismissTimer);
      slideOutAndRemove(toast);
    });
  }

  function slideOutAndRemove(toastNode) {
    toastNode.classList.remove('active');
    toastNode.addEventListener('transitionend', () => {
      toastNode.remove();
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
        <!-- 1. HEADER ROW: Brand & Global CTAs -->
        <div class="cbd-header-bar">
          <div class="cbd-header-brand">
            <div class="cbd-brand-icon-box" style="display: flex; align-items: center; justify-content: center; background: transparent; border: none; padding: 0;">
              <img src="${getExtURL('icon128.png')}" alt="Logo" style="width: 24px; height: 24px; border-radius: 6px; flex-shrink: 0;">
            </div>
            <h1 class="cbd-brand-title">Bulk Delete ChatGPT History</h1>
          </div>

          <div class="cbd-header-actions-group">
            <button class="cbd-nav-btn" id="cbd-export-btn" disabled>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:4px;">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Export as Markdown
            </button>
            <button class="cbd-nav-btn-danger" id="cbd-delete-btn" disabled>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:4px;">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              Delete Selected (0)
            </button>
            <button class="cbd-icon-nav-btn" id="cbd-settings-btn" title="Settings / Rate Control">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
            <button class="cbd-icon-nav-btn" id="cbd-theme-toggle" title="Toggle Light/Dark Theme">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            </button>
          </div>
        </div>

        <!-- Hidden rate limit settings slide drawer -->
        <div class="cbd-settings-drawer" id="cbd-settings-drawer">
          <div class="cbd-settings-drawer-title">Deletion Rate Limit Safeguard</div>
          <div class="cbd-settings-slider-wrapper">
            <span>Rate Delay: <strong id="cbd-delay-val">1.0s</strong></span>
            <input type="range" id="cbd-delay-slider" class="cbd-slider" min="500" max="3000" step="100" value="1000">
          </div>
          <span style="font-size:10px; color:var(--text-muted); display:block; margin-bottom:12px;">Throttle the deletion frequency to stay within ChatGPT's native rate limits and prevent account restrictions.</span>
          
          <div class="cbd-settings-drawer-title">Action Mode</div>
          <div style="display: flex; gap: 16px; margin-top: 6px; align-items: center;">
            <label style="display: flex; align-items: center; font-size: 11px; color: var(--cbd-text-main); cursor: pointer; font-weight:700;">
              <input type="radio" name="cbd-action-mode" value="delete" ${actionMode === 'delete' ? 'checked' : ''} style="margin-right: 4px; accent-color: var(--cbd-accent-green-start);"> Permanent Delete
            </label>
            <label style="display: flex; align-items: center; font-size: 11px; color: var(--cbd-text-main); cursor: pointer; font-weight:700;">
              <input type="radio" name="cbd-action-mode" value="archive" ${actionMode === 'archive' ? 'checked' : ''} style="margin-right: 4px; accent-color: var(--cbd-accent-green-start);"> Native Archive
            </label>
          </div>
          <span style="font-size:10px; color:var(--text-muted); display:block; margin-top:4px;">Archiving moves conversations to your ChatGPT Archive. Deletion permanently purges them.</span>
        </div>

        <!-- 2. SPLIT LAYOUT: Left Card-List (60%), Right Preview (40%) -->
        <div class="cbd-dashboard-split">
          
          <!-- LEFT SIDE PANEL -->
          <div class="cbd-dash-main">
            <!-- Search & Filters Dropdown Row -->
            <div class="cbd-filters-dropdowns-row">
              <div class="cbd-search-wrapper">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="cbd-search-icon">
                  <circle cx="11" cy="11" r="8"></circle>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <input type="text" id="cbd-search" class="cbd-search-input" placeholder="Search conversations...">
              </div>
              
              <select id="cbd-time-dropdown" class="cbd-select-filter">
                <option value="all">All Time</option>
                <option value="24h">Last 24 Hours</option>
                <option value="7d">Last 7 Days</option>
                <option value="30d">Last 30 Days</option>
                <option value="older-7d">Older than 7 Days</option>
                <option value="older-30d">Older than 30 Days</option>
              </select>

              <select id="cbd-type-dropdown" class="cbd-select-filter">
                <option value="all">All Chats</option>
                <option value="untitled">Untitled Only</option>
                <option value="checked">Checked Only</option>
                <option value="unchecked">Unchecked Only</option>
              </select>
            </div>

            <!-- Quick Selection Filters Row -->
            <div class="cbd-quick-filters-row">
              <button class="cbd-quick-icon-btn" id="cbd-refresh-btn" title="Refresh List">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                </svg>
              </button>
              <button class="cbd-quick-filter-btn" id="cbd-btn-invert">Invert</button>
              <button class="cbd-quick-filter-btn" id="cbd-btn-untitled">New Chats</button>
              <button class="cbd-quick-filter-btn" id="cbd-btn-7d">Older Than 7d</button>
              <button class="cbd-quick-filter-btn" id="cbd-btn-30d">Older Than 30d</button>
            </div>

            <!-- Subheader Count stats & Select All Checkbox -->
            <div class="cbd-stats-count-row">
              <div class="cbd-select-all-wrapper">
                <input type="checkbox" id="cbd-select-all-cb" class="cbd-checkbox">
                <label for="cbd-select-all-cb">Select All on Page</label>
              </div>
              <span id="cbd-stats-count-label">0 selected / 0 total</span>
            </div>

            <!-- Conversations Cards Grid -->
            <div class="cbd-grid-container"></div>

            <!-- Pagination Footer -->
            <div class="cbd-pagination-container"></div>
          </div>

          <!-- RIGHT SIDE PANEL -->
          <div class="cbd-dash-preview">
            <div class="cbd-preview-header">
              <div class="cbd-preview-header-left">
                <h3 id="cbd-preview-title" class="cbd-preview-title-text">Preview Window</h3>
                <span id="cbd-preview-msg-count" class="cbd-preview-msg-count-sub">Select a chat</span>
              </div>
              
              <button class="cbd-preview-close-btn" id="cbd-reset-preview-btn" title="Close Preview">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            <!-- Scrollable chat thread body -->
            <div class="cbd-preview-body" id="cbd-preview-body"></div>

            <!-- External link footer button -->
            <div class="cbd-preview-footer">
              <a href="#" target="_blank" class="cbd-view-full-btn" id="cbd-preview-external" style="display: none;">
                View Full in ChatGPT
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="margin-left:4px;">
                  <line x1="7" y1="17" x2="17" y2="7"></line>
                  <polyline points="7 7 17 7 17 17"></polyline>
                </svg>
              </a>
            </div>
          </div>

        </div>

        <!-- 3. FOOTER ROW: Status tips & badges -->
        <div class="cbd-footer-bar">
          <div class="cbd-footer-tip">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2.5" style="margin-right:4px; flex-shrink:0;">
              <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"></path>
              <line x1="9" y1="18" x2="15" y2="18"></line>
              <line x1="10" y1="22" x2="14" y2="22"></line>
            </svg>
            <span>Tip: Option+B (Alt+B) to toggle dashboard</span>
          </div>

          <div style="display: flex; align-items: center; gap: 12px;">
            <a href="https://github.com/fineanmol/chatgpt-bulk-delete" target="_blank" style="display: flex; align-items: center; color: var(--cbd-text-muted); text-decoration: none; font-size: 11px; gap: 4px;" class="cbd-footer-link">
              <svg width="12" height="12" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.579.688.481C19.137 20.162 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>
              GitHub
            </a>
            <div class="cbd-footer-badge">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#10a37f" stroke-width="2.5" style="margin-right:4px;">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              <span>100% Private</span>
            </div>
          </div>
        </div>

        <!-- Progress Dialog -->
        <div class="cbd-progress-overlay">
          <div class="cbd-progress-card">
            <div class="cbd-progress-title">Processing Bulk Deletion Queue</div>
            <div class="cbd-progress-bar-bg">
              <div class="cbd-progress-bar-fill"></div>
            </div>
            <div class="cbd-progress-percentage">0%</div>
            <div class="cbd-progress-stats">Permanently deleting chat 0 of 0</div>
            <div class="cbd-status-label" id="cbd-current-title"></div>
            <button class="cbd-action-btn cbd-btn-secondary" id="cbd-cancel-btn">Abort Queue</button>
          </div>
        </div>

      </div>
    `;

    // Hook up Events
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeManagerModal();
    });

    // Toggle rate configuration drawer
    overlay.querySelector('#cbd-settings-btn').addEventListener('click', () => {
      const drawer = overlay.querySelector('#cbd-settings-drawer');
      drawer.classList.toggle('active');
    });

    // Theme toggle
    overlay.querySelector('#cbd-theme-toggle').addEventListener('click', toggleTheme);

    // Search input
    overlay.querySelector('#cbd-search').addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      currentPage = 0;
      renderList();
      updateStats();
    });

    // Filters dropdowns
    overlay.querySelector('#cbd-time-dropdown').addEventListener('change', (e) => {
      timeFilter = e.target.value;
      currentPage = 0;
      renderList();
      updateStats();
    });

    overlay.querySelector('#cbd-type-dropdown').addEventListener('change', (e) => {
      typeFilter = e.target.value;
      currentPage = 0;
      renderList();
      updateStats();
    });

    // Quick filter triggers
    overlay.querySelector('#cbd-refresh-btn').addEventListener('click', () => {
      loadConversations(overlay.querySelector('.cbd-grid-container'));
    });
    overlay.querySelector('#cbd-btn-invert').addEventListener('click', invertSelection);
    overlay.querySelector('#cbd-btn-untitled').addEventListener('click', selectUntitledChats);
    overlay.querySelector('#cbd-btn-7d').addEventListener('click', () => selectOlderChats(7));
    overlay.querySelector('#cbd-btn-30d').addEventListener('click', () => selectOlderChats(30));

    // Select All Checkbox
    overlay.querySelector('#cbd-select-all-cb').addEventListener('change', (e) => {
      handleSelectAllPageToggle(e.target.checked);
    });

    // Reset preview panel
    overlay.querySelector('#cbd-reset-preview-btn').addEventListener('click', () => {
      document.querySelectorAll('.cbd-card').forEach(card => card.classList.remove('previewing'));
      currentPreviewId = null;
      resetPreviewPanel();
    });

    // Radio button changes for action mode
    overlay.querySelectorAll('input[name="cbd-action-mode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        actionMode = e.target.value;
        localStorage.setItem('cbd-action-mode', actionMode);
        updateStats();
      });
    });

    // Slider Controls
    const slider = overlay.querySelector('#cbd-delay-slider');
    const sliderVal = overlay.querySelector('#cbd-delay-val');
    slider.addEventListener('input', (e) => {
      const secs = (e.target.value / 1000).toFixed(1);
      sliderVal.innerText = `${secs}s`;
      updateStats();
    });

    // CTAs
    overlay.querySelector('#cbd-delete-btn').addEventListener('click', confirmDeletion);
    overlay.querySelector('#cbd-export-btn').addEventListener('click', exportSelectedConversations);
    
    // Abort
    overlay.querySelector('#cbd-cancel-btn').addEventListener('click', () => {
      cancelRequested = true;
      overlay.querySelector('#cbd-cancel-btn').innerText = 'Stopping...';
      overlay.querySelector('#cbd-cancel-btn').disabled = true;
    });

    return overlay;
  }

  // Short Date parser (M/D/YYYY)
  function formatShortDate(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
    } catch (e) {
      return '';
    }
  }

  // Full Date Time parser (M/D/YYYY, H:MM AM/PM)
  function formatFullDate(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      const short = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
      const time = date.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      return `${short}, ${time}`;
    } catch (e) {
      return dateStr;
    }
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
