// RemoteHelper.exe ile konuşan katman (ekran yakalama, giriş simülasyonu, onay penceresi).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HELPER_DIR = path.join(__dirname, '..', 'helper');
const EXE = path.join(HELPER_DIR, 'RemoteHelper.exe');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

// helper/<ad>.cs dosyasını Windows'un kendi C# derleyicisiyle derler (kaynak daha yeniyse) ve exe yolunu döner.
// target: 'exe' (konsol) ya da 'winexe' (pencereli, konsolsuz — ör. tepsi simgesi).
function buildExe(name, { target = 'exe', refs = ['System.Drawing.dll', 'System.Windows.Forms.dll'] } = {}) {
  const src = path.join(HELPER_DIR, `${name}.cs`);
  const exe = path.join(HELPER_DIR, `${name}.exe`);
  const needsBuild = !fs.existsSync(exe) || fs.statSync(exe).mtimeMs < fs.statSync(src).mtimeMs;
  if (needsBuild) {
    console.log(`Derleniyor: ${name}.cs`);
    execFileSync(CSC, ['/nologo', '/optimize', `/target:${target}`, `/out:${exe}`, ...refs.map((r) => `/r:${r}`), src], { stdio: 'inherit' });
  }
  return exe;
}
const build = () => buildExe('RemoteHelper');

class Helper {
  constructor() {
    build();
    this.pending = [];
    this.buf = Buffer.alloc(0);
    this.start();
  }

  start() {
    this.proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.on('exit', (code) => {
      console.warn(`Yardımcı program kapandı (kod ${code}), yeniden başlatılıyor...`);
      for (const p of this.pending) p.reject(new Error('helper exited'));
      this.pending = [];
      this.buf = Buffer.alloc(0);
      setTimeout(() => this.start(), 500);
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32LE(1);
      if (this.buf.length < 5 + len) break;
      const payload = Buffer.from(this.buf.subarray(5, 5 + len));
      this.buf = this.buf.subarray(5 + len);
      const p = this.pending.shift();
      if (p) p.resolve(payload);
    }
  }

  send(cmd) {
    if (this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  request(cmd) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.send(cmd);
    });
  }

  async info() {
    return JSON.parse((await this.request('info')).toString());
  }

  async setMode(screen, w, h) {
    return JSON.parse((await this.request(`setmode ${screen} ${w} ${h}`)).toString()).ok;
  }
}

// Bilgisayarda "İzin ver / Reddet" penceresi gösterir. Süre dolarsa reddedilmiş sayılır.
function askHost(title, message, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const p = spawn(EXE, ['ask', b64(title), b64(message)], { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    p.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

module.exports = { Helper, askHost, buildExe };
