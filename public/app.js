'use strict';

const CATEGORIES = ['breakfast', 'appetizer', 'main', 'side', 'salad', 'soup', 'dessert', 'dough', 'drink', 'other'];
const LANGS = { en: 'English', el: 'Ελληνικά' };
const MAX_PHOTOS = 8;
const MAX_PHOTO_SIDE = 1600;
const BASE = '/recipes';
const app = document.getElementById('app');

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* preference just won't persist */ } },
};

// Kept per tab, so closing the browser tab locks editing again.
const tokenStore = {
  get() { try { return sessionStorage.getItem('recipe-token'); } catch { return null; } },
  set(value) {
    try {
      if (value) sessionStorage.setItem('recipe-token', value);
      else sessionStorage.removeItem('recipe-token');
    } catch { /* the token just lasts until reload */ }
  },
};

function initialLang() {
  const saved = store.get('recipe-lang');
  return saved === 'en' || saved === 'el' ? saved : 'el';
}

const state = {
  lang: initialLang(),
  token: tokenStore.get(),
  recipes: [],
  loadFailed: false,
  query: '',
  filter: 'all',
  form: null,
  pageTitle: null,
  lastPath: location.pathname,
};

const recipeUrl = (recipe) => `${BASE}/${recipe.slug}`;
const editUrl = (recipe) => `${recipeUrl(recipe)}/edit`;

const t = (key, vars = {}) =>
  String(I18N[state.lang][key]).replace(/\{(\w+)\}/g, (_, name) => vars[name]);
const categoryName = (key) => I18N[state.lang].categories[key] || key;
const otherLang = (lang) => (lang === 'en' ? 'el' : 'en');

// Greek search ignores accents and final sigma, so "μουσακας" finds "Μουσακάς".
const normalize = (text) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

class Cancelled extends Error {}

function setToken(token) {
  state.token = token;
  tokenStore.set(token);
  renderChrome();
}

let codePrompt = null;

function askCode() {
  if (codePrompt) return codePrompt;
  const el = (id) => document.getElementById(id);
  const dialog = el('code-dialog');
  const form = el('code-form');
  const input = el('code-input');
  const error = el('code-error');
  const submit = el('code-submit');
  const cancel = el('code-cancel');
  el('code-title').textContent = t('codeTitle');
  el('code-text').textContent = t('codeText');
  el('code-label').textContent = t('codeLabel');
  submit.textContent = t('unlock');
  submit.disabled = false;
  cancel.textContent = t('cancel');
  input.value = '';
  error.hidden = true;

  codePrompt = new Promise((resolve) => {
    const finish = (unlocked) => {
      form.onsubmit = null;
      cancel.onclick = null;
      dialog.oncancel = null;
      input.value = '';
      dialog.close();
      codePrompt = null;
      resolve(unlocked);
    };
    cancel.onclick = () => finish(false);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    form.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      let message = 'codeError';
      try {
        const response = await fetch(`${BASE}/api/unlock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: input.value }),
        });
        if (response.ok) {
          setToken((await response.json()).token);
          finish(true);
          return;
        }
        if (response.status === 401) message = 'codeWrong';
        if (response.status === 429) message = 'codeLocked';
      } catch { /* shown as codeError */ }
      error.textContent = t(message);
      error.hidden = false;
      submit.disabled = false;
      input.select();
    };
    dialog.showModal();
    input.focus();
  });
  return codePrompt;
}

const ensureUnlocked = async () => Boolean(state.token) || askCode();

function send(url, options) {
  const headers = {};
  if (typeof options.body === 'string') headers['Content-Type'] = 'application/json';
  if (options.body instanceof Blob) headers['Content-Type'] = options.body.type;
  if (state.token) headers['X-Edit-Token'] = state.token;
  return fetch(url, { ...options, headers });
}

// If the session has expired, ask for the code and retry so no work is lost.
async function request(url, options = {}) {
  let response = await send(url, options);
  if (response.status === 401) {
    setToken(null);
    if (!(await askCode())) throw new Cancelled();
    response = await send(url, options);
  }
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

const api = (path, options) => request(`${BASE}/api/recipes${path}`, options);
const photoUrl = (name) => `${BASE}/photos/${encodeURIComponent(name)}`;
const photosOf = (recipe) => recipe.photos || [];

// Re-encoding shrinks large photos and strips hidden data such as GPS location.
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))), 'image/jpeg', 0.85);
  });
}

function view(recipe) {
  const own = recipe.content[state.lang];
  if (own.title) return { text: own, translated: true };
  return { text: recipe.content[otherLang(state.lang)], translated: false };
}

function formatMinutes(total) {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts = [];
  if (hours) parts.push(`${hours} ${t('hour')}`);
  if (minutes) parts.push(`${minutes} ${t('min')}`);
  return parts.join(' ');
}

const formatServings = (n) => (n === 1 ? t('servingOne') : t('servingMany', { n }));

function matches(recipe) {
  if (state.filter === 'favorites' && !recipe.favorite) return false;
  if (CATEGORIES.includes(state.filter) && recipe.category !== state.filter) return false;
  const query = normalize(state.query.trim());
  if (!query) return true;
  const haystack = ['en', 'el']
    .flatMap((lang) => [recipe.content[lang].title, ...recipe.content[lang].ingredients])
    .join('\n');
  return normalize(haystack).includes(query);
}

async function toggleFavorite(recipe) {
  const updated = await api(`/${recipe.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...recipe, favorite: !recipe.favorite }),
  });
  state.recipes = state.recipes.map((item) => (item.id === updated.id ? updated : item));
}

function favoriteButton(recipe, onDone) {
  const label = recipe.favorite ? t('removeFavorite') : t('addFavorite');
  return h('button', {
    type: 'button',
    class: `icon-btn${recipe.favorite ? ' is-on' : ''}`,
    'aria-label': label,
    'aria-pressed': String(recipe.favorite),
    title: label,
    onclick: async () => {
      if (!(await ensureUnlocked())) return;
      try {
        await toggleFavorite(recipe);
        onDone();
      } catch (error) {
        if (!(error instanceof Cancelled)) alert(t('saveError'));
      }
    },
  }, recipe.favorite ? '★' : '☆');
}

function recipeCard(recipe) {
  const { text } = view(recipe);
  const time = recipe.prepMinutes + recipe.cookMinutes;
  const meta = [time ? formatMinutes(time) : '', recipe.servings ? formatServings(recipe.servings) : '']
    .filter(Boolean).join(' · ');
  const cover = photosOf(recipe)[0];
  return h('article', { class: 'card' },
    cover ? h('img', { class: 'card-photo', src: photoUrl(cover), alt: '', loading: 'lazy' }) : null,
    h('div', { class: 'card-cat' }, categoryName(recipe.category)),
    h('h2', {}, h('a', { href: recipeUrl(recipe) }, text.title)),
    h('div', { class: 'card-meta' }, meta),
    favoriteButton(recipe, renderResults));
}

let resultsNode = null;
let countNode = null;

function renderResults() {
  if (!resultsNode) return;
  const list = state.recipes
    .filter(matches)
    .sort((a, b) => view(a).text.title.localeCompare(view(b).text.title, state.lang));
  countNode.textContent = list.length === 1 ? t('recipeOne') : t('recipeMany', { n: list.length });

  if (!state.recipes.length) {
    resultsNode.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, t('emptyTitle')),
      h('p', {}, t('emptyText')),
      h('a', { class: 'btn btn-primary', href: `${BASE}/new` }, t('newRecipe'))));
  } else if (!list.length) {
    resultsNode.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, t('noMatchTitle')),
      h('p', {}, t('noMatchText')),
      h('button', {
        type: 'button',
        class: 'btn',
        onclick: () => { state.query = ''; state.filter = 'all'; render(); },
      }, t('clearFilters'))));
  } else {
    resultsNode.replaceChildren(h('div', { class: 'grid' }, list.map(recipeCard)));
  }
}

function renderList() {
  const used = CATEGORIES.filter((key) => state.recipes.some((recipe) => recipe.category === key));
  if (CATEGORIES.includes(state.filter) && !used.includes(state.filter)) state.filter = 'all';
  const filters = [['all', t('all')], ['favorites', `★ ${t('favorites')}`], ...used.map((key) => [key, categoryName(key)])];

  countNode = h('p', { class: 'count', 'aria-live': 'polite' });
  resultsNode = h('div');
  app.className = 'page';
  app.replaceChildren(
    h('div', { class: 'list-head' },
      h('div', {}, h('h1', {}, t('appName')), countNode),
      h('a', { class: 'btn btn-primary', href: `${BASE}/new` }, `+ ${t('newRecipe')}`)),
    h('input', {
      class: 'search',
      type: 'search',
      placeholder: t('search'),
      'aria-label': t('search'),
      value: state.query,
      oninput: (event) => { state.query = event.target.value; renderResults(); },
    }),
    h('div', { class: 'chips' }, filters.map(([key, label]) => h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(state.filter === key),
      onclick: () => { state.filter = key; renderList(); },
    }, label))),
    resultsNode);
  renderResults();
}

function renderNotFound() {
  app.className = 'page page-narrow';
  app.replaceChildren(h('div', { class: 'empty' },
    h('h2', {}, t('notFound')),
    h('a', { class: 'btn', href: BASE }, t('back'))));
}

function fact(label, value) {
  return h('div', { class: 'fact' }, h('dt', {}, label), h('dd', {}, value));
}

function gallery(recipe, title) {
  const photos = photosOf(recipe);
  if (!photos.length) return '';
  const main = h('img', { class: 'hero-photo', src: photoUrl(photos[0]), alt: title });
  if (photos.length === 1) return h('div', { class: 'gallery' }, main);
  const thumbs = photos.map((name, index) => h('button', {
    type: 'button',
    class: 'thumb',
    'aria-label': t('photo', { n: index + 1 }),
    'aria-pressed': String(index === 0),
    onclick: (event) => {
      main.src = photoUrl(name);
      thumbs.forEach((thumb) => thumb.setAttribute('aria-pressed', String(thumb === event.currentTarget)));
    },
  }, h('img', { src: photoUrl(name), alt: '', loading: 'lazy' })));
  return h('div', { class: 'gallery' }, main, h('div', { class: 'thumbs' }, thumbs));
}

// The page title becomes the suggested file name when saving as PDF.
function printRecipe(title) {
  const previous = document.title;
  document.title = title;
  window.addEventListener('afterprint', () => { document.title = previous; }, { once: true });
  window.print();
}

function renderRecipe(id) {
  const recipe = state.recipes.find((item) => item.id === id);
  if (!recipe) return renderNotFound();
  const { text, translated } = view(recipe);
  const facts = [
    recipe.prepMinutes && fact(t('prep'), formatMinutes(recipe.prepMinutes)),
    recipe.cookMinutes && fact(t('cook'), formatMinutes(recipe.cookMinutes)),
    recipe.prepMinutes && recipe.cookMinutes && fact(t('total'), formatMinutes(recipe.prepMinutes + recipe.cookMinutes)),
    recipe.servings && fact(t('servings'), recipe.servings),
  ].filter(Boolean);
  const textLang = translated ? state.lang : otherLang(state.lang);
  state.pageTitle = `${text.title} · ${t('appName')}`;
  document.title = state.pageTitle;

  app.className = 'page page-narrow';
  app.replaceChildren(
    h('a', { class: 'back', href: BASE }, `← ${t('back')}`),
    gallery(recipe, text.title),
    h('div', { class: 'recipe-cat' }, categoryName(recipe.category)),
    h('div', { class: 'recipe-head' },
      h('h1', { lang: textLang }, text.title),
      favoriteButton(recipe, () => renderRecipe(id))),
    translated ? '' : h('div', { class: 'notice' },
      h('span', {}, t('onlyOther')),
      h('a', { href: editUrl(recipe) }, t('addTranslation'))),
    facts.length ? h('dl', { class: 'facts' }, facts) : '',
    h('div', { class: 'recipe-body', lang: textLang },
      h('section', {},
        h('h2', { lang: state.lang }, t('ingredients')),
        h('ul', { class: 'ingredients' }, text.ingredients.map((item) => h('li', {}, item)))),
      h('section', {},
        h('h2', { lang: state.lang }, t('steps')),
        h('ol', { class: 'steps' }, text.steps.map((item) => h('li', {}, item))))),
    text.notes ? h('section', { class: 'recipe-notes', lang: textLang },
      h('h2', { lang: state.lang }, t('notes')),
      h('p', {}, text.notes)) : '',
    h('div', { class: 'recipe-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => printRecipe(text.title) }, t('print')),
      h('a', { class: 'btn', href: editUrl(recipe) }, t('edit')),
      h('button', { type: 'button', class: 'btn btn-danger', onclick: () => deleteRecipe(recipe) }, t('delete'))));
}

function confirmDelete(title) {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-title').textContent = t('deleteTitle');
  document.getElementById('confirm-text').textContent = t('deleteText', { title });
  const ok = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
  ok.textContent = t('delete');
  cancel.textContent = t('cancel');
  return new Promise((resolve) => {
    const finish = (result) => {
      ok.onclick = null;
      cancel.onclick = null;
      dialog.oncancel = null;
      dialog.close();
      resolve(result);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.showModal();
    cancel.focus();
  });
}

async function deleteRecipe(recipe) {
  if (!(await ensureUnlocked())) return;
  if (!(await confirmDelete(view(recipe).text.title))) return;
  try {
    await api(`/${recipe.id}`, { method: 'DELETE' });
    state.recipes = state.recipes.filter((item) => item.id !== recipe.id);
    navigate(BASE);
  } catch (error) {
    if (!(error instanceof Cancelled)) alert(t('deleteError'));
  }
}

const toLines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

function draftFrom(recipe) {
  const langDraft = (lang) => {
    const c = recipe ? recipe.content[lang] : { title: '', ingredients: [], steps: [], notes: '' };
    return { title: c.title, ingredients: c.ingredients.join('\n'), steps: c.steps.join('\n'), notes: c.notes };
  };
  return {
    id: recipe ? recipe.id : null,
    favorite: recipe ? recipe.favorite : false,
    category: recipe ? recipe.category : 'main',
    prepMinutes: recipe && recipe.prepMinutes ? String(recipe.prepMinutes) : '',
    cookMinutes: recipe && recipe.cookMinutes ? String(recipe.cookMinutes) : '',
    servings: recipe && recipe.servings ? String(recipe.servings) : '',
    photos: recipe ? photosOf(recipe).map((name) => ({ name, url: photoUrl(name) })) : [],
    photoError: null,
    content: { en: langDraft('en'), el: langDraft('el') },
    tab: state.lang, // A recipe missing this language opens ready to translate.
    dirty: false,
    saving: false,
    errorLang: null,
    saveFailed: false,
  };
}

function missingTitleLang(form) {
  const hasBody = (c) => c.ingredients.trim() || c.steps.trim() || c.notes.trim();
  const { en, el } = form.content;
  if (!en.title.trim() && !el.title.trim()) return form.tab;
  if (!en.title.trim() && hasBody(en)) return 'en';
  if (!el.title.trim() && hasBody(el)) return 'el';
  return null;
}

async function addPhotos(form, files) {
  form.photoError = null;
  for (const file of files) {
    if (form.photos.length >= MAX_PHOTOS) {
      form.photoError = 'photoLimit';
      break;
    }
    try {
      const blob = await prepareImage(file);
      form.photos.push({ blob, url: URL.createObjectURL(blob) });
      form.dirty = true;
    } catch {
      form.photoError = 'photoError';
    }
  }
  if (state.form === form) renderForm();
}

function removePhoto(form, photo) {
  form.photos = form.photos.filter((item) => item !== photo);
  if (photo.blob) URL.revokeObjectURL(photo.url);
  form.dirty = true;
  renderForm();
}

function makeCover(form, photo) {
  form.photos = [photo, ...form.photos.filter((item) => item !== photo)];
  form.dirty = true;
  renderForm();
}

function photoPanel(form) {
  return h('section', { class: 'panel' },
    h('h2', {}, t('photos')),
    h('p', { class: 'panel-help' }, t('photosHelp')),
    form.photos.length ? h('div', { class: 'photo-grid' }, form.photos.map((photo, index) => h('div', { class: 'photo-item' },
      h('img', { src: photo.url, alt: t('photo', { n: index + 1 }) }),
      h('div', { class: 'photo-actions' },
        index === 0
          ? h('span', { class: 'cover-badge' }, t('cover'))
          : h('button', { type: 'button', onclick: () => makeCover(form, photo) }, t('makeCover')),
        h('button', { type: 'button', class: 'photo-remove', onclick: () => removePhoto(form, photo) }, t('removePhoto')))))) : '',
    form.photos.length < MAX_PHOTOS ? h('label', { class: 'btn file-btn' },
      h('input', {
        class: 'sr-only',
        type: 'file',
        accept: 'image/jpeg,image/png,image/webp',
        multiple: true,
        onchange: (event) => addPhotos(form, [...event.target.files]),
      }),
      `+ ${t('addPhotos')}`) : '',
    form.photoError ? h('p', { class: 'error', role: 'alert' }, t(form.photoError)) : '');
}

async function submitForm(event) {
  event.preventDefault();
  const form = state.form;
  if (form.saving) return;
  form.errorLang = missingTitleLang(form);
  form.saveFailed = false;
  if (form.errorLang) {
    form.tab = form.errorLang;
    renderForm();
    document.getElementById('field-title').focus();
    return;
  }
  const content = {};
  for (const lang of Object.keys(LANGS)) {
    const c = form.content[lang];
    content[lang] = { title: c.title, ingredients: toLines(c.ingredients), steps: toLines(c.steps), notes: c.notes };
  }
  const payload = {
    category: form.category,
    prepMinutes: form.prepMinutes,
    cookMinutes: form.cookMinutes,
    servings: form.servings,
    favorite: form.favorite,
    content,
  };
  form.saving = true;
  renderForm();
  try {
    for (const photo of form.photos) {
      if (!photo.blob) continue;
      photo.name = (await request(`${BASE}/api/photos`, { method: 'POST', body: photo.blob })).name;
      delete photo.blob;
    }
    payload.photos = form.photos.map((photo) => photo.name);
    const saved = await api(form.id ? `/${form.id}` : '', {
      method: form.id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    state.recipes = form.id
      ? state.recipes.map((item) => (item.id === saved.id ? saved : item))
      : [...state.recipes, saved];
    form.dirty = false;
    state.form = null;
    navigate(recipeUrl(saved));
  } catch (error) {
    form.saving = false;
    form.saveFailed = !(error instanceof Cancelled);
    renderForm();
  }
}

function formExitUrl(form) {
  const recipe = state.recipes.find((item) => item.id === form.id);
  return recipe ? recipeUrl(recipe) : BASE;
}

function renderForm() {
  const form = state.form;
  const bind = (object, key) => ({
    value: object[key],
    oninput: (event) => { object[key] = event.target.value; form.dirty = true; },
  });
  const field = (label, control, help) => h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label, help && h('span', { class: 'field-help' }, ` · ${help}`)),
    control);
  const number = (key) => h('input', { type: 'number', min: '0', max: '10000', step: '1', inputmode: 'numeric', ...bind(form, key) });
  const c = form.content[form.tab];
  const titleInvalid = form.errorLang === form.tab;

  app.className = 'page page-narrow';
  app.replaceChildren(h('form', { class: 'form', novalidate: true, onsubmit: submitForm },
    h('h1', {}, form.id ? t('editTitle') : t('newTitle')),
    h('section', { class: 'panel' },
      h('h2', {}, t('details')),
      h('div', { class: 'fields' },
        field(t('category'), h('select', {
          onchange: (event) => { form.category = event.target.value; form.dirty = true; },
        }, CATEGORIES.map((key) => h('option', { value: key, selected: key === form.category }, categoryName(key))))),
        field(t('servings'), number('servings')),
        field(t('prepMinutes'), number('prepMinutes')),
        field(t('cookMinutes'), number('cookMinutes')))),
    photoPanel(form),
    h('section', { class: 'panel' },
      h('h2', {}, t('recipeText')),
      h('p', { class: 'panel-help' }, t('recipeTextHelp')),
      h('div', { class: 'tabs', role: 'tablist' }, Object.entries(LANGS).map(([lang, name]) => h('button', {
        type: 'button',
        class: 'tab',
        role: 'tab',
        lang,
        'aria-selected': String(form.tab === lang),
        onclick: () => { form.tab = lang; renderForm(); },
      }, name))),
      h('div', { lang: form.tab },
        h('label', { class: 'field' },
          h('span', { class: 'field-label', lang: state.lang }, t('title')),
          h('input', { id: 'field-title', maxlength: '200', 'aria-invalid': titleInvalid ? 'true' : null, ...bind(c, 'title') }),
          titleInvalid && h('p', { class: 'error', role: 'alert', lang: state.lang }, t('titleError'))),
        field(t('ingredients'), h('textarea', bind(c, 'ingredients')), t('ingredientsHelp')),
        field(t('steps'), h('textarea', bind(c, 'steps')), t('stepsHelp')),
        field(t('notes'), h('textarea', { rows: '3', ...bind(c, 'notes') })))),
    form.saveFailed && h('p', { class: 'error', role: 'alert' }, t('saveError')),
    h('div', { class: 'form-actions' },
      h('a', { class: 'btn', href: formExitUrl(form) }, t('cancel')),
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: form.saving }, form.saving ? t('saving') : t('save')))));
}

function renderChrome() {
  document.documentElement.lang = state.lang;
  document.title = state.pageTitle || t('appName');
  document.getElementById('brand').textContent = t('appName');
  document.getElementById('lang-switch').setAttribute('aria-label', t('language'));
  document.querySelectorAll('[data-lang]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.lang === state.lang));
  });
  const dark = document.documentElement.dataset.theme === 'dark';
  const toggle = document.getElementById('theme-toggle');
  const label = dark ? t('toLight') : t('toDark');
  toggle.textContent = dark ? '☀' : '☾';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  const lock = document.getElementById('lock-btn');
  lock.hidden = !state.token;
  lock.setAttribute('aria-label', t('lock'));
  lock.title = t('lock');
}

async function gateForm(cancelUrl) {
  app.replaceChildren();
  if (await askCode()) render();
  else navigate(cancelUrl, true);
}

function navigate(url, replace = false) {
  if (url === location.pathname) return;
  if (state.form && state.form.dirty && !confirm(t('unsaved'))) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  state.lastPath = location.pathname;
  state.form = null;
  render();
  window.scrollTo(0, 0);
  app.focus({ preventScroll: true });
}

function render() {
  state.pageTitle = null;
  renderChrome();
  resultsNode = null;
  if (state.loadFailed) {
    app.className = 'page page-narrow';
    app.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, t('loadError')),
      h('button', { type: 'button', class: 'btn', onclick: load }, t('retry'))));
    return;
  }
  const route = location.pathname.replace(/\/+$/, '').match(/^\/recipes(?:\/([a-z0-9-]+)(\/edit)?)?$/);
  const [, slug, isEdit] = route || [];
  const recipe = slug ? state.recipes.find((item) => item.slug === slug) : null;
  if (!route) {
    state.form = null;
    renderNotFound();
  } else if (!slug) {
    state.form = null;
    renderList();
  } else if (slug === 'new' && !isEdit) {
    if (!state.form || state.form.id) {
      if (!state.token) return gateForm(BASE);
      state.form = draftFrom(null);
    }
    renderForm();
  } else if (!recipe) {
    state.form = null;
    renderNotFound();
  } else if (isEdit) {
    if (!state.form || state.form.id !== recipe.id) {
      if (!state.token) return gateForm(recipeUrl(recipe));
      state.form = draftFrom(recipe);
    }
    renderForm();
  } else {
    state.form = null;
    renderRecipe(recipe.id);
  }
}

async function load() {
  try {
    state.recipes = await api('');
    state.loadFailed = false;
  } catch {
    state.loadFailed = true;
  }
  render();
}

window.addEventListener('popstate', () => {
  if (location.pathname === state.lastPath) return;
  if (state.form && state.form.dirty && !confirm(t('unsaved'))) {
    history.pushState(null, '', state.lastPath);
    return;
  }
  state.lastPath = location.pathname;
  state.form = null;
  render();
  window.scrollTo(0, 0);
  app.focus({ preventScroll: true });
});

// In-app links change the page without a reload. Ctrl/Cmd-click still opens a new tab.
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest('a[href]');
  if (!link || link.origin !== location.origin || !link.pathname.startsWith(BASE)) return;
  event.preventDefault();
  navigate(link.pathname);
});

window.addEventListener('beforeunload', (event) => {
  if (state.form && state.form.dirty) event.preventDefault();
});

document.getElementById('lang-switch').addEventListener('click', (event) => {
  const button = event.target.closest('[data-lang]');
  if (!button) return;
  state.lang = button.dataset.lang;
  store.set('recipe-lang', state.lang);
  render();
});

document.getElementById('lock-btn').addEventListener('click', async () => {
  try { await send(`${BASE}/api/lock`, { method: 'POST', body: '{}' }); } catch { /* still lock this tab */ }
  setToken(null);
  if (state.form) navigate(formExitUrl(state.form));
});

document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('recipe-theme', next);
  renderChrome();
});

renderChrome();
load();
