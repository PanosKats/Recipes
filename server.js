const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.RECIPES_FILE || path.join(__dirname, 'data', 'recipes.json');
const PHOTOS_DIR = path.join(path.dirname(DATA_FILE), 'photos');
const PUBLIC_DIR = path.join(__dirname, 'public');
const EDIT_CODE = process.env.EDIT_CODE || '12345678';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 8;
const SESSION_MS = 12 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const PHOTO_NAME = /^[\w-]+\.(jpg|svg)$/;
const CATEGORIES = ['breakfast', 'appetizer', 'main', 'side', 'salad', 'soup', 'dessert', 'dough', 'drink', 'other'];

// Everything lives under this path so the app can sit inside a larger website.
const BASE = '/recipes';
const RESERVED_SLUGS = new Set(['api', 'photos', 'new']);
const PAGE_ROUTE = /^\/recipes(?:\/([a-z0-9-]+)(\/edit)?)?$/;
const GREEK_LETTERS = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

const STATIC_FILES = {
  [`${BASE}/index.html`]: ['index.html', 'text/html; charset=utf-8'],
  [`${BASE}/styles.css`]: ['styles.css', 'text/css; charset=utf-8'],
  [`${BASE}/boot.js`]: ['boot.js', 'text/javascript; charset=utf-8'],
  [`${BASE}/i18n.js`]: ['i18n.js', 'text/javascript; charset=utf-8'],
  [`${BASE}/app.js`]: ['app.js', 'text/javascript; charset=utf-8'],
};

function placeholdersFor(id) {
  if (!fs.existsSync(PHOTOS_DIR)) return [];
  return fs.readdirSync(PHOTOS_DIR).filter((name) => name.startsWith(`placeholder-${id}-`)).sort();
}

// A damaged file stops startup here, so it can never be overwritten with an empty list.
function loadRecipes() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${DATA_FILE} does not contain a recipe list`);
  return parsed.map((recipe) => (Array.isArray(recipe.photos) ? recipe : { ...recipe, photos: placeholdersFor(recipe.id) }));
}

let recipes = loadRecipes();

// Write to a temp file first so a crash mid-save cannot corrupt the recipes.
function saveRecipes(next) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  const stillUsed = new Set(next.flatMap((recipe) => recipe.photos));
  const removed = recipes.flatMap((recipe) => recipe.photos).filter((name) => !stillUsed.has(name));
  recipes = next;
  for (const name of removed) fs.rm(path.join(PHOTOS_DIR, name), { force: true }, () => {});
}

// Links use the English name, falling back to the Greek name written in Latin letters.
function slugify(content) {
  const title = content.en.title || content.el.title || '';
  return title
    .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[α-ω]/g, (letter) => GREEK_LETTERS[letter] || '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '') || 'recipe';
}

const slugsOf = (list) => list.flatMap((recipe) => [recipe.slug, ...(recipe.previousSlugs || [])]).filter(Boolean);

function uniqueSlug(content, taken) {
  const base = slugify(content);
  let slug = base;
  for (let n = 2; taken.has(slug) || RESERVED_SLUGS.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

function withSlugs(list) {
  const taken = new Set(slugsOf(list));
  return list.map((recipe) => {
    if (recipe.slug) return recipe;
    const slug = uniqueSlug(recipe.content, taken);
    taken.add(slug);
    return { ...recipe, slug };
  });
}

if (recipes.some((recipe) => !recipe.slug)) saveRecipes(withSlugs(recipes));

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const codeDigest = sha256(EDIT_CODE);
const sessions = new Map();
let failures = [];

function isAuthorized(req) {
  const token = req.headers['x-edit-token'];
  const expires = sessions.get(token);
  if (!expires) return false;
  if (expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

async function handleUnlock(req, res) {
  const now = Date.now();
  failures = failures.filter((time) => now - time < FAILURE_WINDOW_MS);
  if (failures.length >= MAX_FAILURES) return sendJson(res, 429, { error: 'too_many_attempts' });
  const { code } = await readJson(req);
  if (typeof code !== 'string' || !crypto.timingSafeEqual(sha256(code), codeDigest)) {
    failures.push(now);
    return sendJson(res, 401, { error: 'wrong_code' });
  }
  for (const [token, expires] of sessions) if (expires < now) sessions.delete(token);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, now + SESSION_MS);
  return sendJson(res, 200, { token });
}

const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const cleanList = (value) =>
  (Array.isArray(value) ? value : []).map((item) => cleanText(item, 2000)).filter(Boolean).slice(0, 200);
const cleanNumber = (value, max) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : 0;
};
const cleanPhotos = (value) =>
  [...new Set(Array.isArray(value) ? value : [])]
    .filter((name) => typeof name === 'string' && PHOTO_NAME.test(name) && fs.existsSync(path.join(PHOTOS_DIR, name)))
    .slice(0, MAX_PHOTOS);

function cleanContent(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    title: cleanText(source.title, 200),
    ingredients: cleanList(source.ingredients),
    steps: cleanList(source.steps),
    notes: cleanText(source.notes, 5000),
  };
}

function cleanRecipe(body) {
  const en = cleanContent(body.content && body.content.en);
  const el = cleanContent(body.content && body.content.el);
  const hasBody = (c) => c.ingredients.length > 0 || c.steps.length > 0 || c.notes !== '';
  if ((!en.title && !el.title) || (!en.title && hasBody(en)) || (!el.title && hasBody(el))) return null;
  return {
    category: CATEGORIES.includes(body.category) ? body.category : 'other',
    prepMinutes: cleanNumber(body.prepMinutes, 10000),
    cookMinutes: cleanNumber(body.cookMinutes, 10000),
    servings: cleanNumber(body.servings, 1000),
    favorite: body.favorite === true,
    photos: cleanPhotos(body.photos),
    content: { en, el },
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, MAX_BODY_BYTES);
  try {
    const body = JSON.parse(raw.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Not an object');
    return body;
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

async function handlePhotoUpload(req, res) {
  if (req.headers['content-type'] !== 'image/jpeg') return sendJson(res, 415, { error: 'jpeg_required' });
  const data = await readBody(req, MAX_PHOTO_BYTES);
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
    return sendJson(res, 400, { error: 'invalid_image' });
  }
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  const name = `${crypto.randomUUID()}.jpg`;
  fs.writeFileSync(path.join(PHOTOS_DIR, name), data);
  return sendJson(res, 201, { name });
}

async function handleApi(req, res, pathname) {
  // Requiring JSON stops other websites from submitting forms to this server.
  const needsJson = ['POST', 'PUT'].includes(req.method) && pathname !== '/api/photos';
  if (needsJson && !(req.headers['content-type'] || '').startsWith('application/json')) {
    return sendJson(res, 415, { error: 'json_required' });
  }

  if (pathname === '/api/unlock') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    return handleUnlock(req, res);
  }

  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (!isRead && !isAuthorized(req)) return sendJson(res, 401, { error: 'code_required' });

  if (pathname === '/api/lock') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    sessions.delete(req.headers['x-edit-token']);
    return sendJson(res, 204);
  }

  if (pathname === '/api/photos') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    return handlePhotoUpload(req, res);
  }

  const match = pathname.match(/^\/api\/recipes(?:\/([\w-]+))?$/);
  if (!match) return sendJson(res, 404, { error: 'not_found' });
  const id = match[1];

  if (!id && req.method === 'GET') return sendJson(res, 200, recipes);

  if (!id && req.method === 'POST') {
    const clean = cleanRecipe(await readJson(req));
    if (!clean) return sendJson(res, 400, { error: 'title_required' });
    const now = new Date().toISOString();
    const slug = uniqueSlug(clean.content, new Set(slugsOf(recipes)));
    const recipe = { id: crypto.randomUUID(), slug, ...clean, createdAt: now, updatedAt: now };
    saveRecipes([...recipes, recipe]);
    return sendJson(res, 201, recipe);
  }

  if (!id) return sendJson(res, 405, { error: 'method_not_allowed' });
  const existing = recipes.find((recipe) => recipe.id === id);
  if (!existing) return sendJson(res, 404, { error: 'not_found' });

  if (req.method === 'GET') return sendJson(res, 200, existing);

  if (req.method === 'PUT') {
    const clean = cleanRecipe(await readJson(req));
    if (!clean) return sendJson(res, 400, { error: 'title_required' });
    const updated = { ...existing, ...clean, updatedAt: new Date().toISOString() };
    // A renamed recipe gets a new link, and its old link keeps working as a redirect.
    if (slugify(clean.content) !== slugify(existing.content)) {
      const others = recipes.filter((recipe) => recipe.id !== id);
      updated.slug = uniqueSlug(clean.content, new Set(slugsOf(others)));
      updated.previousSlugs = [...new Set([...(existing.previousSlugs || []), existing.slug])]
        .filter((slug) => slug !== updated.slug);
    }
    saveRecipes(recipes.map((recipe) => (recipe.id === id ? updated : recipe)));
    return sendJson(res, 200, updated);
  }

  if (req.method === 'DELETE') {
    saveRecipes(recipes.filter((recipe) => recipe.id !== id));
    return sendJson(res, 204);
  }

  return sendJson(res, 405, { error: 'method_not_allowed' });
}

function handlePhoto(res, name) {
  const file = PHOTO_NAME.test(name) ? path.join(PHOTOS_DIR, name) : null;
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': name.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg',
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  fs.createReadStream(file).pipe(res);
}

function redirect(res, status, location) {
  res.writeHead(status, { Location: location });
  res.end();
}

function handlePage(res, pathname) {
  if (pathname === '/') return redirect(res, 302, BASE);
  if (pathname.startsWith(`${BASE}/`) && pathname.endsWith('/')) {
    return redirect(res, 301, pathname.replace(/\/+$/, ''));
  }
  const route = pathname.match(PAGE_ROUTE);
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const [, slug, edit = ''] = route;
  if (!slug || (slug === 'new' && !edit)) return handleStatic(res, `${BASE}/index.html`);
  if (recipes.some((recipe) => recipe.slug === slug)) return handleStatic(res, `${BASE}/index.html`);
  const renamed = recipes.find((recipe) => (recipe.previousSlugs || []).includes(slug));
  if (renamed) return redirect(res, 302, `${BASE}/${renamed.slug}${edit}`);
  return handleStatic(res, `${BASE}/index.html`, 404);
}

function handleStatic(res, pathname, status = 200) {
  const [file, type] = STATIC_FILES[pathname];
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  fs.createReadStream(path.join(PUBLIC_DIR, file)).pipe(res);
}

// When hosted, set ALLOWED_HOSTS to the site's domain, for example "recipes.example.com".
const allowedHosts = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  ...(process.env.ALLOWED_HOSTS || '').split(',').map((host) => host.trim()).filter(Boolean),
]);

const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname.startsWith(`${BASE}/api/`)) return await handleApi(req, res, pathname.slice(BASE.length));
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    if (pathname.startsWith(`${BASE}/photos/`)) return handlePhoto(res, pathname.slice(`${BASE}/photos/`.length));
    if (STATIC_FILES[pathname]) return handleStatic(res, pathname);
    return handlePage(res, pathname);
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: 'request_failed' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Recipe app running at http://localhost:${PORT}${BASE}`);
  console.log(`Recipes are saved in ${DATA_FILE}`);
  if (!process.env.EDIT_CODE) console.log('Using the default edit code. Set EDIT_CODE before publishing.');
});
