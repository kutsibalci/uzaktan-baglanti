// Sanal monitör yönetimi: VirtualDrivers/Virtual-Display-Driver (IddCx, imzalı sürücü).
// Kurulum: surucu-kur.bat  (winget install VirtualDrivers.Virtual-Display-Driver)
// Sürücü \\.\pipe\MTTVirtualDisplayPipe üzerinden UTF-16 komutlar alır:
//   PING -> PONG, SETDISPLAYCOUNT <n>, RELOAD_DRIVER
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PIPE = '\\\\.\\pipe\\MTTVirtualDisplayPipe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pipeCommand(cmd, waitReply = false) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PIPE);
    let reply = Buffer.alloc(0);
    const finish = () => { clearTimeout(timer); sock.destroy(); resolve(decode(reply)); };
    const timer = setTimeout(finish, waitReply ? 2000 : 300);
    sock.on('connect', () => sock.write(Buffer.from(cmd + '\0', 'utf16le')));
    sock.on('data', (d) => { reply = Buffer.concat([reply, d]); if (waitReply) finish(); });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Sürücü bazı cevapları UTF-8, bazılarını UTF-16 yazıyor.
function decode(buf) {
  if (buf.length >= 2 && buf[1] === 0) return buf.toString('utf16le').replace(/\0/g, '');
  return buf.toString('utf8').replace(/\0/g, '');
}

function configDir() {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\MikeTheTech\\VirtualDisplayDriver', '/v', 'VDDPATH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/VDDPATH\s+REG_\w+\s+(.+)/);
    if (m) return m[1].trim();
  } catch { /* kayıt yoksa varsayılan */ }
  return 'C:\\VirtualDisplayDriver';
}

class VirtualDisplays {
  constructor(helper) {
    this.helper = helper;
    this.count = 0;
    this.queue = Promise.resolve();
  }

  async available() {
    try {
      return /PONG/.test(await pipeCommand('PING', true));
    } catch {
      return false;
    }
  }

  // Başlangıçta sürücünün açık bıraktığı sanal monitörleri kapat.
  async reset() {
    if (!(await this.available())) return false;
    await pipeCommand('SETDISPLAYCOUNT 0');
    this.count = 0;
    return true;
  }

  // İstemcinin çözünürlüğü sürücünün listesinde yoksa ekler. true dönerse sürücü yeniden yüklenmeli.
  ensureResolution(w, h) {
    const file = path.join(configDir(), 'vdd_settings.xml');
    let xml;
    try { xml = fs.readFileSync(file, 'utf8'); } catch { return false; }
    const exists = new RegExp(`<width>\\s*${w}\\s*</width>\\s*<height>\\s*${h}\\s*</height>`).test(xml);
    if (exists || !xml.includes('</resolutions>')) return false;
    const entry = `    <resolution>\n        <width>${w}</width>\n        <height>${h}</height>\n        <refresh_rate>60</refresh_rate>\n    </resolution>\n</resolutions>`;
    try {
      fs.writeFileSync(file, xml.replace('</resolutions>', entry));
      return true;
    } catch (e) {
      console.warn(`vdd_settings.xml yazılamadı (${e.code}); varsayılan çözünürlük kullanılacak.`);
      return false;
    }
  }

  // Yeni sanal monitör ekler ve cihaz adını döner (ör. \\.\DISPLAY3).
  add(w, h) {
    const job = this.queue.then(() => this._add(w, h));
    this.queue = job.catch(() => {});
    return job;
  }

  async _add(w, h) {
    if (!(await this.available())) throw new Error('DRIVER_MISSING');
    const before = new Set((await this.helper.info()).screens.map((s) => s.name));

    if (this.ensureResolution(w, h)) {
      await pipeCommand('RELOAD_DRIVER');
      await sleep(3000);
    }
    this.count++;
    await pipeCommand(`SETDISPLAYCOUNT ${this.count}`);

    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const added = (await this.helper.info()).screens.find((s) => !before.has(s.name));
      if (added) {
        if (added.w !== w || added.h !== h) await this.helper.setMode(added.name, w, h);
        return added.name;
      }
    }
    this.count--;
    await pipeCommand(`SETDISPLAYCOUNT ${this.count}`);
    throw new Error('Sanal monitör oluşturulamadı (zaman aşımı).');
  }

  remove() {
    const job = this.queue.then(async () => {
      if (this.count === 0) return;
      this.count--;
      await pipeCommand(`SETDISPLAYCOUNT ${this.count}`);
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

module.exports = { VirtualDisplays };
