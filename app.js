'use strict';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HAN = /\p{Script=Han}/u;
const hanChars = s => [...(s || '')].filter(c => HAN.test(c));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- storage ---------- */
const KEY = 'hanzi-cards-v1';
let db;

function load() {
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
  if (!db || !Array.isArray(db.decks) || !Array.isArray(db.cards)) { db = seed(); save(); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Не получилось сохранить: ' + e.message); }
}
function seed() {
  const id = uid(), t = Date.now();
  return {
    decks: [{ id, name: 'Первые слова', created: t }],
    cards: [
      { id: uid(), deckId: id, hanzi: '你好', pinyin: 'nǐ hǎo', translation: 'привет, здравствуй', note: '', created: t },
      { id: uid(), deckId: id, hanzi: '谢谢', pinyin: 'xiè xie', translation: 'спасибо', note: '', created: t + 1 },
      { id: uid(), deckId: id, hanzi: '我爱你', pinyin: 'wǒ ài nǐ', translation: 'я тебя люблю', note: '', created: t + 2 },
    ],
  };
}
const prefs = (() => { try { return JSON.parse(localStorage.getItem('hanzi-prefs')) || {}; } catch { return {}; } })();
function savePrefs() { try { localStorage.setItem('hanzi-prefs', JSON.stringify(prefs)); } catch {} }

const deckById = id => db.decks.find(d => d.id === id);
const cardsOf = id => db.cards.filter(c => c.deckId === id).sort((a, b) => a.created - b.created);

/* ---------- dictionary (HSK 1–9 words, sorted by frequency) ---------- */
let DICT = null, dictMap = null, dictPromise = null;
const pyKey = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/v/g, 'u').replace(/[^a-z]/g, '');

function loadDict() {
  return dictPromise ||= fetch('dict.txt').then(r => r.text()).then(t => {
    DICT = t.split('\n').filter(Boolean).map(l => {
      const [w, py, lv, en] = l.split('\t');
      return { w, py, lv: +lv, en, k: pyKey(py) };
    });
    dictMap = new Map(DICT.map(e => [e.w, e]));
    return DICT;
  }).catch(e => { dictPromise = null; throw e; });
}

function searchDict(q) {
  q = q.trim();
  if (!q || !DICT) return [];
  if (HAN.test(q)) {
    const exact = [], start = [], cont = [];
    for (const e of DICT) {
      if (e.w === q) exact.push(e);
      else if (e.w.startsWith(q)) start.push(e);
      else if (e.w.includes(q)) cont.push(e);
    }
    const res = [...exact, ...start, ...cont].slice(0, 40);
    if (!exact.length) res.unshift({ w: q, py: toPinyin(q), lv: 0, en: '', custom: true });
    return res;
  }
  const k = pyKey(q);
  if (!k) return [];
  const exact = [], start = [], en = [];
  const enRe = q.length >= 3 ? new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  for (const e of DICT) {
    if (e.k === k) exact.push(e);
    else if (e.k.startsWith(k)) { if (start.length < 40) start.push(e); }
    else if (enRe && en.length < 15 && enRe.test(e.en)) en.push(e);
  }
  return [...exact, ...start, ...en].slice(0, 50);
}

function toPinyin(h) {
  const e = dictMap && dictMap.get(h);
  if (e) return e.py;
  try { return window.pinyinPro ? pinyinPro.pinyin(h) : ''; } catch { return ''; }
}

/* ---------- translation (Google, fallback MyMemory) ---------- */
async function googleTranslate(text, from) {
  const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + from + '&tl=ru&dt=t&dt=at&q=' + encodeURIComponent(text));
  if (!r.ok) throw new Error(r.status);
  const j = await r.json();
  const alts = Array.isArray(j[5]) && j[5].length === 1 ? (j[5][0][2] || []).map(a => a[0]) : [];
  return { main: j[0].map(x => x[0]).join('').trim(), alts };
}
async function myMemory(text, from) {
  const r = await fetch('https://api.mymemory.translated.net/get?langpair=' + (from === 'en' ? 'en' : 'zh-CN') + '|ru&q=' + encodeURIComponent(text));
  const j = await r.json();
  return (j.responseData?.translatedText || '').trim();
}
async function translate(text, from) {
  try { return (await googleTranslate(text, from)).main; }
  catch { return myMemory(text, from); }
}

// Google translates single words through English, so 火车 ("train") can come back as
// "тренироваться". When Google offers several variants, MyMemory picks between them.
async function translateWord(h) {
  const norm = s => s.toLowerCase().replace(/ё/g, 'е').replace(/[.。!]+$/, '').trim();
  let g = null, mm = '';
  try { g = await googleTranslate(h, 'zh-CN'); } catch {}
  if (!g || g.alts.length > 1) { try { mm = await myMemory(h, 'zh-CN'); } catch {} }
  if (!g && !mm) throw new Error('offline');
  let main = g?.main || mm;
  if (g && mm) main = g.alts.find(a => norm(a) === norm(mm)) || main;
  // the dictionary capitalises only proper nouns, so "Открыть" → "открыть" but "Пекин" stays
  const e = dictMap && dictMap.get(h);
  if (e && /^[a-z(]/.test(e.en)) main = main.charAt(0).toLowerCase() + main.slice(1);
  const alts = (g?.alts || []).filter(a => norm(a) !== norm(main));
  return { main, alts };
}

/* ---------- speech ---------- */
function speak(text) {
  if (!('speechSynthesis' in window)) return toast('Озвучка не поддерживается');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 0.8;
  const v = speechSynthesis.getVoices().find(v => /^zh[-_](CN|Hans)/i.test(v.lang));
  if (v) u.voice = v;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ---------- stroke order (Hanzi Writer) ---------- */
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function makeWriter(el, ch, size, opts = {}) {
  el.classList.add('tian');
  el.style.width = el.style.height = size + 'px';
  if (!window.HanziWriter) { el.classList.add('nodata'); el.textContent = ch; return null; }
  const w = HanziWriter.create(el, ch, {
    width: size, height: size, padding: Math.round(size * 0.07),
    showOutline: true,
    strokeColor: css('--ink'), radicalColor: css('--accent'), outlineColor: css('--outline'),
    drawingColor: css('--accent'), highlightColor: css('--good'),
    strokeAnimationSpeed: 1.1, delayBetweenStrokes: 220,
    onLoadCharDataError: () => {
      el.classList.add('nodata');
      el.innerHTML = `<span lang="zh" style="font-size:${Math.round(size * 0.6)}px">${esc(ch)}</span>`;
      w._failed = true;
    },
    ...opts,
  });
  return w;
}

let animToken = 0;
async function animateAll(writers) {
  const my = ++animToken;
  writers = writers.filter(w => w && !w._failed);
  writers.forEach(w => w.hideCharacter());
  for (const w of writers) {
    if (my !== animToken) return;
    await Promise.race([
      new Promise(r => w.animateCharacter({ onComplete: r })),
      new Promise(r => setTimeout(r, 15000)),
    ]);
  }
}

/* ---------- routing ---------- */
const app = $('#app');
window.addEventListener('hashchange', render);

function render() {
  animToken++;
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (name === 'deck' && deckById(id)) renderDeck(id);
  else if (name === 'study' && deckById(id)) renderStudy(id);
  else renderHome();
  window.scrollTo(0, 0);
}

/* ---------- home ---------- */
function renderHome() {
  app.innerHTML = `
    <header class="top"><div class="top-in"><h1>Карточки<span class="cn">汉字</span></h1></div></header>
    <main class="wrap">
      <div class="decks">
        ${db.decks.map(d => {
          const cs = cardsOf(d.id), n = cs.length;
          return `<a class="deck" href="#/deck/${d.id}">
            <div class="deck-preview" lang="zh">${esc(cs.slice(0, 5).map(c => c.hanzi).join(' '))}</div>
            <div class="deck-name">${esc(d.name)}</div>
            <div class="deck-meta">${n} ${plural(n, 'карточка', 'карточки', 'карточек')}</div>
          </a>`;
        }).join('')}
      </div>
      <button class="btn wide ghost" id="newDeck">+ Новый набор</button>
      <section class="backup">
        <h3>Резервная копия</h3>
        <p>Карточки хранятся на этом телефоне. Иногда сохраняй копию в «Файлы», чтобы ничего не потерять.</p>
        <div class="row">
          <button class="btn small" id="exp">Сохранить копию</button>
          <label class="btn small ghost">Загрузить копию<input type="file" accept=".json,application/json" id="imp" hidden></label>
        </div>
      </section>
    </main>`;
  $('#newDeck').onclick = () => {
    const name = prompt('Название набора', 'Новый набор');
    if (!name || !name.trim()) return;
    const d = { id: uid(), name: name.trim(), created: Date.now() };
    db.decks.push(d);
    save();
    location.hash = '#/deck/' + d.id;
  };
  $('#exp').onclick = exportData;
  $('#imp').onchange = e => importData(e.target.files[0]);
}

async function exportData() {
  const json = JSON.stringify({ app: 'hanzi-cards', version: 1, exported: new Date().toISOString(), decks: db.decks, cards: db.cards }, null, 1);
  const name = `hanzi-cards-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importData(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.decks) || !Array.isArray(data.cards)) throw new Error('не тот формат');
    const deckIds = new Set(db.decks.map(d => d.id)), cardIds = new Set(db.cards.map(c => c.id));
    const newDecks = data.decks.filter(d => d && d.id && !deckIds.has(d.id));
    const newCards = data.cards.filter(c => c && c.id && c.hanzi && !cardIds.has(c.id));
    db.decks.push(...newDecks);
    db.cards.push(...newCards);
    save();
    render();
    toast(`Добавлено: ${newCards.length} ${plural(newCards.length, 'карточка', 'карточки', 'карточек')}`);
  } catch (e) {
    toast('Не получилось прочитать файл: ' + e.message);
  }
}

/* ---------- deck ---------- */
function renderDeck(id) {
  const d = deckById(id), cs = cardsOf(id);
  const hard = cs.filter(c => c.last === 'bad');
  const front = prefs.front || 'hanzi';
  app.innerHTML = `
    <header class="top"><div class="top-in"><a class="nav-back" href="#/">‹ Наборы</a></div></header>
    <main class="wrap">
      <div class="deck-title">${esc(d.name)}</div>
      <div class="study-box">
        <div class="seg-label">Сначала показывать</div>
        <div class="seg" id="seg">
          <button data-v="hanzi" class="${front === 'hanzi' ? 'on' : ''}">Иероглиф</button>
          <button data-v="tr" class="${front === 'tr' ? 'on' : ''}">Перевод</button>
        </div>
        <button class="btn primary wide" id="study" ${cs.length ? '' : 'disabled'}>Учить · ${cs.length}</button>
        ${hard.length ? `<button class="btn bad wide" id="studyHard">Повторить трудные · ${hard.length}</button>` : ''}
      </div>
      <div class="list-head"><h2>Карточки</h2><div class="row"><button class="btn small ghost" id="addBulk">Списком</button><button class="btn small primary" id="add">+ Добавить</button></div></div>
      <div class="cards">
        ${cs.length ? cs.map(c => `
          <button class="crow" data-id="${c.id}">
            <span class="crow-h" lang="zh">${esc(c.hanzi)}</span>
            <span class="crow-t">
              <div class="crow-p">${esc(c.pinyin)}</div>
              <div class="crow-tr">${esc(c.translation)}</div>
            </span>
            ${c.last === 'bad' ? '<span class="tag">трудная</span>' : ''}
          </button>`).join('')
        : `<div class="empty"><span class="big" lang="zh">字</span>Пока пусто. Нажми «Добавить», чтобы создать первую карточку.</div>`}
      </div>
      <div class="deck-foot">
        <button class="link" id="rename">Переименовать</button>
        <button class="link" id="delDeck">Удалить набор</button>
      </div>
    </main>`;

  $('#seg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs.front = b.dataset.v;
    savePrefs();
    [...$('#seg').children].forEach(x => x.classList.toggle('on', x === b));
  };
  $('#study').onclick = () => { startStudy(id, cs.map(c => c.id)); location.hash = '#/study/' + id; };
  if (hard.length) $('#studyHard').onclick = () => { startStudy(id, hard.map(c => c.id)); location.hash = '#/study/' + id; };
  $('#add').onclick = () => openEditor(id);
  $('#addBulk').onclick = () => openBulk(id);
  app.querySelectorAll('.crow').forEach(b => b.onclick = () => openEditor(id, b.dataset.id));
  $('#rename').onclick = () => {
    const name = prompt('Новое название', d.name);
    if (!name || !name.trim()) return;
    d.name = name.trim();
    save();
    render();
  };
  $('#delDeck').onclick = () => {
    if (!confirm(`Удалить набор «${d.name}» и все ${cs.length} ${plural(cs.length, 'карточку', 'карточки', 'карточек')}?`)) return;
    db.decks = db.decks.filter(x => x.id !== id);
    db.cards = db.cards.filter(c => c.deckId !== id);
    save();
    location.hash = '#/';
  };
}

/* ---------- card editor ---------- */
function openEditor(deckId, cardId) {
  const card = cardId ? db.cards.find(c => c.id === cardId) : null;
  const st = { pyTouched: !!card, trTouched: !!card, trToken: 0, writers: [] };

  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Карточка">
      <div class="sheet-head">
        <button class="link" data-close>Отмена</button>
        <b>${card ? 'Карточка' : 'Новая карточка'}</b>
        <button class="link strong" id="edSave">Готово</button>
      </div>
      <div class="sheet-body">
        ${card ? '' : `
        <label class="lbl" for="edSearch">Найти слово</label>
        <div class="search">
          <input id="edSearch" placeholder="иероглиф или пиньинь: hao, nihao…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        </div>
        <div class="sugg" id="edSugg"></div>`}
        <label class="lbl" for="edHanzi">Иероглиф</label>
        <input id="edHanzi" class="big" lang="zh" autocomplete="off" value="${esc(card?.hanzi)}">
        <label class="lbl" for="edPinyin">Пиньинь</label>
        <input id="edPinyin" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(card?.pinyin)}">
        <label class="lbl" for="edTr">Перевод <button class="link" id="edRetr" type="button">↻ перевести заново</button></label>
        <textarea id="edTr" rows="2">${esc(card?.translation)}</textarea>
        <div class="chips" id="edChips"></div>
        <div class="en-hint" id="edEn"></div>
        <label class="lbl" for="edNote">Заметка</label>
        <textarea id="edNote" rows="2" placeholder="пример, ассоциация, что угодно">${esc(card?.note)}</textarea>
        <label class="lbl">Как писать <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">нажми на иероглиф</span></label>
        <div class="preview" id="edPreview"></div>
        <div class="row">
          <button class="btn small ghost" id="edAnim" type="button">▶ Порядок черт</button>
          <button class="btn small ghost" id="edPractice" type="button">✍️ Пропись</button>
          <button class="btn small ghost" id="edSpeak" type="button" aria-label="Произнести">🔊</button>
        </div>
        ${card ? '<button class="btn danger wide del" id="edDel" type="button">Удалить карточку</button>' : ''}
      </div>
    </div>`;
  document.body.append(ov);
  document.body.style.overflow = 'hidden';

  const hz = $('#edHanzi', ov), py = $('#edPinyin', ov), tr = $('#edTr', ov), note = $('#edNote', ov);
  const close = () => { animToken++; ov.remove(); document.body.style.overflow = ''; };
  ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) close(); });

  function updatePreview() {
    const box = $('#edPreview', ov);
    box.innerHTML = '';
    st.writers = hanChars(hz.value).slice(0, 8).map(ch => {
      const el = document.createElement('div');
      box.append(el);
      const w = makeWriter(el, ch, 92);
      el.onclick = () => { if (w && !w._failed) { animToken++; w.animateCharacter(); } };
      return w;
    });
    if (!st.writers.length) box.innerHTML = '<span class="muted">Здесь появится, как писать иероглиф</span>';
  }

  async function autoTranslate() {
    const h = hz.value.trim();
    const my = ++st.trToken;
    const chips = $('#edChips', ov), enEl = $('#edEn', ov);
    chips.innerHTML = '';
    const entry = dictMap && dictMap.get(h);
    enEl.textContent = entry?.en ? 'EN: ' + entry.en : '';
    if (!h) return;
    if (!st.trTouched) { tr.value = ''; tr.placeholder = 'перевожу…'; }
    try {
      const [res, enRu] = await Promise.all([
        translateWord(h),
        entry?.en ? translate(entry.en, 'en').catch(() => '') : Promise.resolve(''),
      ]);
      if (my !== st.trToken) return;
      if (!st.trTouched) tr.value = res.main;
      const seen = new Set([res.main.toLowerCase()]);
      const variants = [...res.alts, ...enRu.split(/[;；]\s*/).map(s => s.replace(/\(.*?\)/g, '').trim())]
        .filter(v => v && v.length < 40 && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()));
      if (variants.length) {
        chips.innerHTML = '<div class="chips-hint">Ещё значения — нажми, чтобы добавить:</div>' +
          variants.map(v => `<button class="chip" type="button">${esc(v)}</button>`).join('');
      }
    } catch {
      if (my === st.trToken && !st.trTouched) toast('Нет интернета — перевод можно вписать вручную');
    } finally {
      if (my === st.trToken) tr.placeholder = '';
    }
  }

  $('#edChips', ov).onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const v = b.textContent;
    tr.value = tr.value.trim() ? tr.value.trim().replace(/[,;]$/, '') + ', ' + v : v;
    st.trTouched = true;
    b.remove();
  };

  let hzTimer;
  hz.addEventListener('input', () => {
    clearTimeout(hzTimer);
    hzTimer = setTimeout(() => {
      if (!st.pyTouched) py.value = toPinyin(hz.value.trim());
      updatePreview();
      if (!st.trTouched) autoTranslate();
    }, 450);
  });
  py.addEventListener('input', () => { st.pyTouched = true; });
  tr.addEventListener('input', () => { st.trTouched = true; });
  $('#edRetr', ov).onclick = () => { st.trTouched = false; autoTranslate(); };
  $('#edAnim', ov).onclick = () => animateAll(st.writers);
  $('#edPractice', ov).onclick = () => openPractice(hz.value);
  $('#edSpeak', ov).onclick = () => hz.value.trim() && speak(hz.value.trim());

  const search = $('#edSearch', ov), sugg = $('#edSugg', ov);
  let results = [];
  if (search) {
    const runSearch = () => {
      results = searchDict(search.value);
      sugg.innerHTML = results.map((e, i) => `
        <button class="sg" data-i="${i}" type="button">
          <span class="sg-h" lang="zh">${esc(e.w)}</span>
          <span class="sg-p">${esc(e.py)}</span>
          <span class="sg-l">${e.custom ? 'своё' : e.lv ? 'HSK ' + e.lv : ''}</span>
          <span class="sg-e">${esc(e.en || 'нет в словаре — перевод подтянется автоматически')}</span>
        </button>`).join('');
      if (search.value.trim() && !results.length && DICT) sugg.innerHTML = '<div class="sg muted" style="display:block">Ничего не нашлось</div>';
    };
    search.addEventListener('input', () => {
      if (!DICT) loadDict().then(runSearch).catch(() => toast('Словарь не загрузился'));
      else runSearch();
    });
    sugg.onclick = e => {
      const b = e.target.closest('.sg[data-i]');
      if (!b) return;
      const en = results[+b.dataset.i];
      hz.value = en.w;
      py.value = en.py;
      st.pyTouched = false;
      st.trTouched = false;
      search.value = '';
      sugg.innerHTML = '';
      search.blur();
      updatePreview();
      autoTranslate();
    };
    loadDict().catch(() => {});
    setTimeout(() => search.focus(), 300);
  }

  $('#edSave', ov).onclick = () => {
    const h = hz.value.trim();
    if (!h) { toast('Впиши иероглиф'); hz.focus(); return; }
    const data = { hanzi: h, pinyin: py.value.trim(), translation: tr.value.trim(), note: note.value.trim() };
    if (card) Object.assign(card, data);
    else db.cards.push({ id: uid(), deckId, created: Date.now(), ...data });
    save();
    close();
    render();
    if (!card) toast('Карточка добавлена');
  };
  const del = $('#edDel', ov);
  if (del) del.onclick = () => {
    if (!confirm('Удалить карточку?')) return;
    db.cards = db.cards.filter(c => c.id !== card.id);
    save();
    close();
    render();
  };

  if (card) loadDict().catch(() => {}).then(() => { $('#edEn', ov).textContent = dictMap?.get(card.hanzi)?.en ? 'EN: ' + dictMap.get(card.hanzi).en : ''; });
  updatePreview();
}

/* ---------- bulk add ---------- */
const BULK_MAX = 500;
const PINYIN_PART = /^([a-zA-ZüÀ-ɏ̀-ͯ\d' ]+?)\s*[-—–:：=,]?\s*([Ѐ-ӿ].*)$/;

// One word per line or separated by spaces/commas. A line "学习 - учиться",
// "学习 xuéxí учиться" or a table row "学习 | xuéxí | учиться" keeps its own pinyin/translation.
// Long runs of characters (sentences) are split into words.
function parseBulk(text, split) {
  const seg = window.Intl && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
  const words = tok => {
    const w = hanChars(tok).join('');
    if (!w) return [];
    if (w.length <= 4 || !seg) return [w];
    return [...seg.segment(tok)].filter(s => s.isWordLike).map(s => hanChars(s.segment).join('')).filter(Boolean);
  };
  const items = [];
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.replace(/^\s*\d+[.)]\s*/, '').replace(/\s*[\t|]\s*/g, ' - ').trim();
    if (!line) continue;
    const m = line.match(/^(\S+?)(?:\s*[-—–:：=]\s*|\s+)(.+)$/);
    if (m && HAN.test(m[1]) && !HAN.test(m[2])) {
      let rest = m[2].replace(/[()（）[\]]/g, ' ').trim(), pinyin = '';
      const pm = rest.match(PINYIN_PART);
      if (pm && pm[1].trim()) { pinyin = pm[1].trim(); rest = pm[2].trim(); }
      items.push({ hanzi: hanChars(m[1]).join(''), pinyin, translation: rest });
      continue;
    }
    for (const tok of line.split(/[\s,，、;；。.!?！？\/|:：()（）《》“”"'「」-]+/)) {
      for (const w of words(tok)) items.push({ hanzi: w, pinyin: '', translation: '' });
    }
  }
  const out = split
    ? items.flatMap(it => hanChars(it.hanzi).length > 1 ? hanChars(it.hanzi).map(c => ({ hanzi: c, pinyin: '', translation: '' })) : [it])
    : items;
  const seen = new Set();
  return out.filter(it => !seen.has(it.hanzi) && seen.add(it.hanzi));
}

/* ---------- reading .txt / .docx ---------- */
async function readTextFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('gbk').decode(buf); } // Chinese Windows "ANSI" files
}

let jszipPromise = null;
function loadJSZip() {
  return jszipPromise ||= new Promise((resolve, reject) => {
    if (window.JSZip) return resolve(window.JSZip);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { jszipPromise = null; reject(new Error('нет интернета, чтобы открыть .docx')); };
    document.head.append(s);
  });
}

// Paragraphs become lines; table rows become "cell1 | cell2 | …" lines.
async function readDocx(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('это не похоже на .docx');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paraText = p => {
    let s = '';
    const tw = doc.createTreeWalker(p, NodeFilter.SHOW_ELEMENT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.namespaceURI !== W) continue;
      if (n.localName === 't') s += n.textContent;
      else if (n.localName === 'tab') s += '\t';
      else if (n.localName === 'br' || n.localName === 'cr') s += '\n';
    }
    return s;
  };
  const lines = [];
  const walk = el => {
    for (const ch of el.children) {
      if (ch.namespaceURI === W && ch.localName === 'p') lines.push(paraText(ch));
      else if (ch.namespaceURI === W && ch.localName === 'tbl') {
        for (const tr of ch.getElementsByTagNameNS(W, 'tr')) {
          const cells = [...tr.children].filter(c => c.localName === 'tc')
            .map(tc => [...tc.getElementsByTagNameNS(W, 'p')].map(paraText).join(' ').trim())
            .filter(Boolean);
          lines.push(cells.join('\t'));
        }
      } else walk(ch);
    }
  };
  walk(doc.getElementsByTagNameNS(W, 'body')[0] || doc.documentElement);
  return lines.join('\n');
}

async function readWordFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.doc')) throw new Error('старый формат .doc — пересохрани файл как .docx');
  if (name.endsWith('.pages')) throw new Error('файл Pages — экспортируй его в .docx или .txt');
  return name.endsWith('.docx') ? readDocx(file) : readTextFile(file);
}

function openBulk(deckId) {
  const existing = new Set(cardsOf(deckId).map(c => c.hanzi));
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Добавить списком">
      <div class="sheet-head">
        <button class="link" id="bkBack">Отмена</button>
        <b>Добавить списком</b>
        <button class="link strong" id="bkNext">Дальше</button>
      </div>
      <div class="sheet-body" id="bkBody"></div>
    </div>`;
  document.body.append(ov);
  document.body.style.overflow = 'hidden';
  const body = $('#bkBody', ov), back = $('#bkBack', ov), next = $('#bkNext', ov);
  let step = 1, text = '', split = false, items = [], token = 0, loading = false;

  const close = () => { token++; ov.remove(); document.body.style.overflow = ''; };
  ov.addEventListener('click', e => { if (e.target === ov) close(); });

  function step1() {
    step = 1;
    token++;
    back.textContent = 'Отмена';
    next.textContent = 'Дальше';
    next.disabled = false;
    body.innerHTML = `
      <label class="btn ghost wide file-btn">📄 Загрузить файл · .txt или .docx
        <input type="file" id="bkFile" hidden accept=".txt,.docx,.csv,.md,.doc,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
      </label>
      <div class="or">или впиши вручную</div>
      <label class="lbl" for="bkText">Иероглифы или слова</label>
      <textarea id="bkText" rows="8" lang="zh" placeholder="你好&#10;谢谢 老师 学生&#10;学习 - учиться">${esc(text)}</textarea>
      <p class="en-hint">Каждое слово с новой строки, через пробел или запятую. Свой перевод можно сразу дописать через тире: <span lang="zh">学习</span> - учиться</p>
      <label class="check"><input type="checkbox" id="bkSplit" ${split ? 'checked' : ''}> Разбить слова на отдельные иероглифы</label>`;
    $('#bkFile', ov).onchange = async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const t = await readWordFile(file);
        if (!HAN.test(t)) throw new Error('в файле не нашлось иероглифов');
        const ta = $('#bkText', ov);
        ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + t.trim();
        toast('Загружено: ' + file.name);
        step2();
      } catch (err) {
        toast('Не получилось: ' + err.message);
      }
    };
  }

  async function step2() {
    text = $('#bkText', ov).value;
    split = $('#bkSplit', ov).checked;
    let parsed = parseBulk(text, split);
    if (!parsed.length) return toast('Не нашлось иероглифов в тексте');
    if (parsed.length > BULK_MAX) {
      toast(`Слов очень много — добавлю первые ${BULK_MAX}`);
      parsed = parsed.slice(0, BULK_MAX);
    }
    step = 2;
    await loadDict().catch(() => {});
    items = parsed.map(it => ({
      ...it,
      pinyin: it.pinyin || toPinyin(it.hanzi),
      dup: existing.has(it.hanzi),
      on: !existing.has(it.hanzi),
      trTouched: !!it.translation,
    }));
    back.textContent = '‹ Назад';
    body.innerHTML = `
      <p class="en-hint" style="margin-top:0">Перевод подтягивается сам — поправь, если нужно. ✕ убирает слово из списка.</p>
      <div class="bk-list">${items.map((it, i) => `
        <div class="bk-row ${it.on ? '' : 'off'}" data-i="${i}">
          <div class="bk-h" lang="zh">${esc(it.hanzi)}</div>
          <div class="bk-f">
            <input class="bk-py" data-f="pinyin" value="${esc(it.pinyin)}" aria-label="Пиньинь" autocomplete="off" autocapitalize="off" spellcheck="false">
            <input class="bk-tr" data-f="translation" value="${esc(it.translation)}" aria-label="Перевод" placeholder="${it.trTouched ? '' : 'перевожу…'}" autocomplete="off">
            ${it.dup ? '<div class="bk-dup">уже есть в наборе</div>' : ''}
          </div>
          <button class="bk-x" data-x="${i}" type="button" aria-label="${it.on ? 'Убрать' : 'Вернуть'}">${it.on ? '✕' : '↺'}</button>
        </div>`).join('')}
      </div>`;
    updateCount();
    translateAll();
  }

  function updateCount() {
    const n = items.filter(it => it.on).length;
    next.textContent = `Добавить · ${n}`;
    next.disabled = !n;
  }

  async function translateAll() {
    const my = ++token;
    const queue = items.filter(it => !it.trTouched);
    let failed = 0;
    loading = true;
    const worker = async () => {
      while (queue.length && my === token) {
        const it = queue.shift();
        let ru = '';
        try { ru = (await translateWord(it.hanzi)).main; } catch { failed++; }
        if (my !== token) return;
        const inp = ov.querySelector(`.bk-row[data-i="${items.indexOf(it)}"] .bk-tr`);
        if (!it.trTouched) { it.translation = ru; if (inp) inp.value = ru; }
        if (inp) inp.placeholder = 'перевод';
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (my !== token) return;
    loading = false;
    if (failed) toast('Часть переводов не загрузилась — впиши вручную');
  }

  body.addEventListener('input', e => {
    const row = e.target.closest('.bk-row');
    if (!row) return;
    const it = items[+row.dataset.i];
    it[e.target.dataset.f] = e.target.value;
    if (e.target.dataset.f === 'translation') it.trTouched = true;
  });
  body.addEventListener('click', e => {
    const x = e.target.closest('[data-x]');
    if (!x) return;
    const it = items[+x.dataset.x];
    it.on = !it.on;
    x.closest('.bk-row').classList.toggle('off', !it.on);
    x.textContent = it.on ? '✕' : '↺';
    x.setAttribute('aria-label', it.on ? 'Убрать' : 'Вернуть');
    updateCount();
  });

  back.onclick = () => step === 1 ? close() : step1();
  next.onclick = () => {
    if (step === 1) return step2();
    if (loading) return toast('Секунду, ещё перевожу…');
    const add = items.filter(it => it.on);
    if (!add.length) return;
    const t = Date.now();
    add.forEach((it, k) => db.cards.push({
      id: uid(), deckId, created: t + k,
      hanzi: it.hanzi, pinyin: it.pinyin.trim(), translation: it.translation.trim(), note: '',
    }));
    save();
    close();
    render();
    toast(`Добавлено: ${add.length} ${plural(add.length, 'карточка', 'карточки', 'карточек')}`);
  };

  step1();
}

/* ---------- writing practice ---------- */
function openPractice(text) {
  const chars = hanChars(text);
  if (!chars.length) return toast('Сначала впиши иероглиф');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Пропись">
      <div class="sheet-head"><span></span><b>Пропись</b><button class="link strong" data-close>Готово</button></div>
      <div class="pr-body">
        <div class="pr-nav" id="prNav">${chars.length > 1 ? chars.map((c, i) => `<button data-i="${i}" lang="zh">${esc(c)}</button>`).join('') : ''}</div>
        <div class="pr-box" id="prBox"></div>
        <p class="pr-msg muted" id="prMsg"></p>
        <div class="row center">
          <button class="btn small ghost" id="prShow">▶ Показать</button>
          <button class="btn small ghost" id="prRestart">↺ Заново</button>
          <button class="btn small ghost" id="prSpeak" aria-label="Произнести">🔊</button>
        </div>
      </div>
    </div>`;
  document.body.append(ov);
  const box = $('#prBox', ov), msg = $('#prMsg', ov);
  let i = 0, writer = null, nextTimer;
  const close = () => { clearTimeout(nextTimer); ov.remove(); };
  ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) close(); });

  function quiz() {
    if (!writer || writer._failed) return;
    msg.textContent = 'Нарисуй пальцем по чертам. После 2 ошибок будет подсказка';
    writer.quiz({
      showHintAfterMisses: 2,
      highlightOnComplete: true,
      onComplete: ({ totalMistakes }) => {
        msg.textContent = totalMistakes ? `Готово! Ошибок: ${totalMistakes}` : 'Идеально! ✨';
        if (i < chars.length - 1) nextTimer = setTimeout(() => show(i + 1), 1300);
      },
    });
  }
  function show(k) {
    clearTimeout(nextTimer);
    i = k;
    ov.querySelectorAll('#prNav button').forEach(b => b.classList.toggle('on', +b.dataset.i === i));
    box.className = 'pr-box';
    box.innerHTML = '';
    const size = Math.min(window.innerWidth - 64, 320);
    writer = makeWriter(box, chars[i], size);
    quiz();
  }
  $('#prNav', ov).onclick = e => { const b = e.target.closest('button'); if (b) show(+b.dataset.i); };
  $('#prShow', ov).onclick = () => {
    if (!writer || writer._failed) return;
    writer.cancelQuiz();
    msg.textContent = 'Смотри порядок черт…';
    writer.animateCharacter({ onComplete: () => setTimeout(quiz, 500) });
  };
  $('#prRestart', ov).onclick = () => { if (writer && !writer._failed) { writer.cancelQuiz(); quiz(); } };
  $('#prSpeak', ov).onclick = () => speak(chars[i]);
  show(0);
}

/* ---------- study ---------- */
let S = null;

function startStudy(deckId, ids) {
  S = { deckId, queue: shuffle(ids), total: ids.length, done: 0, wrong: new Set(), writers: [] };
}

function renderStudy(id) {
  const d = deckById(id);
  if (!S || S.deckId !== id) startStudy(id, cardsOf(id).map(c => c.id));
  app.innerHTML = `
    <header class="top"><div class="top-in">
      <a class="nav-back" href="#/deck/${id}" style="max-width:40%">‹ ${esc(d.name)}</a>
      <div class="progress"><div class="bar" id="bar"></div></div>
      <span class="muted" id="count"></span>
    </div></header>
    <main class="study" id="studyMain"></main>`;
  showCard();
}

function showCard() {
  const main = $('#studyMain');
  if (!main) return;
  $('#bar').style.width = (S.total ? S.done / S.total * 100 : 0) + '%';
  $('#count').textContent = `${S.done}/${S.total}`;
  if (!S.queue.length) return showDone(main);
  const c = db.cards.find(x => x.id === S.queue[0]);
  if (!c) { S.queue.shift(); S.total--; return showCard(); }

  const front = prefs.front === 'tr'
    ? `<div class="front-tr">${esc(c.translation || '—')}</div>`
    : `<div class="front-h" lang="zh">${esc(c.hanzi)}</div>`;
  main.innerHTML = `
    <div class="stage"><div class="card3d" id="card">
      <div class="face front">${front}<div class="hint">нажми, чтобы перевернуть</div></div>
      <div class="face back">
        <div class="writers" id="writers"></div>
        <div class="tools">
          <button class="icon" data-act="anim" aria-label="Показать порядок черт">▶</button>
          <button class="icon" data-act="speak" aria-label="Произнести">🔊</button>
          <button class="icon" data-act="practice" aria-label="Пропись">✍️</button>
        </div>
        <div class="b-py">${esc(c.pinyin)}</div>
        <div class="b-tr">${esc(c.translation)}</div>
        ${c.note ? `<div class="b-note">${esc(c.note)}</div>` : ''}
      </div>
    </div></div>
    <div class="answer">
      <button class="btn bad" id="no">Не помню</button>
      <button class="btn good" id="yes">Помню</button>
    </div>`;

  // build stroke writers up front so their data loads while the front side is shown
  const chars = hanChars(c.hanzi);
  const avail = Math.min(main.clientWidth - 32 - 36, 360);
  const n = Math.max(chars.length, 1);
  const size = n === 1 ? Math.min(200, avail) : Math.max(70, Math.min(150, Math.floor((avail - (n - 1) * 8) / n)));
  const wbox = $('#writers', main);
  S.writers = chars.map(ch => {
    const el = document.createElement('div');
    wbox.append(el);
    return makeWriter(el, ch, size);
  });

  const card = $('#card', main);
  card.onclick = e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'anim') return animateAll(S.writers);
    if (act === 'speak') return speak(c.hanzi);
    if (act === 'practice') return openPractice(c.hanzi);
    card.classList.toggle('flipped');
    if (card.classList.contains('flipped')) setTimeout(() => animateAll(S.writers), 350);
    else animToken++;
  };

  const answer = ok => {
    animToken++;
    c.last = ok ? 'ok' : 'bad';
    save();
    if (ok) { S.queue.shift(); S.done++; }
    else {
      S.wrong.add(c.id);
      const id = S.queue.shift();
      S.queue.splice(Math.min(3, S.queue.length), 0, id); // show it again a bit later
    }
    showCard();
  };
  $('#yes', main).onclick = () => answer(true);
  $('#no', main).onclick = () => answer(false);
}

function showDone(main) {
  const right = S.total - S.wrong.size;
  main.innerHTML = `
    <div class="done">
      <div class="done-emoji">${right === S.total ? '🎉' : '💪'}</div>
      <h2>Готово!</h2>
      <p>С первого раза: ${right} из ${S.total}</p>
      ${S.wrong.size ? `<button class="btn primary wide" id="againWrong">Повторить трудные · ${S.wrong.size}</button>` : ''}
      <button class="btn wide" id="againAll">Пройти ещё раз</button>
      <a class="btn ghost wide" href="#/deck/${S.deckId}">К набору</a>
    </div>`;
  const deckId = S.deckId, wrong = [...S.wrong];
  const again = $('#againWrong', main);
  if (again) again.onclick = () => { startStudy(deckId, wrong); showCard(); };
  $('#againAll', main).onclick = () => { startStudy(deckId, cardsOf(deckId).map(c => c.id)); showCard(); };
}

/* ---------- start ---------- */
load();
render();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
