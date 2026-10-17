// Tüm testleri çalıştırır:  node test/calistir.js            (hepsi)
//                           node test/calistir.js ozellik-pano  (adı geçenler)
// Her test paketi için temiz bir veri klasörüyle 3999 portunda ayrı bir sunucu başlatılır.
// Yeni özellik testleri "test/ozellik-<ad>.js" adıyla eklenir; sunucu ws://localhost:<TEST_PORT>'da hazırdır (process.env.TEST_PORT, varsayılan 3999),
// veri klasörü boştur (ilk bağlanan localhost istemcisi "setup" ile yönetici oluşturabilir).
// Test dosyasının ilk satırlarında:  // @ortam AD=değer  -> sunucuya ve teste ortam değişkeni (ör. TRAY_TOKEN)
//                                    // @sunucu yok      -> ortak sunucu başlatılmaz (test kendi sürecini yönetir)
// Güç komutları ve "bilgisayarda göster" (Dosya Gezgini) testlerde asla çalışmasın diye sunucular her zaman
// REMOTE_GUC_KURU=1 ve REMOTE_DOSYA_KURU=1 ile başlatılır.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.TEST_PORT || '3999'; // paralel çalışan testler farklı port kullanmalı

function staticChecks() {
  let ok = true;
  const jsFiles = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!['node_modules', 'dist', 'data', '.git', '.claude'].includes(f.name)) walk(p); }
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

// Test dosyasının başındaki "// @ortam AD=değer" ve "// @sunucu yok" satırları.
function suiteOptions(file) {
  const head = fs.readFileSync(path.join(__dirname, file), 'utf8').split(/\r?\n/).slice(0, 30);
  const env = {};
  let server = true;
  for (const line of head) {
    const m = line.match(/^\/\/ @ortam ([A-Z_][A-Z0-9_]*)=(\S*)\s*$/);
    if (m) env[m[1]] = m[2];
    if (/^\/\/ @sunucu yok\s*$/.test(line)) server = false;
  }
  return { env, server };
}

// REMOTE_GUC_KURU=1 / REMOTE_DOSYA_KURU=1: testlerde gerçek güç komutu ve Dosya Gezgini asla çalışmaz.
function startServer(dataDir, ortam = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, ...ortam, PORT, TEST_PORT: PORT, REMOTE_DATA_DIR: dataDir, REMOTE_GUC_KURU: '1', REMOTE_DOSYA_KURU: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  // Her pakete geçici bir klasör (TEST_TMP, sunucuya ve teste verilir). Dosya aktarımı gerçek
  // İndirilenler/profil klasörü yerine bunun altını kullanır (REMOTE_UPLOAD_DIR, REMOTE_BROWSE_ROOT).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tmp-'));
  const opts = suiteOptions(file);
  const ortam = { TEST_TMP: tmpDir, REMOTE_UPLOAD_DIR: path.join(tmpDir, 'yuklenen'), REMOTE_BROWSE_ROOT: path.join(tmpDir, 'kok'), ...opts.env };
  fs.mkdirSync(path.join(tmpDir, 'kok'));
  let server;
  try {
    if (opts.server) {
      server = await startServer(dataDir, ortam);
      server.p.removeAllListeners('exit');
    }
    const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, ...ortam, TEST_PORT: PORT, REMOTE_GUC_KURU: '1', REMOTE_DOSYA_KURU: '1' },
    });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stdout.write(r.stderr);
    const ok = r.status === 0;
    if (!ok && server) console.log(`--- sunucu çıktısı (${file}) ---\n${server.log().slice(-3000)}`);
    return ok;
  } catch (e) {
    console.log(`FAIL ${file}: ${e.message}`);
    return false;
  } finally {
    if (server) killTree(server.p.pid);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
