// Bağlantının nereden geldiğini anlama + Tailscale durumu.
const net = require('net');
const fs = require('fs');
const { execFile } = require('child_process');

const normalize = (ip) => (ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip || '');
const isLoopback = (ip) => ['127.0.0.1', '::1'].includes(normalize(ip));

// Tailscale adresleri: 100.64.0.0/10 ve fd7a:115c:a1e0::/48
function isTailscale(ip) {
  ip = normalize(ip);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

// Ev ağı, Tailscale veya bu bilgisayar. Bunların dışındaki (internetten gelen) bağlantılar reddedilir.
function isPrivate(ip) {
  ip = normalize(ip);
  if (isLoopback(ip) || isTailscale(ip)) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const l = ip.toLowerCase();
  return l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login', 'tailscale-user-name'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// "tailscale serve" bağlantıları bize 127.0.0.1'den gelir. Bunları bu bilgisayarın kendisiyle
// karıştırmamak için yalnızca yönlendirme başlığı olmayan ve Host'u localhost olan istekler yerel sayılır.
function clientInfo(req) {
  const sock = normalize(req.socket.remoteAddress);
  const forwarded = FORWARD_HEADERS.some((h) => req.headers[h]);
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();

  if (isLoopback(sock) && forwarded) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return {
      ip: normalize(fwd) || 'tailscale',
      via: 'tailscale',
      tsUser: String(req.headers['tailscale-user-login'] || '').slice(0, 100),
      isLocal: false,
    };
  }
  return {
    ip: sock,
    via: isLoopback(sock) ? 'local' : isTailscale(sock) ? 'tailscale' : 'lan',
    tsUser: '',
    isLocal: isLoopback(sock) && LOCAL_HOSTS.has(host),
  };
}

// ---------- Tailscale ----------

const TS_EXE = ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
  .find((p) => fs.existsSync(p)) || 'tailscale';

function ts(args) {
  return new Promise((resolve) => {
    execFile(TS_EXE, args, { timeout: 4000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function tailscaleInfo() {
  const out = await ts(['status', '--json']);
  if (out === null) return { installed: false };
  let st;
  try { st = JSON.parse(out); } catch { return { installed: true, running: false }; }
  const running = st.BackendState === 'Running';
  const ip = (st.Self?.TailscaleIPs || []).find((x) => net.isIPv4(x)) || null;
  const dns = (st.Self?.DNSName || '').replace(/\.$/, '') || null;

  let https = false;
  const serve = await ts(['serve', 'status', '--json']);
  if (serve) {
    try { https = Object.keys(JSON.parse(serve).Web || {}).length > 0; } catch { /* serve yok */ }
  }
  return { installed: true, running, ip, dns, httpsUrl: https && dns ? `https://${dns}` : null };
}

module.exports = { clientInfo, isPrivate, tailscaleInfo };
