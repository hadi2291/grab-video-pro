# GrabVideo PRO 🎬
**Multi-Format Video Grabber & Windows Download Manager**

Sistem lengkap untuk mendeteksi (*sniff*) video dari browser dan mengelolanya secara penuh melalui Aplikasi Windows Download Manager dengan fitur **Start, Jeda (Pause/Stop), Batalkan (Cancel), Hapus (Delete)**, serta pemantauan kecepatan unduh real-time.

---

## 🌟 Fitur Utama

### 1. Ekstensi Browser (Chrome & Edge - Manifest V3)
- **Auto-Sniffer Cerdas**: Otomatis mendeteksi video HTML5, aliran stream, dan file media yang diputar di halaman tab aktif.
- **Dukungan Format Luas**:
  - **Video**: `MP4`, `WebM`, `MKV`, `FLV`, `AVI`, `MOV`, `TS`
  - **HLS Streaming**: `M3U8` (HLS manifest)
  - **Audio**: `MP3`, `M4A`, `AAC`, `OGG`, `WAV`
- **Badge Counter**: Menampilkan jumlah video yang terdeteksi secara real-time pada ikon ekstensi.
- **Integrasi 1-Klik**:
  - `⚡ Download di App`: Mengirim link langsung ke Download Manager Windows.
  - `⬇️ Browser`: Unduh langsung lewat pengelola bawaan browser jika diinginkan.
  - `📋 Salin`: Menyalin URL aliran video/stream.

### 2. Aplikasi Windows Download Manager
- **Kontrol Download Penuh**:
  - ▶️ **Mulai / Lanjutkan (Start / Resume)**: Mendukung HTTP `Range` untuk melanjutkan unduhan yang sempat terjeda.
  - ⏸️ **Jeda / Berhenti (Pause / Stop)**: Menghentikan stream sementara tanpa menghapus bagian yang sudah diunduh.
  - ⏹️ **Batalkan (Cancel)**: Menghentikan unduhan secara langsung.
  - 🗑️ **Hapus (Delete)**: Menghapus dari daftar riwayat, dengan opsi hapus juga file fisik di hard drive.
  - 📂 **Buka File & Folder**: Langsung putar video di pemutar bawaan Windows atau buka posisinya di Windows Explorer (`explorer.exe`).
- **Engine Khusus M3U8/HLS**:
  - Otomatis membaca playlist `.m3u8`, mengunduh semua segmen `.ts`, dan menyatukannya menjadi satu file video utuh.
- **Antarmuka Modern (Sleek Glassmorphism Dark UI)**:
  - Real-time Server-Sent Events (SSE) dengan kecepatan unduh (KB/s, MB/s), persentase progress, estimasi waktu (ETA).
  - Statistik ringkasan (Total Video, Sedang Mengunduh, Selesai, Total Kecepatan).
  - Filter status (Semua, Mengunduh, Dijeda, Selesai, Dibatalkan) dan pencarian live.

---

## 🚀 Panduan Penggunaan Cepat

### Langkah 1: Jalankan Aplikasi Windows
Cukup **double-click** file:
```
Start-GrabVideo.bat
```
> *Skrip ini akan otomatis menjalankan engine latar belakang dan membuka antarmuka aplikasi dalam mode desktop mandiri.*

*(Atau via terminal: jalankan `npm start` atau `node app/server.js` lalu buka `http://127.0.0.1:54321` di browser).*

---

### Langkah 2: Pasang Ekstensi di Browser (Chrome atau Edge)

**Cara Paling Mudah (Otomatis):**
> Cukup double-click file: **`Buka-Browser-Dengan-Ekstensi.bat`**
> Browser Chrome/Edge Anda akan langsung terbuka dengan ekstensi GrabVideo otomatis terpasang dan aktif!

**Cara Manual (Load Unpacked):**
1. Buka browser **Google Chrome** (`chrome://extensions/`) atau **Microsoft Edge** (`edge://extensions/`).
2. Aktifkan toggle **Mode Pengembang (Developer Mode)** di sudut kanan atas.
3. Klik tombol **Muat yang belum dibongkar (Load unpacked)** di kiri atas.
4. **Penting**: Jendela yang muncul adalah dialog **Pilih Folder (Select Folder)**, bukan pilih file individual.
   - Sorot/klik **folder `extension`** (atau ekstrak dari `GrabVideo-Extension.zip`).
   - Klik tombol **"Select Folder" / "Pilih Folder"** di sudut kanan bawah.
5. Ekstensi **GrabVideo** kini aktif di toolbar browser Anda! (Sematkan/Pin ikon ekstensi agar mudah diakses).

---

### Langkah 3: Mengunduh Video
1. Buka halaman web mana saja yang memiliki video (misal video streaming, media sosial, berita, dll.).
2. Putar video tersebut beberapa detik.
3. Klik ikon ekstensi **GrabVideo** pada toolbar browser.
4. Ekstensi akan menampilkan daftar video/stream beserta format dan ukurannya.
5. Klik **"⚡ Download di App"** — video akan langsung masuk dan mulai diunduh di **Windows Download Manager**!
6. Anda bisa mengontrolnya kapan saja (Start, Pause, Cancel, Hapus) langsung dari aplikasi Windows.

---

## 📁 Struktur Direktori

```
d:\PROJECT_MANDIRI\GrabVideo\
│
├── Start-GrabVideo.bat         # 1-Klik untuk menjalankan aplikasi Windows
├── Stop-GrabVideo.bat          # 1-Klik untuk mematikan engine latar belakang
├── package.json
├── README.md
│
├── app/                        # Windows Engine & Desktop UI
│   ├── server.js               # HTTP/SSE Server & REST API
│   ├── downloader.js           # Multi-part chunk downloader & parser M3U8
│   ├── storage.js              # Database persistensi (downloads.json)
│   ├── downloads/              # Folder penyimpanan hasil unduhan video
│   └── public/                 # Tampilan UI Desktop (HTML, CSS, JS)
│       ├── index.html
│       ├── style.css
│       └── app.js
│
└── extension/                  # Ekstensi Browser (Manifest V3)
    ├── manifest.json
    ├── background.js           # Background service worker (Network Sniffer)
    ├── content.js              # DOM Inspector (<video> & <audio>)
    ├── popup.html              # Antarmuka popup ekstensi
    ├── popup.css
    ├── popup.js
    └── icons/                  # Ikon ekstensi (16x16, 48x48, 128x128)
```

---

## 🛠️ Tips Tambahan
- **Folder Hasil Unduhan**: Secara default tersimpan di folder `app/downloads/`. Anda bisa langsung membukanya dengan mengklik tombol **"Folder Unduhan"** pada header aplikasi.
- **Input Link Manual**: Jika Anda sudah memiliki link langsung MP4 atau M3U8, Anda juga bisa menempelkannya langsung di aplikasi Windows dengan mengklik tombol **"+ Tambah Link"**.
- **Untuk Mematikan Engine**: Cukup double-click file `Stop-GrabVideo.bat`.
