const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const storage = require('./storage');
const DownloadManager = require('./downloader');
const logger = require('./logger');

// Global Crash Guards
process.on('uncaughtException', (err) => {
  logger.error('CRASH GUARD', 'Uncaught Exception: ' + (err.message || err), err.stack);
});

process.on('unhandledRejection', (reason) => {
  logger.error('CRASH GUARD', 'Unhandled Rejection', String(reason));
});

const PORT = 54321;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

const downloader = new DownloadManager({ downloadDir: DOWNLOADS_DIR });

// List of SSE connected clients
const sseClients = new Set();

function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

downloader.setCallbacks({
  onProgress: (item) => {
    storage.update(item.id, {
      downloadedBytes: item.downloadedBytes,
      totalBytes: item.totalBytes,
      speed: item.speed,
      eta: item.eta,
      downloadedSegments: item.downloadedSegments,
      totalSegments: item.totalSegments
    });
    broadcastEvent('progress', item);
  },
  onStatus: (item) => {
    storage.update(item.id, {
      status: item.status,
      filename: item.filename,
      format: item.format,
      speed: item.speed,
      eta: item.eta,
      error: item.error,
      filePath: item.filePath,
      totalBytes: item.totalBytes,
      downloadedBytes: item.downloadedBytes
    });
    broadcastEvent('status', item);
  }
});

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname) {
  let safePath = pathname === '/' ? '/index.html' : pathname;
  let fullPath = path.join(PUBLIC_DIR, safePath);

  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    fullPath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(fullPath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(fullPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // Handle CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  // SSE Stream
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('\n');
    sseClients.add(res);

    res.on('error', () => {
      sseClients.delete(res);
    });

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // API: Health / Ping
  if (req.method === 'GET' && pathname === '/api/status') {
    return sendJson(res, 200, {
      online: true,
      version: '1.0.0',
      activeDownloads: downloader.activeJobs.size,
      downloadDir: DOWNLOADS_DIR
    });
  }

  // API: Open downloads directory
  if (req.method === 'POST' && pathname === '/api/downloads/dir/open-folder') {
    exec(`explorer.exe "${DOWNLOADS_DIR}"`);
    return sendJson(res, 200, { success: true });
  }

  // API: Inspect available video resolutions for URL
  if (req.method === 'GET' && pathname === '/api/formats') {
    const targetUrl = (reqUrl.searchParams.get('url') || '').trim();
    if (!targetUrl) {
      return sendJson(res, 400, { error: 'Parameter url diperlukan.' });
    }
    const resolutions = await downloader.getAvailableResolutions(targetUrl);
    return sendJson(res, 200, { url: targetUrl, resolutions });
  }

  // API: Get all downloads
  if (req.method === 'GET' && pathname === '/api/downloads') {
    return sendJson(res, 200, storage.getAll());
  }

  // API: Create new download
  if (req.method === 'POST' && pathname === '/api/downloads') {
    const body = await parseBody(req);
    const url = (body.url || '').trim();

    if (!url) {
      return sendJson(res, 400, { error: 'URL video diperlukan.' });
    }

    let detectedFormat = downloader.detectExtension(url);
    if (body.format) {
      detectedFormat = body.format.toLowerCase();
    }

    const targetExt = detectedFormat === 'm3u8' ? 'mp4' : detectedFormat;
    const isYoutube = downloader.isYoutubeUrl(url) || downloader.isYoutubeUrl(body.pageUrl);
    const rawPageTitle = typeof body.pageTitle === 'string' ? body.pageTitle.trim() : '';
    const isValidPageTitle = Boolean(
      rawPageTitle &&
      rawPageTitle.length >= 2 &&
      !/^https?:\/\//i.test(rawPageTitle) &&
      rawPageTitle.toLowerCase() !== 'new tab'
    );

    let cleanFilename = '';
    if (!isYoutube && isValidPageTitle) {
      const strippedTitle = downloader.sanitizeFilename(rawPageTitle)
        .replace(/\.(mp4|webm|mkv|m3u8|ts|mp3|m4a|aac|flv|avi|mov|ogg|wav)$/i, '')
        .slice(0, 120)
        .trim();
      if (strippedTitle.length >= 2) {
        cleanFilename = `${strippedTitle}.${targetExt}`;
      }
    }

    if (!cleanFilename && body.filename) {
      cleanFilename = downloader.sanitizeFilename(body.filename);
    }
    if (!cleanFilename) {
      try {
        const u = new URL(url);
        const base = path.basename(u.pathname);
        if (base && base.length > 2) {
          cleanFilename = downloader.sanitizeFilename(base);
        }
      } catch (e) {}
    }

    if (!cleanFilename || cleanFilename.length < 3) {
      cleanFilename = `video_${Date.now()}.${targetExt}`;
    }

    if (!/\.(mp4|webm|mkv|m3u8|ts|mp3|m4a|aac|flv|avi|mov|ogg|wav)$/i.test(cleanFilename)) {
      cleanFilename += `.${targetExt}`;
    }

    const extPart = path.extname(cleanFilename);
    const basePart = cleanFilename.slice(0, cleanFilename.length - extPart.length);
    const activeNames = new Set(
      storage.getAll()
        .filter(d => d.status !== 'error' && d.status !== 'cancelled')
        .map(d => d.filename)
    );
    let uniqueFilename = cleanFilename;
    let suffix = 2;
    while (fs.existsSync(path.join(DOWNLOADS_DIR, uniqueFilename)) || activeNames.has(uniqueFilename)) {
      uniqueFilename = `${basePart} (${suffix})${extPart}`;
      suffix++;
    }
    cleanFilename = uniqueFilename;

    const item = {
      id: crypto.randomUUID(),
      url,
      filename: cleanFilename,
      format: detectedFormat,
      resolution: typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : 'auto',
      pageTitle: isValidPageTitle ? rawPageTitle : cleanFilename,
      hasPageTitle: isValidPageTitle,
      pageUrl: body.pageUrl || '',
      headers: body.headers || {},
      status: 'queued',
      downloadedBytes: 0,
      totalBytes: 0,
      speed: 0,
      eta: null,
      filePath: path.join(DOWNLOADS_DIR, cleanFilename),
      createdAt: new Date().toISOString()
    };

    storage.add(item);
    broadcastEvent('added', item);

    // Auto-start download
    downloader.start(item);

    return sendJson(res, 201, item);
  }

  // API: Actions on download item (/api/downloads/:id/:action)
  const actionMatch = pathname.match(/^\/api\/downloads\/([^/]+)\/(start|pause|cancel|open-file|open-folder)$/);
  if (actionMatch && req.method === 'POST') {
    const [, id, action] = actionMatch;
    const item = storage.getById(id);

    if (!item) {
      return sendJson(res, 404, { error: 'Download tidak ditemukan.' });
    }

    if (action === 'start') {
      downloader.start(item);
      return sendJson(res, 200, { success: true, item });
    }

    if (action === 'pause') {
      downloader.pause(item);
      return sendJson(res, 200, { success: true, item });
    }

    if (action === 'cancel') {
      downloader.cancel(item);
      return sendJson(res, 200, { success: true, item });
    }

    if (action === 'open-file') {
      if (item.filePath && fs.existsSync(item.filePath)) {
        exec(`start "" "${item.filePath}"`);
        return sendJson(res, 200, { success: true });
      } else {
        return sendJson(res, 404, { error: 'File tidak ditemukan di disk.' });
      }
    }

    if (action === 'open-folder') {
      if (item.filePath && fs.existsSync(item.filePath)) {
        exec(`explorer.exe /select,"${item.filePath}"`);
        return sendJson(res, 200, { success: true });
      } else {
        exec(`explorer.exe "${DOWNLOADS_DIR}"`);
        return sendJson(res, 200, { success: true });
      }
    }
  }

  // API: Bulk delete downloads
  if (req.method === 'POST' && pathname === '/api/downloads/bulk-delete') {
    const body = await parseBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const deletePhysicalFile = Boolean(body.deleteFile);

    if (ids.length === 0) {
      return sendJson(res, 400, { error: 'Daftar ID yang akan dihapus kosong.' });
    }

    const existingItems = ids.map(id => storage.getById(id)).filter(Boolean);
    for (const item of existingItems) {
      downloader.delete(item, deletePhysicalFile);
    }

    const removed = storage.removeMany(existingItems.map(i => i.id));
    const removedIds = removed.map(i => i.id);
    broadcastEvent('bulk-removed', { ids: removedIds, deleteFile: deletePhysicalFile });

    return sendJson(res, 200, { success: true, deletedCount: removedIds.length, ids: removedIds });
  }

  // API: Delete download
  const deleteMatch = pathname.match(/^\/api\/downloads\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = deleteMatch[1];
    const deletePhysicalFile = reqUrl.searchParams.get('deleteFile') === 'true';
    const item = storage.getById(id);

    if (item) {
      downloader.delete(item, deletePhysicalFile);
      storage.remove(id);
      broadcastEvent('removed', { id, deletePhysicalFile });
      return sendJson(res, 200, { success: true, id });
    } else {
      return sendJson(res, 404, { error: 'Download tidak ditemukan.' });
    }
  }

  // Serve static UI assets
  if (req.method === 'GET') {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('==================================================================');
  logger.ok('ENGINE', `GrabVideo Engine AKTIF pada http://127.0.0.1:${PORT}`);
  logger.info('FOLDER', `Direktori Unduhan: ${DOWNLOADS_DIR}`);
  logger.info('LOG', `File log tersimpan di: ${path.join(__dirname, 'engine.log')}`);
  console.log('==================================================================');
  console.log('Jendela ini menampilkan log live untuk analisis unduhan video.');
  console.log('');
});
