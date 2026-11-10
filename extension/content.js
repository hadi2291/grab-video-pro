// GrabVideo Content Script - Inspects page DOM for HTML5 media elements
(function() {
  function scanMedia() {
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

  // Scan immediately and after DOM changes
  scanMedia();

  const observer = new MutationObserver(() => {
    scanMedia();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
