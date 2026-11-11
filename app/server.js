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

    let cleanFilename = body.filename ? downloader.sanitizeFilename(body.filename) : '';
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
      cleanFilename = `video_${Date.now()}.${detectedFormat === 'm3u8' ? 'mp4' : detectedFormat}`;
    }

    if (!path.extname(cleanFilename)) {
      cleanFilename += `.${detectedFormat === 'm3u8' ? 'mp4' : detectedFormat}`;
    }

    const item = {
      id: crypto.randomUUID(),
      url,
      filename: cleanFilename,
      format: detectedFormat,
      pageTitle: body.pageTitle || cleanFilename,
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
