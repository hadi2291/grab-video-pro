// GrabVideo Content Script - Inspects page DOM for HTML5 media elements & Supported Platforms
(function() {
  let lastDetectedUrl = '';

  function checkSupportedPlatforms() {
    const host = window.location.hostname.toLowerCase();
    const path = window.location.pathname;
    const currentUrl = window.location.href;

    // 1. YouTube
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      const isWatch = path === '/watch' || path.startsWith('/shorts/');
      if (!isWatch) return false;
      if (currentUrl === lastDetectedUrl) return true;

      let title = document.title.replace(' - YouTube', '').trim();
      const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, #title h1');
      if (titleEl && titleEl.textContent.trim()) {
        title = titleEl.textContent.trim();
      }

      if (!title || title === 'YouTube') {
        setTimeout(checkSupportedPlatforms, 1000);
        return true;
      }

      lastDetectedUrl = currentUrl;
      sendPlatformMedia({
        url: currentUrl,
        filename: `${title}.mp4`,
        title: title,
        format: 'YOUTUBE',
        platform: 'YOUTUBE',
        platformColor: '#ef4444',
        isYoutube: true,
        isPlatform: true
      });
      return true;
    }

    // 2. Bilibili.tv
    if (host.includes('bilibili.tv') && path.includes('/play/')) {
      if (currentUrl === lastDetectedUrl) return true;

      let title = document.title.replace(/ - Bilibili.*/i, '').replace(/ \| Bilibili.*/i, '').trim();
      const epTitleEl = document.querySelector('.video-info__title, h1, .bstar-video-title');
      if (epTitleEl && epTitleEl.textContent.trim()) {
        title = epTitleEl.textContent.trim();
      }

      // If URL is series-only (/play/2432940), try to find the active episode URL from DOM
      let targetUrl = currentUrl;
      const playMatch = path.match(/\/play\/(\d+)(?:\/(\d+))?/);
      if (playMatch && !playMatch[2]) {
        const seriesId = playMatch[1];
        const activeEpLink = document.querySelector(`a[href*="/play/${seriesId}/"].active, a[href*="/play/${seriesId}/"][class*="active"]`);
        if (activeEpLink && activeEpLink.href) {
          targetUrl = activeEpLink.href;
        }
      }

      lastDetectedUrl = currentUrl;
      sendPlatformMedia({
        url: targetUrl,
        filename: `${title || 'bilibili_anime'}.mp4`,
        title: title || 'Bilibili Anime',
        format: 'BILIBILI',
        platform: 'BILIBILI',
        platformColor: '#00a1d6',
        isPlatform: true,
        hasSubtitles: true
      });
      return true;
    }

    // 3. TikTok Video Page
    if (host.includes('tiktok.com') && path.includes('/video/')) {
      if (currentUrl === lastDetectedUrl) return true;
      let title = document.title.replace(/ \| TikTok/i, '').trim() || 'TikTok Video';
      lastDetectedUrl = currentUrl;
      sendPlatformMedia({
        url: currentUrl,
        filename: `${title}.mp4`,
        title: title,
        format: 'TIKTOK',
        platform: 'TIKTOK',
        platformColor: '#fe2c55',
        isPlatform: true
      });
      return true;
    }

    return false;
  }

  function sendPlatformMedia(item) {
    chrome.runtime.sendMessage({
      type: 'PLATFORM_MEDIA_FOUND',
      item
    }).catch(() => {});
  }

  function scanMedia() {
    if (checkSupportedPlatforms()) {
      return;
    }

    const found = [];

    // Find all video tags
    const videos = document.querySelectorAll('video');
    videos.forEach(v => {
      const src = v.currentSrc || v.src;
      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
        found.push({
          url: src,
          format: detectExt(src) || 'mp4'
        });
      }

      v.querySelectorAll('source').forEach(s => {
        if (s.src && !s.src.startsWith('blob:') && !s.src.startsWith('data:')) {
          found.push({
            url: s.src,
            format: detectExt(s.src) || (s.type && s.type.includes('webm') ? 'webm' : 'mp4')
          });
        }
      });
    });

    // Find audio tags
    const audios = document.querySelectorAll('audio');
    audios.forEach(a => {
      const src = a.currentSrc || a.src;
      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
        found.push({
          url: src,
          format: detectExt(src) || 'mp3'
        });
      }
    });

    if (found.length > 0) {
      chrome.runtime.sendMessage({
        type: 'DOM_MEDIA_FOUND',
        items: found
      }).catch(() => {});
    }
  }

  function detectExt(url) {
    const clean = url.split('?')[0].toLowerCase();
    const match = clean.match(/\.(mp4|webm|m3u8|ts|mp3|m4a|aac|flv|mkv|mov|ogg|wav)$/i);
    return match ? match[1] : null;
  }

  // Scan immediately
  scanMedia();

  // Handle SPA navigation (YouTube, Bilibili, TikTok)
  window.addEventListener('yt-navigate-finish', () => {
    lastDetectedUrl = '';
    setTimeout(scanMedia, 600);
  });

  window.addEventListener('popstate', () => {
    lastDetectedUrl = '';
    setTimeout(scanMedia, 800);
  });

  const observer = new MutationObserver(() => {
    scanMedia();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
