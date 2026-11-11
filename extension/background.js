// GrabVideo - Service Worker Background Sniffer
const tabMedia = new Map(); // tabId -> Array of media items

function getExtension(url) {
  const clean = url.split('?')[0].toLowerCase();
  const match = clean.match(/\.(mp4|webm|m3u8|ts|mp3|m4a|aac|flv|mkv|mov|ogg|wav)$/i);
  return match ? match[1].toLowerCase() : null;
}

function getHeader(headers, name) {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === target) {
      return h.value;
    }
  }
  return null;
}

// Sniff requests via chrome.webRequest
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId <= 0) return;

    const url = details.url;
    if (url.startsWith('chrome') || url.includes('127.0.0.1:54321') || url.includes('localhost:54321')) {
      return;
    }

    const contentType = getHeader(details.responseHeaders, 'content-type') || '';
    const contentLength = parseInt(getHeader(details.responseHeaders, 'content-length') || '0', 10);
    const contentDisposition = getHeader(details.responseHeaders, 'content-disposition') || '';

    let ext = getExtension(url);
    const isVideoMime = contentType.includes('video/') ||
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl');
    const isAudioMime = contentType.includes('audio/');

    if (isVideoMime) {
      if (!ext) {
        if (contentType.includes('mp4')) ext = 'mp4';
        else if (contentType.includes('webm')) ext = 'webm';
        else if (contentType.includes('mpegurl')) ext = 'm3u8';
        else ext = 'mp4';
      }
    } else if (isAudioMime) {
      if (!ext) {
        if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = 'mp3';
        else if (contentType.includes('mp4') || contentType.includes('m4a')) ext = 'm4a';
        else ext = 'mp3';
      }
    }

    if (!ext && !isVideoMime && !isAudioMime) {
      return;
    }

    // Filter tiny snippet unless m3u8
    if (contentLength > 0 && contentLength < 50 * 1024 && ext !== 'm3u8') {
      return;
    }

    let filename = '';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
      if (match) filename = decodeURIComponent(match[1]);
    }
    if (!filename) {
      try {
        const u = new URL(url);
        const base = u.pathname.split('/').pop();
        if (base && base.length > 2) {
          filename = decodeURIComponent(base);
        }
      } catch (e) {}
    }
    if (!filename) {
      filename = `media_${Date.now()}.${ext || 'mp4'}`;
    }

    addMediaItem(details.tabId, {
      url,
      filename,
      format: (ext || 'mp4').toUpperCase(),
      size: contentLength,
      contentType,
      source: 'network',
      timestamp: Date.now()
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

function addMediaItem(tabId, item) {
  let list = tabMedia.get(tabId);
  if (!list) {
    list = [];
    tabMedia.set(tabId, list);
  }

  // If item is a platform item (YouTube, Bilibili, TikTok), put at top
  if (item.isPlatform || item.isYoutube) {
    list = list.filter(m => !m.isPlatform && !m.isYoutube);
    list.unshift(item);
    tabMedia.set(tabId, list);
    updateBadge(tabId);
    return;
  }

  // Avoid duplicates
  const existing = list.find(m => m.url === item.url);
  if (existing) {
    if (item.size && !existing.size) existing.size = item.size;
    return;
  }

  list.push(item);
  updateBadge(tabId);
}

function updateBadge(tabId) {
  const list = tabMedia.get(tabId) || [];
  const count = list.length;
  if (count > 0) {
    chrome.action.setBadgeText({ tabId, text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' }); // YouTube-friendly red/blue
  } else {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
}

// Clear or update tab media on navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabMedia.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
});

// Messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if ((message.type === 'YOUTUBE_MEDIA_FOUND' || message.type === 'PLATFORM_MEDIA_FOUND') && sender.tab) {
    const tabId = sender.tab.id;
    addMediaItem(tabId, message.item);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'DOM_MEDIA_FOUND' && sender.tab) {
    const tabId = sender.tab.id;
    for (const item of message.items) {
      addMediaItem(tabId, {
        url: item.url,
        filename: item.filename || `video_${Date.now()}.mp4`,
        format: (item.format || 'mp4').toUpperCase(),
        size: 0,
        contentType: '',
        source: 'dom',
        pageTitle: sender.tab.title || '',
        timestamp: Date.now()
      });
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_MEDIA_FOR_TAB') {
    const list = tabMedia.get(message.tabId) || [];
    sendResponse({ items: list });
    return true;
  }

  if (message.type === 'CLEAR_TAB_MEDIA') {
    tabMedia.delete(message.tabId);
    updateBadge(message.tabId);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'TRIGGER_INLINE_DOWNLOAD' && sender.tab) {
    const tabId = sender.tab.id;
    let targetItem = message.item || {};

    // If video was blob: on generic site, pick best sniffed network stream
    if (!targetItem.url) {
      const list = tabMedia.get(tabId) || [];
      if (list.length > 0) {
        const best = list.find(m => m.format === 'M3U8') ||
                     list.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];
        if (best) {
          targetItem = {
            url: best.url,
            filename: best.filename,
            format: (best.format || 'mp4').toLowerCase(),
            pageTitle: sender.tab.title || best.filename
          };
        }
      }
    }

    if (!targetItem.url) {
      sendResponse({ ok: false, error: 'Putar video sebentar agar stream terdeteksi.' });
      return true;
    }

    fetch('http://127.0.0.1:54321/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetItem.url,
        filename: targetItem.filename || `${sender.tab.title || 'video'}.mp4`,
        format: targetItem.format || null,
        pageTitle: targetItem.pageTitle || sender.tab.title || '',
        pageUrl: sender.tab.url || '',
        headers: {
          'Referer': sender.tab.url || ''
        }
      })
    })
      .then(async (res) => {
        if (res.ok) {
          sendResponse({ ok: true });
        } else {
          const data = await res.json().catch(() => ({}));
          sendResponse({ ok: false, error: data.error || 'Gagal mengirim ke App' });
        }
      })
      .catch(() => {
        sendResponse({ ok: false, error: 'Buka aplikasi GrabVideo Windows dulu!' });
      });

    return true; // keep message channel open for async fetch
  }
});
