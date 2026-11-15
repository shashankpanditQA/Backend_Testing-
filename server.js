const express = require('express'), path = require('path'), Database = require('better-sqlite3'),
  jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs'), swagger = require('swagger-ui-express');
const SECRET = process.env.JWT_SECRET || 'dev-secret', PORT = process.env.PORT || 3000;
const TYPES = ['Savings', 'Current', 'Salary'], STATUS = ['Active', 'Inactive', 'Closed'], TT = ['DEPOSIT', 'WITHDRAWAL'];

// ---------- DB schema (starts empty: no seed data) ----------
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'bank.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY AUTOINCREMENT,userId INTEGER NOT NULL REFERENCES users(id),
 accountType TEXT,accountNumber TEXT,accountHolderName TEXT,email TEXT,mobileNumber TEXT,panNumber TEXT,aadhaarNumber TEXT,
 balance REAL DEFAULT 0,status TEXT,data TEXT,createdAt TEXT,
 UNIQUE(userId,accountNumber),UNIQUE(userId,email),UNIQUE(userId,panNumber),UNIQUE(userId,aadhaarNumber));
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,userId INTEGER NOT NULL,accountId INTEGER NOT NULL REFERENCES accounts(id),
 transactionType TEXT,amount REAL,description TEXT,status TEXT,idempotencyKey TEXT,balanceAfter REAL,createdAt TEXT,UNIQUE(userId,idempotencyKey));`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const err = (res, code, msg, details) => res.status(code).json({ error: msg, ...(details && { details }) });
const now = () => new Date().toISOString();
const n = v => (v === undefined || v === null || v === '' ? null : String(v));

const auth = (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return err(res, 401, 'Missing or malformed Authorization header');
  try { req.user = jwt.verify(h.slice(7), SECRET); next(); } catch { err(res, 401, 'Invalid or expired token'); }
};

// ---------- Auth ----------
app.post('/auth/register', (req, res) => {
  const { name, email, password } = req.body || {}, e = [];
  if (!name) e.push('name is required');
  if (!/^\S+@\S+\.\S+$/.test(email || '')) e.push('valid email is required');
  if (!password || String(password).length < 6) e.push('password must be at least 6 characters');
  if (e.length) return err(res, 400, 'Validation failed', e);
  const em = email.toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(em)) return err(res, 400, 'Email already registered');
  const r = db.prepare('INSERT INTO users(name,email,password) VALUES(?,?,?)').run(name, em, bcrypt.hashSync(String(password), 8));
  res.status(201).json({ userId: r.lastInsertRowid, name, email: em });
});
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password)) return err(res, 401, 'Invalid email or password');
  res.json({ token: jwt.sign({ id: u.id, email: u.email }, SECRET, { expiresIn: '2h' }), userId: u.id });
});
app.post('/auth/logout', auth, (req, res) => res.json({ message: 'Logged out. Discard the token client-side.' }));

app.get('/dashboard', auth, (req, res) => {
  const c = t => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE userId=?`).get(req.user.id).c;
  res.json({ accounts: c('accounts'), transactions: c('transactions'),
    totalBalance: db.prepare('SELECT COALESCE(SUM(balance),0) s FROM accounts WHERE userId=?').get(req.user.id).s });
});

// ---------- Helpers ----------
const fmt = r => { const { userId, data, ...f } = r, d = JSON.parse(data || '{}');
  return { ...f, customer: d.customer || {}, kycDocuments: d.kycDocuments || [], nominees: d.nominees || [] }; };
const ftx = ({ userId, ...r }) => r;
// ownership: 400 bad id, 404 missing, 403 another user's record
const own = (t, req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id) || id < 1) { err(res, 400, 'Invalid id'); return; }
  const r = db.prepare(`SELECT * FROM ${t} WHERE id=?`).get(id);
  if (!r) { err(res, 404, 'Not found'); return; }
  if (r.userId !== req.user.id) { err(res, 403, 'Forbidden: record belongs to another user'); return; }
  return r;
};
const list = (t, sc, fl, cols, f) => (req, res) => {
  const q = req.query, w = ['userId=?'], p = [req.user.id];
  if (q.search) { w.push('(' + sc.map(c => c + ' LIKE ?').join(' OR ') + ')'); sc.forEach(() => p.push('%' + q.search + '%')); }
  fl.forEach(k => { if (q[k]) { w.push(k + '=?'); p.push(q[k]); } });
  const sb = cols.includes(q.sortBy) ? q.sortBy : 'id', o = q.order === 'desc' ? 'DESC' : 'ASC',
    lim = Math.min(Math.max(+q.limit || 10, 1), 100), pg = Math.max(+q.page || 1, 1), W = w.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${W}`).get(...p).c;
  res.json({ data: db.prepare(`SELECT * FROM ${t} WHERE ${W} ORDER BY ${sb} ${o} LIMIT ? OFFSET ?`).all(...p, lim, (pg - 1) * lim).map(f),
    page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) });
};

// normalise + validate an account body (flat fields or nested customer/kyc/contacts)
function norm(b) {
  const c = b.customer && typeof b.customer === 'object' ? b.customer : {}, contacts = c.contacts || [], addr = c.addresses || [],
    kyc = b.kycDocuments || [], nom = b.nominees || [];
  if (![contacts, addr, kyc, nom].every(Array.isArray)) return { e: ['customer.contacts, customer.addresses, kycDocuments and nominees must be arrays'] };
  const k = t => (kyc.find(x => String(x.type).toUpperCase() === t) || {}).number, ct = t => (contacts.find(x => x.type === t) || {}).value;
  const f = { accountType: b.accountType, accountNumber: n(b.accountNumber), accountHolderName: n(b.accountHolderName || c.name),
    email: n(b.email || ct('Email')), mobileNumber: n(b.mobileNumber || ct('Mobile')), panNumber: n(b.panNumber || k('PAN')),
    aadhaarNumber: n(b.aadhaarNumber || k('AADHAAR')), balance: b.balance === undefined ? 0 : b.balance, status: b.status || 'Active' };
  const e = [];
  if (!TYPES.includes(f.accountType)) e.push('accountType must be one of ' + TYPES.join(','));
  ['accountNumber', 'accountHolderName', 'email'].forEach(x => !f[x] && e.push(x + ' is required'));
  if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) e.push('email is invalid');
  if (f.mobileNumber && !/^\d{10}$/.test(f.mobileNumber)) e.push('mobileNumber must be 10 digits');
  if (f.panNumber && !/^[A-Z]{5}\d{4}[A-Z]$/.test(f.panNumber)) e.push('panNumber is invalid (e.g. ABCDE1234F)');
  if (f.aadhaarNumber && !/^\d{12}$/.test(f.aadhaarNumber)) e.push('aadhaarNumber must be 12 digits');
  if (typeof f.balance !== 'number' || f.balance < 0) e.push('balance must be a non-negative number');
  if (!STATUS.includes(f.status)) e.push('status must be one of ' + STATUS.join(','));
  if (nom.length && nom.reduce((s, x) => s + Number(x.percentage || 0), 0) !== 100) e.push('nominee percentages must total 100');
  return { f, e, d: { customer: { ...c, name: c.name || f.accountHolderName, contacts, addresses: addr }, kycDocuments: kyc, nominees: nom } };
}
const dup = (uid, f, id) => [['accountNumber', 'Account number'], ['email', 'Email'], ['panNumber', 'PAN'], ['aadhaarNumber', 'Aadhaar']]
  .filter(([k]) => f[k] && db.prepare(`SELECT 1 FROM accounts WHERE userId=? AND ${k}=? AND id!=?`).get(uid, f[k], id))
  .map(([, l]) => l + ' already exists');

function save(req, res, r) {
  let b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return err(res, 400, 'Request body must be a JSON object');
  if (r && req.method === 'PATCH') b = { ...fmt(r), ...b };
  const { f, e, d } = norm(b);
  if (e.length) return err(res, 400, 'Validation failed', e);
  const D = dup(req.user.id, f, r ? r.id : 0);
  if (D.length) return err(res, 400, D[0], D);
  const p = { ...f, data: JSON.stringify(d), id: r && r.id, userId: req.user.id, createdAt: now() };
  if (r) {
    db.prepare('UPDATE accounts SET accountType=@accountType,accountNumber=@accountNumber,accountHolderName=@accountHolderName,email=@email,mobileNumber=@mobileNumber,panNumber=@panNumber,aadhaarNumber=@aadhaarNumber,balance=@balance,status=@status,data=@data WHERE id=@id').run(p);
    return res.json(fmt(db.prepare('SELECT * FROM accounts WHERE id=?').get(r.id)));
  }
  const i = db.prepare('INSERT INTO accounts(userId,accountType,accountNumber,accountHolderName,email,mobileNumber,panNumber,aadhaarNumber,balance,status,data,createdAt) VALUES(@userId,@accountType,@accountNumber,@accountHolderName,@email,@mobileNumber,@panNumber,@aadhaarNumber,@balance,@status,@data,@createdAt)').run(p);
  res.status(201).json(fmt(db.prepare('SELECT * FROM accounts WHERE id=?').get(i.lastInsertRowid)));
}

// ---------- Accounts ----------
app.post('/accounts', auth, (req, res) => save(req, res, null));
app.get('/accounts', auth, list('accounts', ['accountNumber', 'accountHolderName', 'email'], ['status', 'accountType'],
  ['id', 'accountNumber', 'accountHolderName', 'balance', 'accountType', 'status', 'createdAt'], fmt));
app.get('/accounts/:id', auth, (req, res) => { const r = own('accounts', req, res); r && res.json(fmt(r)); });
app.put('/accounts/:id', auth, (req, res) => { const r = own('accounts', req, res); r && save(req, res, r); });
app.patch('/accounts/:id', auth, (req, res) => { const r = own('accounts', req, res); r && save(req, res, r); });
app.delete('/accounts/:id', auth, (req, res) => {
  const r = own('accounts', req, res); if (!r) return;
  db.transaction(() => { db.prepare('DELETE FROM transactions WHERE accountId=?').run(r.id); db.prepare('DELETE FROM accounts WHERE id=?').run(r.id); })();
  res.json({ message: 'Account deleted', id: r.id });
});

// ---------- Transactions (with Idempotency-Key) ----------
app.post('/transactions', auth, (req, res) => {
  const b = req.body || {}, u = req.user.id, key = req.get('Idempotency-Key') || null, e = [], aid = +b.accountId;
  if (!Number.isInteger(aid) || aid < 1) e.push('accountId is required');
  if (!TT.includes(b.transactionType)) e.push('transactionType must be DEPOSIT or WITHDRAWAL');
  if (typeof b.amount !== 'number' || !(b.amount > 0)) e.push('amount must be a positive number');
  if (e.length) return err(res, 400, 'Validation failed', e);
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(aid);
  if (!a) return err(res, 404, 'Account not found');
  if (a.userId !== u) return err(res, 403, 'Forbidden: account belongs to another user');
  const desc = b.description || '';
  if (key) {
    const x = db.prepare('SELECT * FROM transactions WHERE userId=? AND idempotencyKey=?').get(u, key);
    if (x) {
      if (x.accountId === aid && x.transactionType === b.transactionType && x.amount === b.amount && x.description === desc) {
        res.set('Idempotent-Replay', 'true'); return res.status(200).json(ftx(x)); // same key + same request => same txn, no balance change
      }
      return err(res, 400, 'Duplicate Idempotency-Key used with a different request');
    }
  } else if (db.prepare('SELECT 1 FROM transactions WHERE userId=? AND accountId=? AND transactionType=? AND amount=? AND description=? AND createdAt>?')
    .get(u, aid, b.transactionType, b.amount, desc, new Date(Date.now() - 5000).toISOString()))
    return err(res, 400, 'Duplicate transaction request (identical request within 5 seconds)');
  if (a.status !== 'Active') return err(res, 400, 'Account is not Active');
  const nb = a.balance + (b.transactionType === 'DEPOSIT' ? b.amount : -b.amount);
  if (nb < 0) return err(res, 400, 'Insufficient balance');
  const r = db.transaction(() => {
    db.prepare('UPDATE accounts SET balance=? WHERE id=?').run(nb, aid);
    return db.prepare('INSERT INTO transactions(userId,accountId,transactionType,amount,description,status,idempotencyKey,balanceAfter,createdAt) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(u, aid, b.transactionType, b.amount, desc, 'SUCCESS', key, nb, now());
  })();
  res.status(201).json(ftx(db.prepare('SELECT * FROM transactions WHERE id=?').get(r.lastInsertRowid)));
});
app.get('/transactions', auth, list('transactions', ['description'], ['accountId', 'transactionType', 'status'],
  ['id', 'accountId', 'amount', 'createdAt', 'transactionType'], ftx));
app.get('/transactions/:id', auth, (req, res) => { const r = own('transactions', req, res); r && res.json(ftx(r)); });

// ---------- Swagger + Postman (generated from one operation list) ----------
const SAMPLE = { accountType: 'Savings', accountNumber: 'ACC10001', email: 'john@example.com',
  customer: { name: 'John Smith', contacts: [{ type: 'Mobile', value: '9999999999', primary: true }], addresses: [{ type: 'Permanent', city: 'Delhi', state: 'Delhi' }] },
  kycDocuments: [{ type: 'PAN', number: 'ABCDE1234F', verified: true }], nominees: [{ name: 'Alex', relation: 'Brother', percentage: 100 }] };
const BODY = { 'post /auth/register': { name: 'UserA', email: 'usera@test.com', password: 'Pass@123' }, 'post /auth/login': { email: 'usera@test.com', password: 'Pass@123' },
  'post /accounts': SAMPLE, 'put /accounts/{id}': SAMPLE, 'patch /accounts/{id}': { status: 'Inactive' },
  'post /transactions': { accountId: 1, transactionType: 'DEPOSIT', amount: 5000, description: 'Salary Credit' } };
const ops = [['post', '/auth/register', 0], ['post', '/auth/login', 0], ['post', '/auth/logout', 1], ['get', '/dashboard', 1],
  ['post', '/accounts', 1], ['get', '/accounts', 1], ['get', '/accounts/{id}', 1], ['put', '/accounts/{id}', 1], ['patch', '/accounts/{id}', 1], ['delete', '/accounts/{id}', 1],
  ['post', '/transactions', 1], ['get', '/transactions', 1], ['get', '/transactions/{id}', 1]];
const paths = {};
ops.forEach(([m, p, s]) => {
  const b = BODY[m + ' ' + p];
  (paths[p] = paths[p] || {})[m] = { summary: m.toUpperCase() + ' ' + p, security: s ? [{ bearer: [] }] : [],
    parameters: [...(p.includes('{id}') ? [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] : []),
      ...(p === '/transactions' && m === 'post' ? [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }] : []),
      ...(m === 'get' && !p.includes('{id}') && p !== '/dashboard' ? ['page', 'limit', 'search', 'sortBy', 'order'].map(name => ({ name, in: 'query', schema: { type: 'string' } })) : [])],
    ...(b && { requestBody: { content: { 'application/json': { schema: { type: 'object' }, example: b } } } }),
    responses: { 200: { description: 'OK' }, 400: { description: 'Bad Request' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Not Found' } } };
});
app.use('/api-docs', swagger.serve, swagger.setup({ openapi: '3.0.0', info: { title: 'Banking API', version: '1.0' },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } }, paths }));
app.get('/postman.json', (q, res) => res.json({
  info: { name: 'Banking API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: 'http://localhost:' + PORT }, { key: 'token', value: '' }, { key: 'id', value: '1' }],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  item: ops.map(([m, p, s]) => { const b = BODY[m + ' ' + p]; return { name: m.toUpperCase() + ' ' + p,
    request: { method: m.toUpperCase(), auth: s ? undefined : { type: 'noauth' },
      header: [...(b ? [{ key: 'Content-Type', value: 'application/json' }] : []), ...(p === '/transactions' && m === 'post' ? [{ key: 'Idempotency-Key', value: 'txn-12345' }] : [])],
      url: '{{baseUrl}}' + p.replace('{id}', '{{id}}'), ...(b && { body: { mode: 'raw', raw: JSON.stringify(b, null, 1) } }) },
    ...(p === '/auth/login' && { event: [{ listen: 'test', script: { exec: ['pm.collectionVariables.set("token", pm.response.json().token)'] } }] }) }; }) }));

app.use((e, req, res, next) => e.type === 'entity.parse.failed' ? err(res, 400, 'Invalid JSON body') : (console.error(e), err(res, 500, 'Internal server error')));
app.listen(PORT, () => console.log(`App: http://localhost:${PORT}  Swagger: /api-docs  Postman: /postman.json`));
