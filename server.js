// سيرفر توك توك سوهاج — بدون مكتبات خارجية. محتاج Node.js 18+
// التشغيل: node server.js  ثم افتح http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || __dirname; // على الاستضافة: وجّهه لمكان تخزين دائم
const F = { rides: path.join(DIR, 'rides.json'), users: path.join(DIR, 'users.json'), sess: path.join(DIR, 'sessions.json') };
const BOUNDS = [[26.46, 31.58], [26.65, 31.82]]; // سوهاج وضواحيها
const DAY = 864e5;

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const save = (f, d) => fs.writeFile(f + '.tmp', JSON.stringify(d), e => { if (!e) fs.rename(f + '.tmp', f, () => {}); });
let rides = read(F.rides, []), users = read(F.users, {}), sess = read(F.sess, {});
const persistRides = () => { if (rides.length > 1000) rides = rides.slice(-1000); save(F.rides, rides); };

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const digits = s => String(s || '').replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632).replace(/[\s-]/g, '');
function normPhone(v) { let p = digits(v); if (p.startsWith('+20')) p = '0' + p.slice(3); return /^01[0125]\d{8}$/.test(p) ? p : null; }
const inBounds = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) &&
  p[0] >= BOUNDS[0][0] && p[0] <= BOUNDS[1][0] && p[1] >= BOUNDS[0][1] && p[1] <= BOUNDS[1][1];
function dist(a, b) {
  const R = 6371, t = x => x * Math.PI / 180, dLa = t(b[0] - a[0]), dLo = t(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a[0])) * Math.cos(t(b[0])) * Math.sin(dLo / 2) ** 2;
  return Math.max(1, Math.round(2 * R * Math.asin(Math.sqrt(h)) * 1.3 * 10) / 10);
}

/* ---------- الحسابات ---------- */
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
const tokHash = t => crypto.createHash('sha256').update(t).digest('hex');
const pub = u => ({ phone: u.phone, name: u.name, role: u.role, plate: u.plate || null });
function newSession(phone) {
  const token = crypto.randomBytes(32).toString('hex'), now = Date.now();
  for (const k in sess) if (sess[k].exp < now) delete sess[k];
  sess[tokHash(token)] = { phone, exp: now + 30 * DAY };
  save(F.sess, sess);
  return token;
}
function auth(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (\S+)$/);
  if (!m) return null;
  const s = sess[tokHash(m[1])];
  return s && s.exp > Date.now() ? users[s.phone] || null : null;
}
const fails = {}; // حماية من تخمين الرمز السري
function locked(phone) { const f = fails[phone]; return f && f.n >= 5 && f.until > Date.now(); }
function fail(phone) { const f = fails[phone] || (fails[phone] = { n: 0, until: 0 }); f.n++; if (f.n >= 5) f.until = Date.now() + 10 * 60e3; }

/* ---------- عرض الرحلات: كل واحد يشوف اللي يخصه بس ---------- */
function view(r, u) {
  const o = { id: r.id, fromLL: r.fromLL, toLL: r.toLL, fromTxt: r.fromTxt, toTxt: r.toTxt, pax: r.pax, km: r.km,
    fare: r.fare, status: r.status, step: r.step, driverName: r.driverName, plate: r.plate, at: r.at };
  if (u.role === 'rider' && r.owner === u.phone) o.driverPhone = r.driverPhone || null;
  if (u.role === 'driver' && r.driver === u.phone) { o.phone = r.phone; o.mine = true; }
  return o;
}
function listFor(u) {
  if (u.role === 'rider') return rides.filter(r => r.owner === u.phone).slice(-20).map(r => view(r, u));
  return rides.filter(r => r.status === 'open' || r.driver === u.phone).slice(-40).map(r => view(r, u));
}

/* ---------- HTTP ---------- */
function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 10000) { no(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } });
  });
}

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return fs.readFile(path.join(__dirname, 'toktok.html'), (e, d) => {
      if (e) { res.writeHead(500); return res.end('toktok.html مش موجود جنب server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end(d);
    });
  }
  if (!p.startsWith('/api/')) { res.writeHead(404); return res.end(); }

  try {
    /* تسجيل جديد */
    if (req.method === 'POST' && p === '/api/register') {
      const b = await body(req), phone = normPhone(b.phone), pin = digits(b.pin);
      const name = str(b.name, 40), role = b.role === 'driver' ? 'driver' : b.role === 'rider' ? 'rider' : null;
      const plate = str(b.plate, 12);
      if (!phone) return send(res, 400, { error: 'اكتب رقم موبايل مصري صحيح (01xxxxxxxxx).' });
      if (!/^\d{4,8}$/.test(pin)) return send(res, 400, { error: 'الرمز السري من 4 لـ 8 أرقام.' });
      if (name.length < 2) return send(res, 400, { error: 'اكتب اسمك.' });
      if (!role) return send(res, 400, { error: 'اختار راكب ولا سواق.' });
      if (role === 'driver' && plate.length < 2) return send(res, 400, { error: 'اكتب رقم التوك توك أو اللوحة.' });
      if (users[phone]) return send(res, 409, { error: 'الرقم ده مسجّل قبل كده. سجّل دخول.' });
      const salt = crypto.randomBytes(16).toString('hex');
      users[phone] = { phone, name, role, plate: role === 'driver' ? plate : null, salt, hash: hashPin(pin, salt), at: Date.now() };
      save(F.users, users);
      return send(res, 201, { token: newSession(phone), user: pub(users[phone]) });
    }

    /* دخول */
    if (req.method === 'POST' && p === '/api/login') {
      const b = await body(req), phone = normPhone(b.phone), pin = digits(b.pin);
      if (!phone) return send(res, 400, { error: 'اكتب رقم موبايل مصري صحيح.' });
      if (locked(phone)) return send(res, 429, { error: 'محاولات كتير غلط. جرّب بعد 10 دقايق.' });
      const u = users[phone];
      const ok = u && crypto.timingSafeEqual(Buffer.from(hashPin(pin || '-', u.salt)), Buffer.from(u.hash));
      if (!ok) { fail(phone); return send(res, 401, { error: 'الرقم أو الرمز السري غلط.' }); }
      delete fails[phone];
      return send(res, 200, { token: newSession(phone), user: pub(u) });
    }

    /* من هنا لازم تكون مسجّل دخول */
    const u = auth(req);
    if (!u) return send(res, 401, { error: 'سجّل دخول الأول.' });

    if (req.method === 'POST' && p === '/api/logout') {
      const m = req.headers.authorization.match(/^Bearer (\S+)$/);
      delete sess[tokHash(m[1])]; save(F.sess, sess);
      return send(res, 200, {});
    }
    if (req.method === 'GET' && p === '/api/me') return send(res, 200, pub(u));
    if (req.method === 'GET' && p === '/api/rides') return send(res, 200, listFor(u));

    if (req.method === 'POST' && p === '/api/rides') {
      if (u.role !== 'rider') return send(res, 403, { error: 'الطلب للركاب بس.' });
      const b = await body(req);
      if (!inBounds(b.fromLL) || !inBounds(b.toLL)) return send(res, 400, { error: 'النقط لازم تكون جوه سوهاج.' });
      if (rides.some(r => r.owner === u.phone && r.status !== 'cancelled' && r.step < 4))
        return send(res, 409, { error: 'عندك رحلة شغّالة بالفعل.' });
      const km = dist(b.fromLL, b.toLL);
      const ride = {
        id: rides.reduce((m, r) => Math.max(m, r.id), 100) + 1, owner: u.phone, phone: u.phone,
        fromLL: b.fromLL, toLL: b.toLL,
        fromTxt: str(b.fromTxt, 80) || 'الموقع المحدد على الخريطة', toTxt: str(b.toTxt, 80) || 'الموقع المحدد على الخريطة',
        pax: Math.min(3, Math.max(1, parseInt(b.pax) || 1)), km, fare: Math.round(10 + km * 4),
        status: 'open', step: 0, driver: null, driverName: null, plate: null, driverPhone: null, at: Date.now()
      };
      rides.push(ride); persistRides();
      return send(res, 201, view(ride, u));
    }

    const m = p.match(/^\/api\/rides\/(\d+)\/(cancel|accept|advance)$/);
    if (req.method === 'POST' && m) {
      const id = +m[1], act = m[2], r = rides.find(x => x.id === id);
      if (!r) return send(res, 404, { error: 'الرحلة مش موجودة.' });
      if (act === 'cancel') {
        if (u.role !== 'rider' || r.owner !== u.phone || r.status !== 'open') return send(res, 409, { error: 'مينفعش تلغي دلوقتي.' });
        r.status = 'cancelled';
      } else if (act === 'accept') {
        if (u.role !== 'driver') return send(res, 403, { error: 'القبول للسواقين بس.' });
        if (r.status !== 'open') return send(res, 409, { error: 'سواق تاني قبل الرحلة دي.' });
        if (rides.some(x => x.driver === u.phone && x.status === 'taken' && x.step < 4))
          return send(res, 409, { error: 'خلّص رحلتك الحالية الأول.' });
        Object.assign(r, { status: 'taken', step: 1, driver: u.phone, driverName: u.name, plate: u.plate, driverPhone: u.phone });
      } else {
        if (u.role !== 'driver' || r.driver !== u.phone || r.step >= 4) return send(res, 409, { error: 'مينفعش.' });
        r.step++;
      }
      persistRides();
      return send(res, 200, view(r, u));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: 'طلب غير صالح.' });
  }
}).listen(PORT, '0.0.0.0', () => console.log('توك توك سوهاج شغّال على http://localhost:' + PORT));
