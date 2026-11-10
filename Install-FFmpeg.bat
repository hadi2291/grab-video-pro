@echo off
title Install FFmpeg untuk GrabVideo
echo ========================================================
echo       Mengunduh FFmpeg untuk Penggabungan Suara
echo ========================================================
echo.

cd /d "%~dp0app"
node -e "
const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const path = require('path');

const targetUrl = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz';
const destPath = path.join(__dirname, 'bin', 'ffmpeg.exe');

if (fs.existsSync(destPath)) {
  console.log('FFmpeg sudah terpasang di app/bin/ffmpeg.exe!');
  process.exit(0);
}

console.log('Mengunduh dan mengekstrak ffmpeg.exe (~25MB)...');
function download(url) {
  https.get(url, (res) => {
    if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
      return download(res.headers.location);
    }
    const gunzip = zlib.createGunzip();
    const out = fs.createWriteStream(destPath);
    res.pipe(gunzip).pipe(out);
    out.on('finish', () => {
      console.log('FFmpeg berhasil terpasang!');
      process.exit(0);
    });
  });
}
download(targetUrl);
"

echo.
echo Selesai! Sekarang video YouTube 1080p akan memiliki suara utuh.
pause
