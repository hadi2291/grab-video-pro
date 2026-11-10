// GrabVideo Content Script - Inspects page DOM for HTML5 media elements & YouTube detection
(function() {
  let lastYoutubeUrl = '';

  function checkYoutube() {
    const isYt = window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be');
    if (!isYt) return false;

    const isWatch = window.location.pathname === '/watch' || window.location.pathname.startsWith('/shorts/');
    if (!isWatch) return false;

    const currentUrl = window.location.href;
    if (currentUrl === lastYoutubeUrl) return true;

    // Get YouTube title
    let title = document.title.replace(' - YouTube', '').trim();
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, #title h1');
    if (titleEl && titleEl.textContent.trim()) {
      title = titleEl.textContent.trim();
    }

    if (!title || title === 'YouTube') {
      setTimeout(checkYoutube, 1000);
      return true;
    }

    lastYoutubeUrl = currentUrl;

    chrome.runtime.sendMessage({
      type: 'YOUTUBE_MEDIA_FOUND',
      item: {
        url: currentUrl,
        filename: `${title}.mp4`,
        title: title,
        format: 'YOUTUBE',
        isYoutube: true,
        source: 'youtube'
      }
    }).catch(() => {});

    return true;
  }

  function scanMedia() {
    if (checkYoutube()) {
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

      // Check inner <source> tags
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

  // YouTube SPA navigation listener
  window.addEventListener('yt-navigate-finish', () => {
    lastYoutubeUrl = '';
    setTimeout(scanMedia, 600);
  });

  const observer = new MutationObserver(() => {
    scanMedia();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
