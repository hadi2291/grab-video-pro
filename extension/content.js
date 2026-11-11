// GrabVideo Content Script - Sniffer + Floating In-Page Video Download Button
(function() {
  let lastDetectedUrl = '';
  let currentPlatformInfo = null;
  const videoOverlays = new WeakMap(); // videoEl -> { host, dismissed, updatePos }

  function getCleanPageTitle() {
    const raw = (document.title || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (!raw || raw.length < 2 || /^https?:\/\//i.test(raw)) return '';
    return raw;
  }

  function detectPlatformInfo() {
    const host = window.location.hostname.toLowerCase();
    const path = window.location.pathname;
    const currentUrl = window.location.href;

    // 1. YouTube
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      const isWatch = path === '/watch' || path.startsWith('/shorts/');
      if (!isWatch) return null;

      let title = document.title.replace(' - YouTube', '').trim();
      const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, #title h1');
      if (titleEl && titleEl.textContent.trim()) {
        title = titleEl.textContent.trim();
      }
      if (!title || title === 'YouTube') return 'WAIT';

      return {
        url: currentUrl,
        filename: `${title}.mp4`,
        title: title,
        format: 'YOUTUBE',
        platform: 'YOUTUBE',
        platformColor: '#ef4444',
        isYoutube: true,
        isPlatform: true
      };
    }

    // 2. Bilibili.tv
    if (host.includes('bilibili.tv') && path.includes('/play/')) {
      const title = getCleanPageTitle() || 'bilibili_anime';

      let targetUrl = currentUrl;
      const playMatch = path.match(/\/play\/(\d+)(?:\/(\d+))?/);
      if (playMatch && !playMatch[2]) {
        const seriesId = playMatch[1];
        const activeEpLink = document.querySelector(`a[href*="/play/${seriesId}/"].active, a[href*="/play/${seriesId}/"][class*="active"]`);
        if (activeEpLink && activeEpLink.href) {
          targetUrl = activeEpLink.href;
        }
      }

      return {
        url: targetUrl,
        filename: `${title}.mp4`,
        title: title,
        format: 'BILIBILI',
        platform: 'BILIBILI',
        platformColor: '#00a1d6',
        isPlatform: true,
        hasSubtitles: true
      };
    }

    // 3. TikTok Video Page
    if (host.includes('tiktok.com') && path.includes('/video/')) {
      const title = getCleanPageTitle() || 'TikTok Video';
      return {
        url: currentUrl,
        filename: `${title}.mp4`,
        title: title,
        format: 'TIKTOK',
        platform: 'TIKTOK',
        platformColor: '#fe2c55',
        isPlatform: true
      };
    }

    return null;
  }

  function checkSupportedPlatforms() {
    const currentUrl = window.location.href;
    const info = detectPlatformInfo();

    if (info === 'WAIT') {
      setTimeout(checkSupportedPlatforms, 1000);
      return true;
    }

    if (info) {
      currentPlatformInfo = info;
      if (currentUrl !== lastDetectedUrl) {
        lastDetectedUrl = currentUrl;
        chrome.runtime.sendMessage({
          type: 'PLATFORM_MEDIA_FOUND',
          item: info
        }).catch(() => {});
      }
      return true;
    }

    currentPlatformInfo = null;
    return false;
  }

  // --- FLOATING DOWNLOAD ICON ON VIDEO ---
  function attachOverlayToVideo(video) {
    if (videoOverlays.has(video)) return;

    const host = document.createElement('div');
    host.className = 'grabvideo-floating-host';
    host.style.cssText = 'position: fixed; z-index: 2147483647; pointer-events: auto; display: none;';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        .gv-bar {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: rgba(15, 23, 42, 0.88);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 9999px;
          padding: 4px 6px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #f8fafc;
          transition: all 0.2s ease;
          opacity: 0.88;
        }
        .gv-bar:hover {
          opacity: 1;
          background: rgba(15, 23, 42, 0.96);
          border-color: rgba(59, 130, 246, 0.6);
        }
        .gv-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          background: linear-gradient(135deg, #3b82f6, #2563eb);
          color: #ffffff;
          border: none;
          border-radius: 9999px;
          padding: 5px 10px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
          transition: transform 0.15s ease, opacity 0.15s ease;
        }
        .gv-btn:hover {
          transform: scale(1.03);
        }
        .gv-btn.mp3 {
          background: linear-gradient(135deg, #8b5cf6, #6366f1);
          display: none;
        }
        .gv-bar:hover .gv-btn.mp3,
        .gv-bar:hover .gv-res {
          display: inline-flex;
        }
        .gv-res {
          display: none;
          background: rgba(30, 41, 59, 0.95);
          color: #f8fafc;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 9999px;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 600;
          outline: none;
          cursor: pointer;
          font-family: inherit;
        }
        .gv-btn.success {
          background: linear-gradient(135deg, #10b981, #059669);
        }
        .gv-btn.error {
          background: linear-gradient(135deg, #ef4444, #dc2626);
        }
        .gv-close {
          background: transparent;
          border: none;
          color: #94a3b8;
          font-size: 13px;
          line-height: 1;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          cursor: pointer;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 0;
        }
        .gv-bar:hover .gv-close {
          display: inline-flex;
        }
        .gv-close:hover {
          color: #ffffff;
          background: rgba(255, 255, 255, 0.12);
        }
        svg {
          flex-shrink: 0;
        }
      </style>
      <div class="gv-bar">
        <button class="gv-btn mp4" title="Unduh video ke GrabVideo Windows App">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          <span class="label">Unduh Video</span>
        </button>
        <select class="gv-res" title="Pilih Resolusi">
          <option value="auto">Auto</option>
          <option value="2160">4K</option>
          <option value="1440">1440p</option>
          <option value="1080">1080p</option>
          <option value="720">720p</option>
          <option value="480">480p</option>
          <option value="360">360p</option>
        </select>
        <button class="gv-btn mp3" title="Unduh audio MP3">
          🎵 MP3
        </button>
        <button class="gv-close" title="Sembunyikan ikon ini">&times;</button>
      </div>
    `;

    const state = {
      host,
      dismissed: false,
      updatePos: () => {
        if (state.dismissed || !document.body.contains(video) || document.fullscreenElement) {
          host.style.display = 'none';
          return;
        }

        const rect = video.getBoundingClientRect();
        // Only show on visible, reasonable-sized video players
        if (
          rect.width < 200 ||
          rect.height < 140 ||
          rect.bottom < 20 ||
          rect.top > window.innerHeight - 20 ||
          rect.right < 20 ||
          rect.left > window.innerWidth - 20
        ) {
          host.style.display = 'none';
          return;
        }

        const top = Math.max(8, Math.min(window.innerHeight - 44, rect.top + 12));
        const right = Math.max(12, window.innerWidth - rect.right + 12);
        host.style.top = `${top}px`;
        host.style.right = `${right}px`;
        host.style.left = 'auto';
        host.style.display = 'block';
      }
    };

    const btnMp4 = shadow.querySelector('.gv-btn.mp4');
    const labelMp4 = btnMp4.querySelector('.label');
    const resSelect = shadow.querySelector('.gv-res');
    const btnMp3 = shadow.querySelector('.gv-btn.mp3');
    const btnClose = shadow.querySelector('.gv-close');

    if (resSelect) {
      resSelect.addEventListener('click', (e) => e.stopPropagation());
      resSelect.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    function triggerDownload(format, targetBtn, targetLabel, defaultText) {
      const platform = detectPlatformInfo();
      const selectedRes = (resSelect && format !== 'mp3') ? resSelect.value : 'auto';
      let payloadItem = {};

      if (platform && platform !== 'WAIT') {
        payloadItem = {
          url: platform.url,
          filename: `${platform.title}.${format}`,
          format: format,
          resolution: selectedRes,
          pageTitle: platform.title
        };
      } else {
        const src = video.currentSrc || video.src;
        const cleanTitle = getCleanPageTitle() || 'video';
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
          payloadItem = {
            url: src,
            filename: `${cleanTitle}.${format}`,
            format: format,
            resolution: selectedRes,
            pageTitle: document.title
          };
        } else {
          // Leave url empty so background.js picks best sniffed M3U8/MP4 stream
          payloadItem = {
            url: '',
            filename: `${cleanTitle}.${format}`,
            format: format,
            resolution: selectedRes,
            pageTitle: document.title
          };
        }
      }

      targetLabel.textContent = 'Mengirim...';

      chrome.runtime.sendMessage({
        type: 'TRIGGER_INLINE_DOWNLOAD',
        item: payloadItem
      }, (resp) => {
        if (resp && resp.ok) {
          targetBtn.classList.add('success');
          targetLabel.textContent = 'Terkirim!';
        } else {
          targetBtn.classList.add('error');
          targetLabel.textContent = (resp && resp.error) ? resp.error : 'Gagal!';
        }
        setTimeout(() => {
          targetBtn.classList.remove('success', 'error');
          targetLabel.textContent = defaultText;
        }, 2800);
      });
    }

    btnMp4.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerDownload('mp4', btnMp4, labelMp4, 'Unduh Video');
    });

    btnMp3.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerDownload('mp3', btnMp3, btnMp3, '🎵 MP3');
    });

    btnClose.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.dismissed = true;
      host.style.display = 'none';
    });

    document.documentElement.appendChild(host);
    videoOverlays.set(video, state);
    state.updatePos();
  }

  function updateAllOverlays() {
    document.querySelectorAll('video').forEach(v => {
      const state = videoOverlays.get(v);
      if (state) state.updatePos();
    });
  }

  function scanMedia() {
    const isPlatform = checkSupportedPlatforms();
    const found = [];

    const videos = document.querySelectorAll('video');
    videos.forEach(v => {
      attachOverlayToVideo(v);
      const state = videoOverlays.get(v);
      if (state) state.updatePos();

      if (!isPlatform) {
        const cleanTitle = getCleanPageTitle();
        const src = v.currentSrc || v.src;
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
          const ext = detectExt(src) || 'mp4';
          found.push({
            url: src,
            filename: cleanTitle ? `${cleanTitle}.${ext}` : undefined,
            format: ext
          });
        }

        v.querySelectorAll('source').forEach(s => {
          if (s.src && !s.src.startsWith('blob:') && !s.src.startsWith('data:')) {
            const ext = detectExt(s.src) || (s.type && s.type.includes('webm') ? 'webm' : 'mp4');
            found.push({
              url: s.src,
              filename: cleanTitle ? `${cleanTitle}.${ext}` : undefined,
              format: ext
            });
          }
        });
      }
    });

    if (!isPlatform) {
      const cleanTitle = getCleanPageTitle();
      const audios = document.querySelectorAll('audio');
      audios.forEach(a => {
        const src = a.currentSrc || a.src;
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
          const ext = detectExt(src) || 'mp3';
          found.push({
            url: src,
            filename: cleanTitle ? `${cleanTitle}.${ext}` : undefined,
            format: ext
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
  }

  function detectExt(url) {
    const clean = url.split('?')[0].toLowerCase();
    const match = clean.match(/\.(mp4|webm|m3u8|ts|mp3|m4a|aac|flv|mkv|mov|ogg|wav)$/i);
    return match ? match[1] : null;
  }

  // Initial scan and event listeners
  scanMedia();
  setInterval(updateAllOverlays, 800);
  window.addEventListener('scroll', updateAllOverlays, { passive: true });
  window.addEventListener('resize', updateAllOverlays, { passive: true });
  document.addEventListener('fullscreenchange', updateAllOverlays);

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
