// GrabVideo Popup Controller
const ENGINE_URL = 'http://127.0.0.1:54321';
let isEngineOnline = false;
let currentTab = null;
let mediaList = [];

// DOM
const engineStatus = document.getElementById('engineStatus');
const mediaCount = document.getElementById('mediaCount');
const btnDownloadAll = document.getElementById('btnDownloadAll');
const mediaListContainer = document.getElementById('mediaList');
const emptyState = document.getElementById('emptyState');
const btnOpenDashboard = document.getElementById('btnOpenDashboard');
const toastEl = document.getElementById('toast');

function isYoutubeUrl(urlStr) {
  if (!urlStr) return false;
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be') || host.includes('googlevideo.com');
  } catch (e) {
    return false;
  }
}

function getEffectiveFilename(item) {
  const isYoutube = item.isYoutube || isYoutubeUrl(item.url) || (currentTab && isYoutubeUrl(currentTab.url));
  if (!isYoutube && currentTab && currentTab.title) {
    const clean = currentTab.title
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
      .replace(/\.(mp4|webm|mkv|m3u8|ts|mp3|m4a|aac|flv|avi|mov|ogg|wav)$/i, '');
    if (clean && clean.length >= 2 && !/^https?:\/\//i.test(clean) && clean.toLowerCase() !== 'new tab') {
      const fmt = (item.format || 'mp4').toLowerCase();
      const ext = (fmt === 'bilibili' || fmt === 'tiktok' || fmt === 'm3u8') ? 'mp4' : fmt;
      return `${clean}.${ext}`;
    }
  }
  return item.filename || 'video.mp4';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Check Windows App connection
async function checkEngine() {
  try {
    const res = await fetch(`${ENGINE_URL}/api/status`, { method: 'GET' });
    if (res.ok) {
      isEngineOnline = true;
      engineStatus.className = 'engine-status online';
      engineStatus.innerHTML = '<span class="dot"></span><span>Windows App Siap</span>';
      return;
    }
  } catch (e) {}

  isEngineOnline = false;
  engineStatus.className = 'engine-status offline';
  engineStatus.innerHTML = '<span class="dot"></span><span>App Belum Dibuka</span>';
}

// Load media for current tab
async function loadMedia() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (!tab) return;

  chrome.runtime.sendMessage({
    type: 'GET_MEDIA_FOR_TAB',
    tabId: tab.id
  }, (response) => {
    mediaList = (response && response.items) || [];
    renderMedia();
  });
}

function renderMedia() {
  if (mediaList.length === 0) {
    emptyState.style.display = 'flex';
    mediaCount.textContent = '0 video ditemukan';
    btnDownloadAll.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  mediaCount.textContent = `${mediaList.length} media ditemukan`;
  btnDownloadAll.style.display = isEngineOnline && mediaList.length > 1 ? 'block' : 'none';

  // Clear existing
  const existing = mediaListContainer.querySelectorAll('.media-card');
  existing.forEach(c => c.remove());

  mediaList.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'media-card';

    if (item.isPlatform || item.isYoutube) {
      // Special Platform Card (YouTube, Bilibili, TikTok)
      const platName = item.platform || 'YOUTUBE';
      const platColor = item.platformColor || '#ef4444';
      const subText = item.hasSubtitles ? `${platName} Video + Sub Indo Terdeteksi` : `${platName} Video Terdeteksi`;

      card.innerHTML = `
        <div class="card-header">
          <div class="title-wrap">
            <div class="media-title" title="${item.title || item.filename}">${item.title || item.filename}</div>
            <div class="media-meta" style="color: ${platColor}; font-weight: 600;">${subText}</div>
          </div>
          <span class="format-tag" style="background: ${platColor}22; color: ${platColor};">${platName}</span>
        </div>
        <div class="card-actions" style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px;">
          <button class="btn-action-primary btn-yt-mp4" title="Unduh Video MP4 Kualitas Terbaik">
            ⚡ MP4 Video
          </button>
          <button class="btn-action-primary btn-yt-mp3" style="background: linear-gradient(135deg, #8b5cf6, #6366f1);" title="Unduh Audio MP3">
            🎵 MP3 Audio
          </button>
          <button class="btn-action-secondary btn-copy" title="Salin URL">
            📋
          </button>
        </div>
      `;

      const btnMp4 = card.querySelector('.btn-yt-mp4');
      btnMp4.addEventListener('click', () => sendToApp({
        url: item.url,
        filename: `${item.title || 'video'}.mp4`,
        format: 'mp4',
        pageTitle: item.title
      }));

      const btnMp3 = card.querySelector('.btn-yt-mp3');
      btnMp3.addEventListener('click', () => sendToApp({
        url: item.url,
        filename: `${item.title || 'audio'}.mp3`,
        format: 'mp3',
        pageTitle: item.title
      }));

      const btnCopy = card.querySelector('.btn-copy');
      btnCopy.addEventListener('click', () => {
        navigator.clipboard.writeText(item.url);
        showToast(`Link ${platName} berhasil disalin!`);
      });

    } else {
      // Generic Video Card
      const displayName = getEffectiveFilename(item);
      const sizeText = item.size > 0 ? formatBytes(item.size) : (item.format === 'M3U8' ? 'HLS Stream' : 'Ukuran Otomatis');

      card.innerHTML = `
        <div class="card-header">
          <div class="title-wrap">
            <div class="media-title" title="${displayName}">${displayName}</div>
            <div class="media-meta">${sizeText}</div>
          </div>
          <span class="format-tag ${item.format}">${item.format}</span>
        </div>
        <div class="card-actions">
          <button class="btn-action-primary" data-index="${index}">
            ⚡ Download di App
          </button>
          <button class="btn-action-secondary btn-browser" data-index="${index}" title="Download via Browser">
            ⬇️ Browser
          </button>
          <button class="btn-action-secondary btn-copy" data-index="${index}" title="Salin URL">
            📋 Salin
          </button>
        </div>
      `;

      const btnApp = card.querySelector('.btn-action-primary');
      btnApp.addEventListener('click', () => sendToApp(item));

      const btnBrowser = card.querySelector('.btn-browser');
      btnBrowser.addEventListener('click', () => downloadInBrowser(item));

      const btnCopy = card.querySelector('.btn-copy');
      btnCopy.addEventListener('click', () => {
        navigator.clipboard.writeText(item.url);
        showToast('URL berhasil disalin!');
      });
    }

    mediaListContainer.appendChild(card);
  });
}

// Send item to Windows Desktop App Engine
async function sendToApp(item) {
  if (!isEngineOnline) {
    showToast('Buka Windows App terlebih dahulu!', 3000);
    return;
  }

  try {
    const res = await fetch(`${ENGINE_URL}/api/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: item.url,
        filename: getEffectiveFilename(item),
        format: item.format ? item.format.toLowerCase() : null,
        pageTitle: item.pageTitle || (currentTab ? currentTab.title : ''),
        pageUrl: currentTab ? currentTab.url : '',
        headers: {
          'Referer': currentTab ? currentTab.url : ''
        }
      })
    });

    if (res.ok) {
      showToast('✅ Berhasil dikirim ke Windows App!');
    } else {
      const data = await res.json();
      showToast(data.error || 'Gagal mengirim ke App');
    }
  } catch (err) {
    showToast('Gagal menghubungi Windows App');
  }
}

// Download directly in browser fallback
function downloadInBrowser(item) {
  const a = document.createElement('a');
  a.href = item.url;
  a.download = getEffectiveFilename(item);
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('Memulai unduhan di browser...');
}

// Batch download all
btnDownloadAll.addEventListener('click', async () => {
  if (!isEngineOnline) {
    showToast('Buka Windows App terlebih dahulu!');
    return;
  }

  let sent = 0;
  for (const item of mediaList) {
    try {
      await fetch(`${ENGINE_URL}/api/downloads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: item.url,
          filename: getEffectiveFilename(item),
          format: item.format ? item.format.toLowerCase() : null,
          pageTitle: item.pageTitle || (currentTab ? currentTab.title : ''),
          pageUrl: currentTab ? currentTab.url : ''
        })
      });
      sent++;
    } catch (e) {}
  }
  showToast(`✅ ${sent} video dikirim ke Windows App!`);
});

// Open Dashboard
btnOpenDashboard.addEventListener('click', () => {
  chrome.tabs.create({ url: ENGINE_URL });
});

// Toast notification
function showToast(text, duration = 2500) {
  toastEl.textContent = text;
  toastEl.style.display = 'block';
  setTimeout(() => {
    toastEl.style.display = 'none';
  }, duration);
}

// Init
checkEngine();
loadMedia();
