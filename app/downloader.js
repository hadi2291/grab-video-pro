const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

class DownloadManager {
  constructor(options = {}) {
    this.downloadDir = options.downloadDir || path.join(__dirname, 'downloads');
    this.ensureDir(this.downloadDir);
    this.activeJobs = new Map(); // id -> { controller, abortFn, item }
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

  async start(item) {
    if (this.activeJobs.has(item.id)) {
      console.log(`Job ${item.id} already active.`);
      return;
    }

    item.status = 'downloading';
    item.error = null;
    this.notifyStatus(item);

    const isM3U8 = item.url.includes('.m3u8') || (item.format && item.format.toLowerCase() === 'm3u8');

    if (isM3U8) {
      return this.startM3U8Download(item);
    } else {
      return this.startDirectDownload(item);
    }
  }

  // --- DIRECT FILE DOWNLOAD (MP4, WEBM, MP3, etc.) ---
  async startDirectDownload(item) {
    let clientReq = null;
    let writeStream = null;
    let isAborted = false;

    const filePath = item.filePath || path.join(this.downloadDir, item.filename);
    item.filePath = filePath;

    // Check existing downloaded bytes if resuming
    let existingBytes = 0;
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      existingBytes = stats.size;
    }

    // Set up abort controller
    const abortFn = () => {
      isAborted = true;
      if (clientReq) {
        clientReq.destroy();
      }
      if (writeStream) {
        writeStream.end();
      }
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
        // Handle HTTP Redirects
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
            existingBytes = 0; // server doesn't support range, restart from 0
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
            // Speed in bytes/sec
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
      if (currentReq) {
        currentReq.destroy();
      }
    };

    this.activeJobs.set(item.id, { abortFn, item });

    try {
      let ext = path.extname(item.filename);
      if (!ext || ext.toLowerCase() === '.m3u8') {
        item.filename = item.filename.replace(/\.m3u8$/i, '') + '.ts';
      }
      const filePath = item.filePath || path.join(this.downloadDir, item.filename);
      item.filePath = filePath;

      // 1. Fetch playlist
      const playlistText = await this.fetchText(item.url);
      let targetPlaylistUrl = item.url;

      // Check if it's a master playlist
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

      // Fetch the actual media playlist
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
      item.totalBytes = segmentUrls.length; // use segments as relative metric
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
          item.speed = Math.round((segsSinceLast / (diff / 1000))); // segments per sec
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
