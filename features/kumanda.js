// Kumanda modu: görüntü akışı OLMADAN telefonu touchpad / medya kumandası / sunum kumandası / klavye olarak kullanmak.
// Çekirdek girdisi (move/down/up/...) yalnızca görüntüleme sürerken (ws.streaming) kabul edilir; kumanda kendi mesajını kullanır:
//   { t: 'kumanda', op: 'rel', dx, dy }        göreli fare hareketi (fiziksel piksel; istemci ivmeyi uygular)
//   { t: 'kumanda', op: 'down' | 'up', b }     fare düğmesi (left | right | middle)
//   { t: 'kumanda', op: 'wheel', dy, dx }      tekerlek (120 = bir çentik)
//   { t: 'kumanda', op: 'key', vk, down }      tuş (medya tuşları: 0xB0–0xB3, ses: 0xAD–0xAF; sunum: PgUp/PgDn, F5, Esc, B)
//   { t: 'kumanda', op: 'text', s }            metin (ekran klavyesi)
//   { t: 'kumanda', op: 'end' }                kumandadan çıkış: basılı düğmeler bırakılır (bağlantı kopunca da)
// Göreli hareket için imlecin yeri RemoteHelper'ın "cursor" komutuyla okunur (girdi göndermez), sonra çekirdekteki gibi
// "move <ekran> nx ny" gönderilir. Yer, kumandanın son hareketinden 400 ms geçtiyse yeniden okunur (arada gerçek fare oynamış olabilir).
// REMOTE_KUMANDA_KURU=1 ise hiçbir girdi gönderilmez; gönderilecek komut isteyene { t: 'kumanda-kuru', cmd, from?, to? } olarak
// bildirilir (testler bunu kullanır; imleç okuma zararsız olduğu için gerçek yapılır).
const BUTTONS = new Set(['left', 'right', 'middle']);
const TAZE_MS = 400;     // imleç yeri bu kadar süre kumandanın kendi hesabıyla takip edilir
const EKRAN_MS = 5000;   // ekran listesi önbelleği
const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : 0);

// Nokta hiçbir ekranda değilse (ekranlar arası boşluk, masaüstü dışı) en yakın ekranın içine çekilir.
function ekranaSigdir(screens, p) {
  let best = null;
  for (const s of screens) {
    const x = Math.min(s.x + s.w - 1, Math.max(s.x, p.x));
    const y = Math.min(s.y + s.h - 1, Math.max(s.y, p.y));
    const d = Math.hypot(x - p.x, y - p.y);
    if (!best || d < best.d) best = { s, x, y, d };
  }
  return best;
}

module.exports.ekranaSigdir = ekranaSigdir;

module.exports.init = (api) => {
  const kuru = process.env.REMOTE_KUMANDA_KURU === '1';
  let screens = null, screensAt = 0;
  let pos = null, posAt = 0;           // kumandanın bildiği imleç yeri (fiziksel piksel)
  let bekleyen = { dx: 0, dy: 0 };     // imleç okunurken gelen hareketler
  let mesgul = false;

  function gonder(ws, cmd, extra) {
    if (kuru) api.sendJson(ws, { t: 'kumanda-kuru', cmd, ...extra });
    else api.helper.send(cmd);
  }

  async function ekranlar() {
    if (!screens || Date.now() - screensAt > EKRAN_MS) {
      screens = (await api.helper.info()).screens || [];
      screensAt = Date.now();
    }
    return screens;
  }

  async function imlec(list) {
    try {
      const c = JSON.parse((await api.helper.request('cursor')).toString());
      if (c.ok) return { x: c.x, y: c.y };
    } catch { /* yardımcı yeniden başlıyor */ }
    const ana = list.find((s) => s.primary) || list[0];
    return ana ? { x: ana.x + ana.w / 2, y: ana.y + ana.h / 2 } : { x: 0, y: 0 };
  }

  let calisan = null; // süren göreli hareket hesabı (tık/tuş ondan sonra gitsin)
  function goreli(ws, dx, dy) {
    bekleyen.dx += dx; bekleyen.dy += dy;
    if (!mesgul) calisan = isle(ws); // süren hesap bekleyeni de uygular
    return calisan;
  }
  async function isle(ws) {
    mesgul = true;
    try {
      while (bekleyen.dx || bekleyen.dy) {
        const list = await ekranlar();
        if (!list.length) { bekleyen = { dx: 0, dy: 0 }; return; }
        if (!pos || Date.now() - posAt > TAZE_MS) pos = await imlec(list);
        const d = bekleyen;
        bekleyen = { dx: 0, dy: 0 };
        const from = { ...pos };
        const b = ekranaSigdir(list, { x: pos.x + d.dx, y: pos.y + d.dy });
        pos = { x: b.x, y: b.y };
        posAt = Date.now();
        // RemoteHelper.MapPoint'in tersi: nx * (w - 1) + x = piksel
        const nx = b.s.w > 1 ? (b.x - b.s.x) / (b.s.w - 1) : 0;
        const ny = b.s.h > 1 ? (b.y - b.s.y) / (b.s.h - 1) : 0;
        gonder(ws, `move ${b.s.name} ${nx.toFixed(5)} ${ny.toFixed(5)}`, { from, to: { ...pos } });
      }
    } finally {
      mesgul = false;
    }
  }

  function birak(ws) {
    if (!ws.kumandaBasili?.size) return;
    for (const b of ws.kumandaBasili) gonder(ws, `up ${b}`);
    ws.kumandaBasili.clear();
  }

  api.on('kumanda', async (ws, m) => {
    // Tık/tuş, öncesinde gönderilen göreli hareketin bittiği yere gitsin (imleç okunurken beklemiş olabilir).
    if (m.op !== 'rel' && mesgul) await calisan.catch(() => {});
    switch (m.op) {
      case 'rel': {
        const dx = Math.round(num(m.dx, -4000, 4000)), dy = Math.round(num(m.dy, -4000, 4000));
        if (dx || dy) await goreli(ws, dx, dy);
        return;
      }
      case 'down':
      case 'up':
        if (!BUTTONS.has(m.b)) return;
        if (!ws.kumandaBasili) ws.kumandaBasili = new Set();
        if (m.op === 'down') ws.kumandaBasili.add(m.b); else ws.kumandaBasili.delete(m.b);
        gonder(ws, `${m.op} ${m.b}`);
        return;
      case 'wheel': {
        const dy = Math.round(num(m.dy, -1200, 1200)), dx = Math.round(num(m.dx, -1200, 1200));
        if (dy || dx) gonder(ws, `wheel ${dy} ${dx}`);
        return;
      }
      case 'key': {
        // Aralık dışı tuş kodu sınırlanmaz, yok sayılır (yanlış tuşa basılmasın).
        const vk = m.vk;
        if (typeof vk === 'number' && Number.isInteger(vk) && vk >= 1 && vk <= 254) gonder(ws, `key ${vk} ${m.down ? 1 : 0}`);
        return;
      }
      case 'text':
        if (typeof m.s === 'string' && m.s.length && m.s.length <= 1000) gonder(ws, `text ${Buffer.from(m.s, 'utf8').toString('base64')}`);
        return;
      case 'end':
        birak(ws);
        return;
    }
  }, { role: 'control' });

  // Bağlantı koparsa kumandayla basılı tutulan düğme basılı kalmasın.
  api.onClose((ws) => birak(ws));
};
