// Tüm testleri çalıştırır:  node test/calistir.js            (hepsi)
//                           node test/calistir.js ozellik-pano  (adı geçenler)
// Her test paketi için temiz bir veri klasörüyle 3999 portunda ayrı bir sunucu başlatılır.
// Yeni özellik testleri "test/ozellik-<ad>.js" adıyla eklenir; sunucu ws://localhost:3999'da hazırdır,
// veri klasörü boştur (ilk bağlanan localhost istemcisi "setup" ile yönetici oluşturabilir).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = '3999';

function staticChecks() {
  let ok = true;
  const jsFiles = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!['node_modules', 'dist', 'data', '.git'].includes(f.name)) walk(p); }
      else if (f.name.endsWith('.js')) jsFiles.push(p);
    }
  };
  walk(ROOT);
  for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { ok = false; console.log(`FAIL sözdizimi: ${path.relative(ROOT, f)}\n${r.stderr}`); }
  }
  // app.js'teki $('id') kimlikleri index.html'de olmalı
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const ids = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  if (missing.length) { ok = false; console.log(`FAIL index.html'de eksik kimlikler: ${missing.join(', ')}`); }
  console.log(`${ok ? 'OK  ' : 'FAIL'} statik kontroller (${jsFiles.length} js dosyası, ${ids.size} kimlik)`);
  return ok;
}

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, PORT, REMOTE_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`sunucu başlamadı:\n${out}`)), 30000);
    const onData = (d) => {
      out += d;
      if (out.includes('sunucusu çalışıyor')) { clearTimeout(timer); setTimeout(() => resolve({ p, log: () => out }), 1500); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => { clearTimeout(timer); reject(new Error(`sunucu kapandı (${c}):\n${out}`)); });
  });
}

async function runSuite(file) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'));
  let server;
  try {
    server = await startServer(dataDir);
    server.p.removeAllListeners('exit');
    const r = spawnSync(process.execPath, [path.join(__dirname, file)], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stdout.write(r.stderr);
    const ok = r.status === 0;
    if (!ok) console.log(`--- sunucu çıktısı (${file}) ---\n${server.log().slice(-3000)}`);
    return ok;
  } catch (e) {
    console.log(`FAIL ${file}: ${e.message}`);
    return false;
  } finally {
    if (server) killTree(server.p.pid);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  const only = process.argv.slice(2);
  const suites = ['e2e.js', 'e2e-ts.js', 'e2e-h264.js',
    ...fs.readdirSync(__dirname).filter((f) => /^ozellik-.*\.js$/.test(f)).sort()]
    .filter((f) => !only.length || only.some((o) => f.startsWith(o)));
  const results = { statik: staticChecks() };
  for (const s of suites) {
    console.log(`\n=== ${s} ===`);
    results[s] = await runSuite(s);
  }
  console.log('\n=== ÖZET ===');
  for (const [k, v] of Object.entries(results)) console.log(`${v ? 'OK  ' : 'FAIL'} ${k}`);
  process.exit(Object.values(results).every(Boolean) ? 0 : 1);
})();
