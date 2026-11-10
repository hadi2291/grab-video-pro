// GrabVideo Desktop Web Application Controller
let downloads = [];
let currentFilter = 'all';
let searchQuery = '';
let itemToDelete = null;

// DOM Elements
const downloadList = document.getElementById('downloadList');
const emptyState = document.getElementById('emptyState');
const statTotal = document.getElementById('statTotal');
const statActive = document.getElementById('statActive');
const statCompleted = document.getElementById('statCompleted');
const statSpeed = document.getElementById('statSpeed');
const searchInput = document.getElementById('searchInput');
const filterButtons = document.querySelectorAll('.filter-btn');

// Modals
const addModal = document.getElementById('addModal');
const btnShowAddModal = document.getElementById('btnShowAddModal');
const btnCloseAddModal = document.getElementById('btnCloseAddModal');
const btnCancelAdd = document.getElementById('btnCancelAdd');
const addDownloadForm = document.getElementById('addDownloadForm');
const btnOpenFolder = document.getElementById('btnOpenFolder');

const deleteModal = document.getElementById('deleteModal');
const btnCloseDeleteModal = document.getElementById('btnCloseDeleteModal');
const btnCancelDelete = document.getElementById('btnCancelDelete');
const btnConfirmDelete = document.getElementById('btnConfirmDelete');
const deleteItemTitle = document.getElementById('deleteItemTitle');
const checkDeletePhysicalFile = document.getElementById('checkDeletePhysicalFile');

// Format Helpers
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === 0) return '0 KB/s';
  const k = 1024;
  if (bytesPerSec < k) return bytesPerSec + ' B/s';
  if (bytesPerSec < k * k) return (bytesPerSec / k).toFixed(1) + ' KB/s';
  return (bytesPerSec / (k * k)).toFixed(2) + ' MB/s';
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--:--';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) {
    return `${hrs}j ${mins}m`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatStatusText(status) {
  const map = {
    queued: 'Antre',
    downloading: 'Mengunduh',
    paused: 'Dijeda',
    completed: 'Selesai',
    cancelled: 'Dibatalkan',
    error: 'Gagal'
  };
  return map[status] || status;
}

// Fetch Initial Data
async function loadDownloads() {
  try {
    const res = await fetch('/api/downloads');
    if (res.ok) {
      downloads = await res.json();
      render();
    }
  } catch (err) {
    console.error('Failed to load downloads:', err);
    showToast('Gagal memuat daftar unduhan', 'error');
  }
}

// Setup Real-time SSE Connection
function setupSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    const index = downloads.findIndex(d => d.id === data.id);
    if (index !== -1) {
      Object.assign(downloads[index], data);
      updateItemProgress(downloads[index]);
      updateStats();
    }
  });

  es.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    const index = downloads.findIndex(d => d.id === data.id);
    if (index !== -1) {
      Object.assign(downloads[index], data);
      render();
    } else {
      downloads.unshift(data);
      render();
    }
  });

  es.addEventListener('added', (e) => {
    const data = JSON.parse(e.data);
    if (!downloads.find(d => d.id === data.id)) {
      downloads.unshift(data);
      render();
      showToast(`Mulai mengunduh: ${data.filename}`, 'info');
    }
  });

  es.addEventListener('removed', (e) => {
    const { id } = JSON.parse(e.data);
    downloads = downloads.filter(d => d.id !== id);
    render();
  });

  es.onerror = () => {
    document.getElementById('connectionBadge').style.display = 'none';
  };
}

// Update single item DOM without full re-render for smooth 60fps progress
function updateItemProgress(item) {
  const card = document.querySelector(`[data-id="${item.id}"]`);
  if (!card) return;

  const isM3U8 = item.format === 'm3u8';
  let percentage = 0;

  if (item.totalBytes > 0) {
    percentage = Math.min(100, Math.round((item.downloadedBytes / item.totalBytes) * 100));
  } else if (item.status === 'completed') {
    percentage = 100;
  }

  const fill = card.querySelector('.progress-fill');
  if (fill) {
    fill.style.width = percentage + '%';
  }

  const pctText = card.querySelector('.metric-percentage');
  if (pctText) {
    pctText.textContent = percentage + '%';
  }

  const sizeText = card.querySelector('.metric-size');
  if (sizeText) {
    if (isM3U8) {
      sizeText.textContent = `${item.downloadedSegments || 0} / ${item.totalSegments || '?'} segmen`;
    } else {
      sizeText.textContent = `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)}`;
    }
  }

  const speedText = card.querySelector('.metric-speed');
  if (speedText) {
    speedText.textContent = formatSpeed(item.speed);
  }

  const etaText = card.querySelector('.metric-eta');
  if (etaText) {
    etaText.textContent = `Sisa: ${formatEta(item.eta)}`;
  }
}

// Render Stats Cards
function updateStats() {
  statTotal.textContent = downloads.length;
  statActive.textContent = downloads.filter(d => d.status === 'downloading').length;
  statCompleted.textContent = downloads.filter(d => d.status === 'completed').length;

  const totalSpeedBytes = downloads
    .filter(d => d.status === 'downloading')
    .reduce((sum, d) => sum + (d.speed || 0), 0);
  statSpeed.textContent = formatSpeed(totalSpeedBytes);
}

// Render Main Download List
function render() {
  updateStats();

  const filtered = downloads.filter(item => {
    // Filter by tab
    if (currentFilter === 'downloading' && item.status !== 'downloading') return false;
    if (currentFilter === 'paused' && item.status !== 'paused') return false;
    if (currentFilter === 'completed' && item.status !== 'completed') return false;
    if (currentFilter === 'cancelled' && item.status !== 'cancelled' && item.status !== 'error') return false;

    // Filter by search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchName = (item.filename || '').toLowerCase().includes(q);
      const matchUrl = (item.url || '').toLowerCase().includes(q);
      const matchTitle = (item.pageTitle || '').toLowerCase().includes(q);
      if (!matchName && !matchUrl && !matchTitle) return false;
    }

    return true;
  });

  if (filtered.length === 0) {
    emptyState.style.display = 'flex';
    // Remove existing cards
    const existing = downloadList.querySelectorAll('.download-card');
    existing.forEach(c => c.remove());
    return;
  }

  emptyState.style.display = 'none';

  // Build HTML for all cards
  const existingCards = downloadList.querySelectorAll('.download-card');
  existingCards.forEach(c => c.remove());

  filtered.forEach(item => {
    const card = createCardElement(item);
    downloadList.appendChild(card);
  });
}

function createCardElement(item) {
  const isM3U8 = item.format === 'm3u8';
  let percentage = 0;

  if (item.totalBytes > 0) {
    percentage = Math.min(100, Math.round((item.downloadedBytes / item.totalBytes) * 100));
  } else if (item.status === 'completed') {
    percentage = 100;
  }

  const card = document.createElement('div');
  card.className = 'download-card';
  card.setAttribute('data-id', item.id);

  const formatClass = (item.format || 'mp4').toLowerCase();

  // Action buttons depending on status
  let controlBtn = '';
  if (item.status === 'downloading') {
    controlBtn = `
      <button class="btn-icon pause" title="Jeda / Pause" onclick="pauseDownload('${item.id}')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
      </button>
      <button class="btn-icon cancel" title="Batalkan / Cancel" onclick="cancelDownload('${item.id}')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>
      </button>
    `;
  } else if (item.status === 'paused' || item.status === 'queued' || item.status === 'cancelled') {
    controlBtn = `
      <button class="btn-icon play" title="Lanjutkan / Start" onclick="startDownload('${item.id}')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
      </button>
    `;
  }

  // Open file button if completed
  let fileBtns = '';
  if (item.status === 'completed') {
    fileBtns = `
      <button class="btn-icon" title="Buka Video" onclick="openFile('${item.id}')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
      </button>
    `;
  }

  card.innerHTML = `
    <div class="card-top">
      <div class="file-info">
        <div class="file-format-badge ${formatClass}">${item.format || 'MP4'}</div>
        <div class="file-text">
          <div class="file-name" title="${item.filename}">${item.filename}</div>
          <span class="file-url" title="${item.url}">${item.pageTitle || item.url}</span>
        </div>
      </div>
      <div class="status-pill ${item.status}">
        ${formatStatusText(item.status)}
      </div>
    </div>

    <div class="progress-container">
      <div class="progress-track">
        <div class="progress-fill ${item.status}" style="width: ${percentage}%"></div>
      </div>
    </div>

    <div class="card-bottom">
      <div class="metrics-info">
        <span class="metric-item metric-percentage"><strong>${percentage}%</strong></span>
        <span class="metric-item metric-size">
          ${isM3U8 ? `${item.downloadedSegments || 0} / ${item.totalSegments || '?'} segmen` : `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)}`}
        </span>
        ${item.status === 'downloading' ? `
          <span class="metric-item metric-speed">${formatSpeed(item.speed)}</span>
          <span class="metric-item metric-eta">Sisa: ${formatEta(item.eta)}</span>
        ` : ''}
        ${item.error ? `<span class="metric-item text-danger" style="color:var(--accent-red)">${item.error}</span>` : ''}
      </div>

      <div class="action-buttons">
        ${controlBtn}
        ${fileBtns}
        <button class="btn-icon" title="Buka Folder di Explorer" onclick="openFolder('${item.id}')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        </button>
        <button class="btn-icon trash" title="Hapus dari Riwayat" onclick="showDeleteConfirm('${item.id}')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    </div>
  `;

  return card;
}

// Action Handlers
async function startDownload(id) {
  try {
    await fetch(`/api/downloads/${id}/start`, { method: 'POST' });
  } catch (err) {
    showToast('Gagal memulai unduhan', 'error');
  }
}

async function pauseDownload(id) {
  try {
    await fetch(`/api/downloads/${id}/pause`, { method: 'POST' });
  } catch (err) {
    showToast('Gagal menjeda unduhan', 'error');
  }
}

async function cancelDownload(id) {
  try {
    await fetch(`/api/downloads/${id}/cancel`, { method: 'POST' });
  } catch (err) {
    showToast('Gagal membatalkan unduhan', 'error');
  }
}

async function openFile(id) {
  try {
    const res = await fetch(`/api/downloads/${id}/open-file`, { method: 'POST' });
    if (!res.ok) {
      showToast('File tidak ditemukan di disk', 'error');
    }
  } catch (err) {
    showToast('Gagal membuka file', 'error');
  }
}

async function openFolder(id) {
  try {
    await fetch(`/api/downloads/${id}/open-folder`, { method: 'POST' });
  } catch (err) {
    showToast('Gagal membuka folder', 'error');
  }
}

// Delete Confirmation
function showDeleteConfirm(id) {
  itemToDelete = downloads.find(d => d.id === id);
  if (!itemToDelete) return;

  deleteItemTitle.textContent = itemToDelete.filename;
  checkDeletePhysicalFile.checked = false;
  deleteModal.classList.add('active');
}

btnConfirmDelete.addEventListener('click', async () => {
  if (!itemToDelete) return;
  const deletePhysical = checkDeletePhysicalFile.checked;

  try {
    const res = await fetch(`/api/downloads/${itemToDelete.id}?deleteFile=${deletePhysical}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      showToast('Item berhasil dihapus', 'success');
      deleteModal.classList.remove('active');
      itemToDelete = null;
    }
  } catch (err) {
    showToast('Gagal menghapus item', 'error');
  }
});

btnCloseDeleteModal.addEventListener('click', () => deleteModal.classList.remove('active'));
btnCancelDelete.addEventListener('click', () => deleteModal.classList.remove('active'));

// Open Folder Button in Header
btnOpenFolder.addEventListener('click', async () => {
  try {
    await fetch('/api/downloads/dir/open-folder', { method: 'POST' }).catch(() => {
      // If endpoint doesn't exist, call first item's open-folder or fallback
      if (downloads.length > 0) {
        openFolder(downloads[0].id);
      }
    });
  } catch (err) {
    console.error(err);
  }
});

// Add Modal Events
btnShowAddModal.addEventListener('click', () => {
  addModal.classList.add('active');
  document.getElementById('inputUrl').focus();
});

btnCloseAddModal.addEventListener('click', () => addModal.classList.remove('active'));
btnCancelAdd.addEventListener('click', () => addModal.classList.remove('active'));

addDownloadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('inputUrl').value.trim();
  const filename = document.getElementById('inputFilename').value.trim();
  const format = document.getElementById('selectFormat').value;

  if (!url) return;

  try {
    const res = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        filename,
        format: format === 'auto' ? null : format
      })
    });

    if (res.ok) {
      addModal.classList.remove('active');
      addDownloadForm.reset();
      showToast('Unduhan baru berhasil ditambahkan', 'success');
    } else {
      const data = await res.json();
      showToast(data.error || 'Gagal menambahkan link', 'error');
    }
  } catch (err) {
    showToast('Gagal terhubung ke engine', 'error');
  }
});

// Filter Buttons
filterButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    filterButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.getAttribute('data-filter');
    render();
  });
});

// Search Input
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  render();
});

// Toast notification
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Initialize
loadDownloads();
setupSSE();
