const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');

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
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
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

  isSocialOrStreamingUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const host = u.hostname.toLowerCase();
      return (
        host.includes('youtube.com') ||
        host.includes('youtu.be') ||
        host.includes('tiktok.com') ||
        host.includes('instagram.com') ||
        host.includes('twitter.com') ||
        host.includes('x.com') ||
        host.includes('facebook.com') ||
        host.includes('fb.watch') ||
        host.includes('vimeo.com')
      );
    } catch (e) {
      return false;
    }
  }

  async start(item) {
    if (this.activeJobs.has(item.id)) {
      console.log(`Job ${item.id} already active.`);
      return;
    }

    item.status = 'downloading';
    item.error = null;
    this.notifyStatus(item);

    // Check if it's YouTube / Social URL and yt-dlp is available
    if (this.isSocialOrStreamingUrl(item.url) && fs.existsSync(this.ytDlpPath)) {
      return this.startYtDlpDownload(item);
    }

    const isM3U8 = item.url.includes('.m3u8') || (item.format && item.format.toLowerCase() === 'm3u8');
    if (isM3U8) {
      return this.startM3U8Download(item);
    } else {
      return this.startDirectDownload(item);
    }
  }

  // --- YT-DLP DOWNLOADER FOR YOUTUBE & SOCIAL MEDIA ---
  startYtDlpDownload(item) {
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
    const outTemplate = path.join(this.downloadDir, '%(title)s.%(ext)s');
    const args = [
      '--newline',
      '--no-playlist',
      '--no-colors',
      '-o', outTemplate
    ];

    if (hasFFmpeg) {
      args.push('--ffmpeg-location', this.binDir);
      if (item.format === 'mp3') {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
      } else {
        // Best video + audio merged cleanly into a single MP4 container
        args.push('-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b');
        args.push('--merge-output-format', 'mp4');
      }
    } else {
      // Fallback if FFmpeg is absent: download single pre-merged stream (video + audio together)
      if (item.format === 'mp3') {
        args.push('-f', 'ba[ext=m4a]/ba/bestaudio');
      } else {
        args.push('-f', 'b[ext=mp4]/b/best[ext=mp4]/best');
      }
    }

    args.push(item.url);

    const proc = spawn(this.ytDlpPath, args, { windowsHide: true });
    this.activeJobs.set(item.id, { abortFn, item, process: proc });

    let finalFilePath = item.filePath;

    proc.stdout.on('data', (chunk) => {
      if (isAborted) return;
      const text = chunk.toString();
      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (!line.trim()) continue;

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
      console.warn(`yt-dlp [${item.id}]:`, chunk.toString().trim());
    });

    proc.on('close', (code) => {
      this.activeJobs.delete(item.id);
      if (isAborted) return;

      if (code === 0) {
        item.status = 'completed';
        item.downloadedBytes = 100;
        item.totalBytes = 100;
        item.speed = 0;
        item.eta = 0;
        this.notifyStatus(item);
      } else {
        item.status = 'error';
        item.error = `yt-dlp exited with code ${code}`;
        item.speed = 0;
        this.notifyStatus(item);
      }
    });

    proc.on('error', (err) => {
      this.activeJobs.delete(item.id);
      if (isAborted) return;
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': parsedUrl.origin + '/'
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

      clientReq = client.request(reqOptions, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          this.activeJobs.delete(item.id);
          const redirectUrl = new URL(res.headers.location, item.url).href;
          item.url = redirectUrl;
          return this.startDirectDownload(item);
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          throw new Error(`Server returned status code: ${res.statusCode} ${res.statusMessage || ''}`);
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
            this.notifyStatus(item);
          }
        });

        writeStream.on('error', (err) => {
          if (!isAborted) {
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
        this.activeJobs.delete(item.id);
        item.status = 'error';
        item.error = err.message;
        item.speed = 0;
        this.notifyStatus(item);
      }
    }
  }

  // --- HLS / M3U8 STREAM DOWNLOADER ---
  async startM3U8Download(item) {
    let isAborted = false;
    let currentReq = null;

    const abortFn = () => {
      isAborted = true;
      if (currentReq) currentReq.destroy();
    };

    this.activeJobs.set(item.id, { abortFn, item });

    try {
      let ext = path.extname(item.filename);
      if (!ext || ext.toLowerCase() === '.m3u8') {
        item.filename = item.filename.replace(/\.m3u8$/i, '') + '.ts';
      }
      const filePath = item.filePath || path.join(this.downloadDir, item.filename);
      item.filePath = filePath;

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
        }
      }

      const mediaPlaylistText = targetPlaylistUrl === item.url ? playlistText : await this.fetchText(targetPlaylistUrl);
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

      item.totalSegments = segmentUrls.length;
      if (!item.downloadedSegments) item.downloadedSegments = 0;
      item.totalBytes = segmentUrls.length;
      item.downloadedBytes = item.downloadedSegments;

      const writeStream = fs.createWriteStream(filePath, {
        flags: item.downloadedSegments > 0 ? 'a' : 'w'
      });

      let lastTime = Date.now();
      let segsSinceLast = 0;

      for (let i = item.downloadedSegments; i < segmentUrls.length; i++) {
        if (isAborted) {
          writeStream.end();
          return;
        }

        const segUrl = segmentUrls[i];
        const segBuf = await new Promise((resolve, reject) => {
          const parsed = new URL(segUrl);
          const client = parsed.protocol === 'https:' ? https : http;
          const req = client.get(segUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': targetPlaylistUrl
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

        if (isAborted) {
          writeStream.end();
          return;
        }

        writeStream.write(segBuf);
        item.downloadedSegments = i + 1;
        item.downloadedBytes = item.downloadedSegments;
        segsSinceLast++;

        const now = Date.now();
        const diff = now - lastTime;
        if (diff >= 500 || i === segmentUrls.length - 1) {
          item.speed = Math.round((segsSinceLast / (diff / 1000)));
          const remSegs = segmentUrls.length - (i + 1);
          item.eta = item.speed > 0 ? Math.round(remSegs / item.speed) : null;
          segsSinceLast = 0;
          lastTime = now;
          this.notifyProgress(item);
        }
      }

      writeStream.end();
      this.activeJobs.delete(item.id);
      item.status = 'completed';
      item.speed = 0;
      item.eta = 0;
      this.notifyStatus(item);

    } catch (err) {
      if (!isAborted) {
        this.activeJobs.delete(item.id);
        item.status = 'error';
        item.error = err.message;
        item.speed = 0;
        this.notifyStatus(item);
      }
    }
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
