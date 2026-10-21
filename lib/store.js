// Kullanıcılar, hatırlanan cihazlar, ayarlar ve bağlantı günlüğü: data/store.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.REMOTE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');
const ROLES = ['admin', 'control', 'view'];
const LOG_LIMIT = 200;

const DEFAULTS = {
  users: [],
  devices: [],
  settings: { requireApproval: true, trustTailscale: true, guestOtp: true, guestRole: 'control', blockPublicLan: true },
  log: [],
};

let data = load();

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...d, settings: { ...DEFAULTS.settings, ...d.settings } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

// ---------- Şifreler ----------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function validateUsername(u) {
  if (typeof u !== 'string' || !/^[\p{L}\p{N}._-]{3,32}$/u.test(u)) {
    throw new Error('Kullanıcı adı 3-32 karakter olmalı (harf, rakam, . _ -).');
  }
}
function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 6 || p.length > 128) throw new Error('Şifre en az 6 karakter olmalı.');
}

// ---------- Kullanıcılar ----------

const findUser = (username) => data.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
const hasUsers = () => data.users.length > 0;

function addUser(username, password, role) {
  validateUsername(username);
  validatePassword(password);
  if (!ROLES.includes(role)) throw new Error('Geçersiz yetki.');
  if (findUser(username)) throw new Error('Bu kullanıcı adı zaten var.');
  data.users.push({ username, ...hashPassword(password), role, createdAt: Date.now() });
  save();
}

function verifyUser(username, password) {
  const u = findUser(username);
  if (!u || typeof password !== 'string') {
    hashPassword('zamanlama-esitleme'); // kullanıcı yokken de aynı süre harcansın
    return null;
  }
  return checkPassword(u, password) ? u : null;
}

function adminCount() {
  return data.users.filter((u) => u.role === 'admin').length;
}

function deleteUser(username) {
  const u = findUser(username);
  if (!u) throw new Error('Kullanıcı bulunamadı.');
  if (u.role === 'admin' && adminCount() === 1) throw new Error('Son yönetici silinemez.');
  data.users = data.users.filter((x) => x !== u);
  data.devices = data.devices.filter((d) => d.username !== u.username);
  save();
}

function setRole(username, role) {
  const u = findUser(username);
  if (!u) throw new Error('Kullanıcı bulunamadı.');
  if (!ROLES.includes(role)) throw new Error('Geçersiz yetki.');
  if (u.role === 'admin' && role !== 'admin' && adminCount() === 1) throw new Error('Son yöneticinin yetkisi düşürülemez.');
  u.role = role;
  save();
}

function setPassword(username, password) {
  const u = findUser(username);
  if (!u) throw new Error('Kullanıcı bulunamadı.');
  validatePassword(password);
  Object.assign(u, hashPassword(password));
  // Şifre değişince hatırlanan cihazlar da geçersiz olsun.
  data.devices = data.devices.filter((d) => d.username !== u.username);
  save();
}

// ---------- Hatırlanan cihazlar ----------

function addDevice(username, name, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  const device = {
    id: crypto.randomBytes(6).toString('hex'),
    username,
    name: String(name || 'Bilinmeyen cihaz').slice(0, 60),
    tokenHash: sha256(token),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    lastIp: ip,
  };
  data.devices.push(device);
  save();
  return { device, token };
}

function deviceByToken(token, ip) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const h = sha256(token);
  const d = data.devices.find((x) => x.tokenHash === h);
  if (!d) return null;
  const user = findUser(d.username);
  if (!user) return null;
  d.lastSeen = Date.now();
  d.lastIp = ip;
  save();
  return { device: d, user };
}

function removeDevice(id) {
  const before = data.devices.length;
  data.devices = data.devices.filter((d) => d.id !== id);
  if (data.devices.length === before) throw new Error('Cihaz bulunamadı.');
  save();
}

// ---------- Ayarlar ve günlük ----------

function setSetting(key, value) {
  if (['requireApproval', 'trustTailscale', 'guestOtp', 'blockPublicLan'].includes(key)) data.settings[key] = !!value;
  else if (key === 'guestRole' && ['control', 'view'].includes(value)) data.settings.guestRole = value;
  else throw new Error('Geçersiz ayar.');
  save();
}

function log(event, details = {}) {
  data.log.unshift({ time: Date.now(), event, ...details });
  data.log.length = Math.min(data.log.length, LOG_LIMIT);
  save();
}

function snapshot() {
  return {
    users: data.users.map(({ username, role, createdAt }) => ({ username, role, createdAt })),
    devices: data.devices.map(({ tokenHash, ...d }) => d),
    settings: { ...data.settings },
    log: data.log.slice(0, 50),
  };
}

module.exports = {
  ROLES, DATA_DIR, hasUsers, findUser, addUser, verifyUser, deleteUser, setRole, setPassword,
  addDevice, deviceByToken, removeDevice, setSetting, log, snapshot,
  get settings() { return data.settings; },
};
