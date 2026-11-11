const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');
const logger = require('./logger');

class DownloadManager {
  constructor(options = {}) {
    this.downloadDir = options.downloadDir || path.join(__dirname, 'downloads');
    this.binDir = path.join(__dirname, 'bin');
    this.ytDlpPath = path.join(this.binDir, 'yt-dlp.exe');
    this.ensureDir(this.downloadDir);
    this.ensureDir(this.binDir);
    this.activeJobs = new Map(); // id -> { controller, abortFn, item, process }
    this.onProgressCallback = null;
    this.onStatusCallback = null;
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  setCallbacks({ onProgress, onStatus }) {
    this.onProgressCallback = onProgress;
    this.onStatusCallback = onStatus;
  }

  notifyProgress(item) {
    if (this.onProgressCallback) {
      this.onProgressCallback(item);
    }
  }

  notifyStatus(item) {
    if (this.onStatusCallback) {
      this.onStatusCallback(item);
    }
  }

  sanitizeFilename(name) {
    return (name || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  isYoutubeUrl(urlStr) {
    if (!urlStr) return false;
    try {
      const host = new URL(urlStr).hostname.toLowerCase();
      return host.includes('youtube.com') || host.includes('youtu.be') || host.includes('googlevideo.com');
    } catch (e) {
      return false;
    }
  }

  detectExtension(urlStr, contentType = '') {
    const cleanUrl = urlStr.split('?')[0].toLowerCase();
    const extMatch = cleanUrl.match(/\.(mp4|webm|mkv|m3u8|ts|mp3|m4a|aac|flv|avi|mov|ogg|wav)/i);
    if (extMatch) return extMatch[1].toLowerCase();

    const mime = contentType.toLowerCase();
    if (mime.includes('video/mp4')) return 'mp4';
    if (mime.includes('video/webm')) return 'webm';
    if (mime.includes('video/quicktime')) return 'mov';
    if (mime.includes('video/x-matroska')) return 'mkv';
    if (mime.includes('application/vnd.apple.mpegurl') || mime.includes('application/x-mpegurl')) return 'm3u8';
    if (mime.includes('video/mp2t')) return 'ts';
    if (mime.includes('audio/mpeg') || mime.includes('audio/mp3')) return 'mp3';
    if (mime.includes('audio/mp4') || mime.includes('audio/m4a')) return 'm4a';
    if (mime.includes('audio/aac')) return 'aac';
    return 'mp4';
  }

  isSocialOrStreamingUrl(item) {
    const urlStr = typeof item === 'string' ? item : item.url;
    try {
      const u = new URL(urlStr);
      const host = u.hostname.toLowerCase();
      const pathname = u.pathname.toLowerCase();

      // Direct CDN fragments should not be routed to yt-dlp directly
      if (pathname.includes('/video/tos/') || host.includes('googlevideo.com')) {
        if (item.pageUrl && this.isSocialPageUrl(item.pageUrl)) {
          return true;
        }
        return false;
      }

      const platforms = [
        'youtube.com', 'youtu.be',
        'tiktok.com',
        'instagram.com',
        'twitter.com', 'x.com',
        'facebook.com', 'fb.watch',
        'vimeo.com',
        'dailymotion.com',
        'bilibili.tv', 'bilibili.com',
        'twitch.tv',
        'reddit.com',
        'pinterest.com',
        'threads.net',
        'rumble.com',
        'soundcloud.com',
        'streamable.com',
        'vk.com'
      ];
      return platforms.some(p => host.includes(p));
    } catch (e) {
      return false;
    }
  }

  isSocialPageUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const host = u.hostname.toLowerCase();
      const pathname = u.pathname.toLowerCase();

      if (host.includes('tiktok.com')) {
        return /\/(?:video|photo)\/\d+/i.test(pathname);
      }
      if (host.includes('instagram.com')) {
        return /^\/(?:reel|reels|p|tv)\//i.test(pathname);
      }
      if (host.includes('youtube.com')) {
        return (pathname === '/watch' && u.searchParams.has('v')) || /^\/(?:shorts|live|embed)\//i.test(pathname);
      }
      if (host.includes('youtu.be')) {
        return pathname.length > 1;
      }
      if (host.includes('twitter.com') || host.includes('x.com')) {
        return /\/status\/\d+/i.test(pathname);
      }
      if (host.includes('bilibili.tv')) {
        return /\/play\/\d+/i.test(pathname);
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async start(item) {
    if (this.activeJobs.has(item.id)) {
      logger.warn('JOB', `Job ${item.id} (${item.filename}) sudah berjalan.`);
      return;
    }

    item.status = 'downloading';
    item.error = null;
    this.notifyStatus(item);

    logger.info('START', `Memulai unduhan: ${item.filename}`, {
      id: item.id,
      format: item.format,
      pageUrl: item.pageUrl || '(tidak ada)',
      url: item.url
    });

    // Check if it's YouTube / Social URL and yt-dlp is available
    if (this.isSocialOrStreamingUrl(item) && fs.existsSync(this.ytDlpPath)) {
      logger.info('ROUTER', `Menggunakan engine YT-DLP untuk ${item.filename}`);
      return this.startYtDlpDownload(item);
    }

    const isM3U8 = item.url.includes('.m3u8') || (item.format && item.format.toLowerCase() === 'm3u8');
    if (isM3U8) {
      logger.info('ROUTER', `Menggunakan engine M3U8 HLS untuk ${item.filename}`);
      return this.startM3U8Download(item);
    } else {
      logger.info('ROUTER', `Menggunakan engine Direct HTTP untuk ${item.filename}`);
      return this.startDirectDownload(item);
    }
  }

  // --- YT-DLP DOWNLOADER FOR YOUTUBE & SOCIAL MEDIA ---
  startYtDlpDownload(item, options = {}) {
    const forceDirectUrl = Boolean(options.forceDirectUrl);
    let isAborted = false;

    const abortFn = () => {
      isAborted = true;
      if (proc && !proc.killed) {
        try {
          proc.kill('SIGINT');
        } catch (e) {}
      }
    };

    const hasFFmpeg = fs.existsSync(path.join(this.binDir, 'ffmpeg.exe'));
    const isYoutube = this.isYoutubeUrl(item.url) || this.isYoutubeUrl(item.pageUrl);
    const usePageTitleTemplate = !isYoutube && (forceDirectUrl || Boolean(item.hasPageTitle));
    const rawBase = path.basename(item.filePath || item.filename || 'video', path.extname(item.filePath || item.filename || 'video'));
    const safeBase = this.sanitizeFilename(rawBase).replace(/%/g, '_').slice(0, 140).trim() || 'video';
    const outTemplate = usePageTitleTemplate
      ? path.join(this.downloadDir, `${safeBase}.%(ext)s`)
      : path.join(this.downloadDir, '%(title)s.%(ext)s');
    const args = [
      '--newline',
      '--no-playlist',
      '--no-colors',
      '--js-runtimes', `node:${process.execPath}`,
      '--concurrent-fragments', '5',
      '-o', outTemplate
    ];

    const referer = (item.headers && (item.headers.Referer || item.headers.referer)) || item.pageUrl;
    if (forceDirectUrl && referer) {
      args.push('--referer', referer);
    }

    if (hasFFmpeg) {
      args.push('--ffmpeg-location', this.binDir);
      if (item.format === 'mp3') {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
      } else {
        // Prioritize universal H.264 (avc1) + AAC (mp4a) for 100% Windows/Phone compatibility
        args.push('-S', 'res,vcodec:h264,acodec:m4a');
        args.push('-f', 'bv*+ba/b');
        args.push('--merge-output-format', 'mp4');
        args.push('--postprocessor-args', 'Merger+ffmpeg:-c:v copy -c:a aac -b:a 192k');
      }
    } else {
      // Fallback if FFmpeg is absent: download single pre-merged stream (video + audio together)
      if (item.format === 'mp3') {
        args.push('-f', 'ba[ext=m4a]/ba/bestaudio');
      } else {
        args.push('-f', 'b[ext=mp4]/b/best[ext=mp4]/best');
      }
    }

    const targetUrl = (!forceDirectUrl && item.pageUrl && this.isSocialPageUrl(item.pageUrl))
      ? item.pageUrl
      : item.url;

    // Special Bilibili.tv options: embed Indonesian & English subtitles and handle VIP series errors gracefully
    if (targetUrl.includes('bilibili.tv')) {
      args.push('--ignore-errors');
      if (hasFFmpeg && item.format !== 'mp3') {
        args.push('--write-subs', '--sub-langs', 'id,en', '--sub-format', 'srt', '--embed-subs');
      }
    }

    args.push(targetUrl);

    logger.info('YT-DLP CMD', `yt-dlp.exe ${args.join(' ')}`);

    const proc = spawn(this.ytDlpPath, args, { windowsHide: true });
    this.activeJobs.set(item.id, { abortFn, item, process: proc });

    let finalFilePath = item.filePath;
    let stderrMessages = [];

    proc.stdout.on('data', (chunk) => {
      if (isAborted) return;
      const text = chunk.toString();
      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (!line.trim()) continue;

        if (!line.includes('[download]') || !line.includes('%')) {
          logger.debug('YT-DLP OUT', line.trim());
        }

        // Check destination file name
        const destMatch = line.match(/Destination:\s*(.+)$/i) || line.match(/Merging formats into "(.+)"/i) || line.match(/\[download\]\s*(.+?)\s+has already been downloaded/i);
        if (destMatch) {
          finalFilePath = destMatch[1].trim();
          item.filePath = finalFilePath;
          item.filename = path.basename(finalFilePath);
        }

        // Parse progress line: [download]  45.2% of 15.00MiB at 3.20MiB/s ETA 00:03
        if (line.includes('[download]') && line.includes('%')) {
          const pctMatch = line.match(/(\d+(?:\.\d+)?)%/);
          if (pctMatch) {
            const pct = parseFloat(pctMatch[1]);
            item.totalBytes = 100;
            item.downloadedBytes = Math.min(100, Math.round(pct));
          }

          // Speed
          const speedMatch = line.match(/at\s+([\d.]+[KMGTP]i?B\/s)/i);
          if (speedMatch) {
            item.speedStr = speedMatch[1];
            item.speed = this.parseSpeedToBytes(speedMatch[1]);
          }

          // ETA
          const etaMatch = line.match(/ETA\s+(\d+:\d+(?::\d+)?)/i);
          if (etaMatch) {
            item.etaStr = etaMatch[1];
            item.eta = this.parseEtaToSeconds(etaMatch[1]);
          }

          this.notifyProgress(item);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const errText = chunk.toString().trim();
      if (errText) {
        stderrMessages.push(errText);
        logger.warn('YT-DLP STDERR', errText);
      }
    });

    proc.on('close', (code) => {
      this.activeJobs.delete(item.id);
      if (isAborted) {
        logger.warn('YT-DLP ABORT', `Proses dihentikan oleh user: ${item.filename}`);
        return;
      }

      if (code === 0) {
        logger.ok('YT-DLP DONE', `Berhasil diunduh: ${item.filename}`);
        item.status = 'completed';
        item.downloadedBytes = 100;
        item.totalBytes = 100;
        item.speed = 0;
        item.eta = 0;
        this.notifyStatus(item);
      } else {
        const lastReason = stderrMessages.slice(-2).join(' | ') || `yt-dlp exited with code ${code}`;
        logger.error('YT-DLP FAIL', `Gagal download (Exit Code: ${code}) untuk ${item.filename}`, lastReason);
        item.status = 'error';
        item.error = lastReason.length > 160 ? lastReason.slice(0, 160) + '...' : lastReason;
        item.speed = 0;
        this.notifyStatus(item);
      }
    });

    proc.on('error', (err) => {
      this.activeJobs.delete(item.id);
      if (isAborted) return;
      logger.error('YT-DLP SPAWN ERR', `Gagal menjalankan yt-dlp: ${err.message}`);
      item.status = 'error';
      item.error = err.message;
      item.speed = 0;
      this.notifyStatus(item);
    });
  }

  parseSpeedToBytes(str) {
    const match = str.match(/([\d.]+)\s*([KMGTP]i?B)\/s/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit.startsWith('K')) return Math.round(val * 1024);
    if (unit.startsWith('M')) return Math.round(val * 1024 * 1024);
    if (unit.startsWith('G')) return Math.round(val * 1024 * 1024 * 1024);
    return Math.round(val);
  }

  parseEtaToSeconds(str) {
    const parts = str.split(':').map(Number);
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return null;
  }

  // --- DIRECT FILE DOWNLOAD (MP4, WEBM, MP3, etc.) ---
  async startDirectDownload(item) {
    let clientReq = null;
    let writeStream = null;
    let isAborted = false;

    const filePath = item.filePath || path.join(this.downloadDir, item.filename);
    item.filePath = filePath;

    let existingBytes = 0;
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      existingBytes = stats.size;
    }

    const abortFn = () => {
      isAborted = true;
      if (clientReq) clientReq.destroy();
      if (writeStream) writeStream.end();
    };

    this.activeJobs.set(item.id, { abortFn, item });

    try {
      const parsedUrl = new URL(item.url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const headers = {
        'User-Agent': (item.headers && item.headers['User-Agent']) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': (item.headers && item.headers['Referer']) || item.pageUrl || (parsedUrl.origin + '/')
      };

      if (existingBytes > 0) {
        headers['Range'] = `bytes=${existingBytes}-`;
      }

      const reqOptions = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers
      };

      logger.info('HTTP REQ', `GET ${parsedUrl.hostname}${parsedUrl.pathname}`, {
        referer: headers['Referer'],
        range: headers['Range'] || 'Full File'
      });

      clientReq = client.request(reqOptions, (res) => {
        logger.info('HTTP RES', `Status ${res.statusCode} ${res.statusMessage || ''}`, {
          contentType: res.headers['content-type'] || '-',
          contentLength: res.headers['content-length'] || '-',
          acceptRanges: res.headers['accept-ranges'] || '-'
        });

        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          logger.info('HTTP REDIRECT', `Redirect ke: ${res.headers.location}`);
          this.activeJobs.delete(item.id);
          const redirectUrl = new URL(res.headers.location, item.url).href;
          item.url = redirectUrl;
          return this.startDirectDownload(item);
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          let errBody = '';
          res.on('data', chunk => {
            if (errBody.length < 500) errBody += chunk.toString();
          });
          res.on('end', () => {
            logger.error('HTTP FAIL', `Download gagal HTTP ${res.statusCode} untuk ${item.filename}`, {
              status: res.statusCode,
              statusMessage: res.statusMessage,
              referer: headers['Referer'],
              server: res.headers['server'] || '-',
              bodySnippet: errBody.trim() || '(kosong)'
            });
            this.activeJobs.delete(item.id);
            item.status = 'error';
            item.error = `HTTP ${res.statusCode} (${res.statusMessage || 'Akses ditolak / link kedaluwarsa'})`;
            item.speed = 0;
            this.notifyStatus(item);
          });
          return;
        }

        const isRangeSupported = res.statusCode === 206;
        let totalSize = item.totalBytes || 0;

        if (res.headers['content-length']) {
          const streamLen = parseInt(res.headers['content-length'], 10);
          if (isRangeSupported) {
            totalSize = existingBytes + streamLen;
          } else {
            totalSize = streamLen;
            existingBytes = 0;
          }
        } else if (res.headers['content-range']) {
          const match = res.headers['content-range'].match(/\/(\d+)/);
          if (match) {
            totalSize = parseInt(match[1], 10);
          }
        }

        item.totalBytes = totalSize;
        item.downloadedBytes = existingBytes;

        const flags = isRangeSupported && existingBytes > 0 ? 'a' : 'w';
        writeStream = fs.createWriteStream(filePath, { flags });

        let lastTime = Date.now();
        let bytesSinceLast = 0;

        res.on('data', (chunk) => {
          if (isAborted) return;
          writeStream.write(chunk);
          item.downloadedBytes += chunk.length;
          bytesSinceLast += chunk.length;

          const now = Date.now();
          const diff = now - lastTime;
          if (diff >= 500) {
            item.speed = Math.round((bytesSinceLast / diff) * 1000);
            if (item.totalBytes > 0 && item.speed > 0) {
              const remaining = item.totalBytes - item.downloadedBytes;
              item.eta = Math.max(0, Math.round(remaining / item.speed));
            } else {
              item.eta = null;
            }
            bytesSinceLast = 0;
            lastTime = now;
            this.notifyProgress(item);
          }
        });

        res.on('end', () => {
          writeStream.end();
        });

        writeStream.on('finish', () => {
          if (!isAborted) {
            this.activeJobs.delete(item.id);
            item.status = 'completed';
            item.speed = 0;
            item.eta = 0;
            if (item.totalBytes === 0) {
              item.totalBytes = item.downloadedBytes;
            }
            logger.ok('HTTP DONE', `Download selesai: ${item.filename} (${item.downloadedBytes} bytes)`);
            this.notifyStatus(item);
          }
        });

        writeStream.on('error', (err) => {
          if (!isAborted) {
            logger.error('DISK ERR', `Gagal menulis file ${item.filename}: ${err.message}`);
            this.activeJobs.delete(item.id);
            item.status = 'error';
            item.error = err.message;
            item.speed = 0;
            this.notifyStatus(item);
          }
        });
      });

      clientReq.on('error', (err) => {
        if (!isAborted) {
          logger.error('NET ERR', `Koneksi gagal untuk ${item.filename}: [${err.code || 'ERR'}] ${err.message}`);
          this.activeJobs.delete(item.id);
          item.status = 'error';
          item.error = err.message;
          item.speed = 0;
          this.notifyStatus(item);
        }
      });

      clientReq.end();
    } catch (err) {
      if (!isAborted) {
        logger.error('HTTP EXCEPT', `Kesalahan eksekusi untuk ${item.filename}: ${err.message}`);
        this.activeJobs.delete(item.id);
        item.status = 'error';
        item.error = err.message;
        item.speed = 0;
        this.notifyStatus(item);
      }
    }
  }

  // --- HLS / M3U8 STREAM DOWNLOADER (AUTO-CONVERT TO MP4) ---
  async startM3U8Download(item) {
    let isAborted = false;
    let currentReq = null;
    const ffmpegPath = path.join(this.binDir, 'ffmpeg.exe');
    const hasFFmpeg = fs.existsSync(ffmpegPath);

    const abortFn = () => {
      isAborted = true;
      if (currentReq) currentReq.destroy();
    };

    this.activeJobs.set(item.id, { abortFn, item });

    try {
      // Determine final filename (.mp4 if FFmpeg is present, otherwise .ts)
      const targetExt = hasFFmpeg ? '.mp4' : '.ts';
      item.filename = item.filename.replace(/\.(m3u8|ts)$/i, '') + targetExt;
      if (!item.filename.toLowerCase().endsWith(targetExt)) {
        item.filename += targetExt;
      }

      const finalFilePath = path.join(this.downloadDir, item.filename);
      const tempTsPath = hasFFmpeg ? finalFilePath.replace(/\.mp4$/i, '.part.ts') : finalFilePath;
      item.filePath = finalFilePath;

      logger.info('M3U8', `Mengambil playlist M3U8: ${item.url}`);
      const playlistText = await this.fetchText(item.url);
      let targetPlaylistUrl = item.url;

      if (playlistText.includes('#EXT-X-STREAM-INF')) {
        const lines = playlistText.split('\n');
        let highestBandwidth = -1;
        let highestUri = '';

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#EXT-X-STREAM-INF')) {
            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            const nextLine = (lines[i + 1] || '').trim();
            if (nextLine && !nextLine.startsWith('#') && bw >= highestBandwidth) {
              highestBandwidth = bw;
              highestUri = nextLine;
            }
          }
        }

        if (highestUri) {
          targetPlaylistUrl = new URL(highestUri, item.url).href;
          logger.info('M3U8 MASTER', `Memilih resolusi tertinggi (Bandwidth: ${highestBandwidth}): ${targetPlaylistUrl}`);
        }
      }

      const mediaPlaylistText = targetPlaylistUrl === item.url ? playlistText : await this.fetchText(targetPlaylistUrl);

      // If AES-128 encrypted or fMP4 (#EXT-X-MAP), delegate to yt-dlp for decryption + MP4 muxing
      if ((mediaPlaylistText.includes('#EXT-X-KEY') || mediaPlaylistText.includes('#EXT-X-MAP')) && fs.existsSync(this.ytDlpPath)) {
        logger.info('M3U8 ENCRYPTED', `Playlist terenkripsi/fMP4 terdeteksi, mengalihkan ke engine YT-DLP -> MP4`);
        this.activeJobs.delete(item.id);
        return this.startYtDlpDownload(item, { forceDirectUrl: true });
      }

      const mediaLines = mediaPlaylistText.split('\n');
      const segmentUrls = [];

      for (const rawLine of mediaLines) {
        const line = rawLine.trim();
        if (line && !line.startsWith('#')) {
          segmentUrls.push(new URL(line, targetPlaylistUrl).href);
        }
      }

      if (segmentUrls.length === 0) {
        throw new Error('Tidak ada segmen video ditemukan di playlist M3U8.');
      }

      logger.info('M3U8 SEGMENTS', `Ditemukan ${segmentUrls.length} segmen TS. Memulai unduhan 4x paralel...`);

      item.totalSegments = segmentUrls.length;
      if (!item.downloadedSegments) item.downloadedSegments = 0;
      item.totalBytes = segmentUrls.length;
      item.downloadedBytes = item.downloadedSegments;

      const writeStream = fs.createWriteStream(tempTsPath, {
        flags: item.downloadedSegments > 0 ? 'a' : 'w'
      });

      let lastTime = Date.now();
      let segsSinceLast = 0;

      const downloadSingleSegment = (segUrl) => {
        return new Promise((resolve, reject) => {
          const parsed = new URL(segUrl);
          const client = parsed.protocol === 'https:' ? https : http;
          const req = client.get(segUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': (item.headers && item.headers['Referer']) || targetPlaylistUrl
            }
          }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
              return this.fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
              return reject(new Error(`Segment error: ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          });
          currentReq = req;
          req.on('error', reject);
        });
      };

      const CONCURRENCY = 4; // 4x parallel segment download
      for (let i = item.downloadedSegments; i < segmentUrls.length; i += CONCURRENCY) {
        if (isAborted) {
          writeStream.end();
          return;
        }

        const batchUrls = [];
        for (let j = i; j < Math.min(i + CONCURRENCY, segmentUrls.length); j++) {
          batchUrls.push(segmentUrls[j]);
        }

        const buffers = await Promise.all(batchUrls.map(u => downloadSingleSegment(u)));

        if (isAborted) {
          writeStream.end();
          return;
        }

        for (const buf of buffers) {
          writeStream.write(buf);
        }

        item.downloadedSegments = Math.min(i + CONCURRENCY, segmentUrls.length);
        item.downloadedBytes = item.downloadedSegments;
        segsSinceLast += batchUrls.length;

        const now = Date.now();
        const diff = now - lastTime;
        if (diff >= 500 || item.downloadedSegments >= segmentUrls.length) {
          item.speed = Math.round((segsSinceLast / (diff / 1000)));
          const remSegs = segmentUrls.length - item.downloadedSegments;
          item.eta = item.speed > 0 ? Math.round(remSegs / item.speed) : null;
          segsSinceLast = 0;
          lastTime = now;
          this.notifyProgress(item);
        }
      }

      // Flush and close temporary TS file before remuxing
      await new Promise((resolve) => writeStream.end(resolve));

      if (hasFFmpeg && fs.existsSync(tempTsPath)) {
        logger.info('M3U8 CONVERT', `Mengonversi stream TS ke MP4 menggunakan FFmpeg...`);
        const converted = await this.convertTsToMp4(ffmpegPath, tempTsPath, finalFilePath);
        if (converted) {
          try { fs.unlinkSync(tempTsPath); } catch (e) {}
          item.format = 'mp4';
          logger.ok('M3U8 DONE', `Konversi selesai! File MP4 siap diputar: ${item.filename}`);
        } else {
          // Fallback: keep TS file if remux failed
          const fallbackTs = finalFilePath.replace(/\.mp4$/i, '.ts');
          try { fs.renameSync(tempTsPath, fallbackTs); } catch (e) {}
          item.filePath = fallbackTs;
          item.filename = path.basename(fallbackTs);
          logger.warn('M3U8 WARN', `Konversi MP4 gagal, disimpan sebagai TS: ${item.filename}`);
        }
      } else {
        logger.ok('M3U8 DONE', `Stream selesai digabung: ${item.filename}`);
      }

      this.activeJobs.delete(item.id);
      item.status = 'completed';
      item.speed = 0;
      item.eta = 0;
      this.notifyStatus(item);

    } catch (err) {
      if (!isAborted) {
        logger.error('M3U8 FAIL', `Gagal mengunduh stream M3U8 ${item.filename}: ${err.message}`);
        this.activeJobs.delete(item.id);
        item.status = 'error';
        item.error = err.message;
        item.speed = 0;
        this.notifyStatus(item);
      }
    }
  }

  convertTsToMp4(ffmpegPath, tsPath, mp4Path) {
    return new Promise((resolve) => {
      // Fast lossless remux (-c copy -bsf:a aac_adtstoasc)
      const proc = spawn(ffmpegPath, [
        '-y',
        '-i', tsPath,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        mp4Path
      ], { windowsHide: true });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(mp4Path)) {
          return resolve(true);
        }

        // Fallback if audio is MP3 or non-ADTS AAC: copy video, transcode audio to AAC
        logger.warn('FFMPEG RETRY', 'Mencoba konversi ulang dengan encoding audio AAC...');
        const proc2 = spawn(ffmpegPath, [
          '-y',
          '-i', tsPath,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          mp4Path
        ], { windowsHide: true });

        proc2.on('close', (code2) => {
          resolve(code2 === 0 && fs.existsSync(mp4Path));
        });
        proc2.on('error', () => resolve(false));
      });

      proc.on('error', () => resolve(false));
    });
  }

  fetchText(urlStr) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const client = parsed.protocol === 'https:' ? https : http;
      client.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          return this.fetchText(new URL(res.headers.location, urlStr).href).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to load URL: ${res.statusCode}`));
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  fetchBuffer(urlStr) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const client = parsed.protocol === 'https:' ? https : http;
      client.get(urlStr, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  pause(item) {
    const job = this.activeJobs.get(item.id);
    if (job) {
      job.abortFn();
      this.activeJobs.delete(item.id);
    }
    item.status = 'paused';
    item.speed = 0;
    item.eta = null;
    this.notifyStatus(item);
  }

  cancel(item) {
    const job = this.activeJobs.get(item.id);
    if (job) {
      job.abortFn();
      this.activeJobs.delete(item.id);
    }
    item.status = 'cancelled';
    item.speed = 0;
    item.eta = null;
    this.notifyStatus(item);
  }

  delete(item, deletePhysicalFile = false) {
    this.cancel(item);
    if (deletePhysicalFile && item.filePath && fs.existsSync(item.filePath)) {
      try {
        fs.unlinkSync(item.filePath);
      } catch (err) {
        console.error('Error deleting physical file:', err);
      }
    }
  }
}

module.exports = DownloadManager;
