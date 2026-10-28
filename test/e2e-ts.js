// Tailscale serve taklidi: 127.0.0.1'den ama yönlendirme başlıklarıyla gelen bağlantı yerel sayılmamalı.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const net = require(path.join(ROOT, 'lib', 'network.js'));
let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); if (!c) fails++; };

const fake = (remote, headers) => ({ socket: { remoteAddress: remote }, headers });
let i = net.clientInfo(fake('::ffff:127.0.0.1', { host: 'localhost:3000' }));
check('localhost tarayıcı = yerel', i.isLocal && i.via === 'local');
i = net.clientInfo(fake('127.0.0.1', { host: 'pc.tail1234.ts.net', 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': 'ben@gmail.com' }));
check('tailscale serve = yerel DEĞİL', !i.isLocal && i.via === 'tailscale' && i.ip === '100.101.102.103', JSON.stringify(i));
i = net.clientInfo(fake('127.0.0.1', { host: 'pc.tail1234.ts.net' }));
check('başlıksız ama Host ts.net = yerel DEĞİL', !i.isLocal);
i = net.clientInfo(fake('100.80.1.2', { host: '100.70.0.1:3000' }));
check('doğrudan Tailscale IP', !i.isLocal && i.via === 'tailscale');
i = net.clientInfo(fake('192.168.1.50', { host: '192.168.1.10:3000' }));
check('ev ağı', !i.isLocal && i.via === 'lan');
check('internet IP reddedilir', !net.isPrivate('85.105.3.4') && !net.isPrivate('8.8.8.8'));
check('özel IP kabul', ['10.0.0.5', '172.20.1.1', '192.168.0.9', '100.64.0.1', '::1', 'fd7a:115c:a1e0::1'].every(net.isPrivate));
check('172.32 ve 100.128 özel değil', !net.isPrivate('172.32.0.1') && !net.isPrivate('100.128.0.1'));

// Gerçek sunucuya tailscale-serve gibi bağlan: kurulum izni verilmemeli
const ws = new WebSocket(`ws://127.0.0.1:${process.env.TEST_PORT || 3999}`, { headers: { 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': 'x@y' } });
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.t !== 'hello') return;
  check('serve üzerinden gelen hello: kurulum izni yok', m.needsSetup && !m.canSetup, JSON.stringify(m));
  ws.send(JSON.stringify({ t: 'setup', username: 'saldirgan', password: 'abcdef12' }));
  ws.once('message', (d2) => {
    const r = JSON.parse(d2.toString());
    check('serve üzerinden kurulum reddedildi', !r.ok, r.error);
    net.tailscaleInfo().then((ts) => {
      check('tailscaleInfo çalışıyor', typeof ts.installed === 'boolean', JSON.stringify(ts));
      console.log(fails ? `${fails} HATA` : 'hepsi geçti');
      process.exit(fails ? 1 : 0);
    });
  });
});
