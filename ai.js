'use strict';
// Features that need the network beyond translation: example sentences from Tatoeba and AI
// tasks (word explanation, topics, texts) through our Cloudflare worker, which holds the
// DeepSeek key. Loaded before app.js; app.js helpers ($, esc, db, …) are used only inside
// functions, i.e. after both scripts have loaded.

const AI_URL = 'https://hanzi-ai.qborshxd.workers.dev';

// The worker answers errors with a `code`; the message is chosen by code, not by error text.
const AI_ERRORS = {
  forbidden: 'сервер не принимает запросы с этого адреса',
  bad_request: 'неправильный запрос',
  key: 'проблема с ключом DeepSeek',
  balance: 'закончился баланс DeepSeek',
  busy: 'DeepSeek перегружен, попробуй через минуту',
  bad_answer: 'нейросеть ответила непонятно, попробуй ещё раз',
  upstream: 'DeepSeek не ответил',
};

async function ai(task, body) {
  let r;
  try {
    r = await fetch(`${AI_URL}/${task}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(navigator.onLine === false ? 'нет сети' : 'сервер не ответил');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(AI_ERRORS[data.code] || `ошибка сервера ${r.status}`);
  return data;
}

/* ---------- pinyin per character (for ruby text and sentence lines) ---------- */

// pinyin-pro gives each character its reading in context (多音字), so a sentence is
// converted as a whole; falls back to char-by-char if the library answers in another shape.
function charPinyins(zh) {
  const chars = [...zh];
  try {
    const all = pinyinPro.pinyin(zh, { type: 'all' });
    if (Array.isArray(all) && all.length === chars.length) return all.map(x => (x.isZh ? x.pinyin : ''));
  } catch {}
  return chars.map(c => (HAN.test(c) ? toPinyin(c) : ''));
}
function sentencePinyin(zh) {
  try { return pinyinPro.pinyin(zh); } catch { return ''; }
}

// Characters of `zh` with the given words wrapped in <mark>, optionally as <ruby> with pinyin.
function markedHtml(zh, words, withRuby) {
  const chars = [...zh];
  const marked = new Array(chars.length).fill(false);
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const wl = [...w].length;
    for (let i = 0; i + wl <= chars.length; i++) {
      if (chars.slice(i, i + wl).join('') === w) marked.fill(true, i, i + wl);
    }
  }
  const pys = withRuby ? charPinyins(zh) : [];
  let html = '', open = false;
  chars.forEach((c, i) => {
    if (marked[i] && !open) { html += '<mark>'; open = true; }
    if (!marked[i] && open) { html += '</mark>'; open = false; }
    html += withRuby && pys[i] ? `<ruby>${esc(c)}<rt>${esc(pys[i])}</rt></ruby>` : esc(c);
  });
  return html + (open ? '</mark>' : '');
}

/* ---------- Tatoeba: real sentences translated by people ---------- */

// Tatoeba's API is sometimes very slow (20+ s), so results are kept in the card and the
// request has a time limit. `signal` cancels it when the word changes; that cancellation
// is re-thrown as an AbortError, while a timeout becomes a normal error with a message.
const TATOEBA_TIMEOUT_MS = 40000;
const tatoebaCache = new Map();
async function tatoebaExamples(word, signal) {
  if (tatoebaCache.has(word)) return tatoebaCache.get(word);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TATOEBA_TIMEOUT_MS);
  const cancel = () => ctrl.abort();
  signal?.addEventListener('abort', cancel);
  let j;
  try {
    const r = await fetch('https://api.tatoeba.org/unstable/sentences?lang=cmn&sort=relevance&limit=40'
      + '&showtrans=matching&trans:lang=rus&q=' + encodeURIComponent(word), { signal: ctrl.signal });
    if (!r.ok) throw new Error('Tatoeba: ошибка ' + r.status);
    j = await r.json();
  } catch (err) {
    if (signal?.aborted) throw new DOMException('replaced by a newer word', 'AbortError');
    if (ctrl.signal.aborted) throw new Error('Tatoeba не ответил за 40 секунд');
    throw err.message.startsWith('Tatoeba') ? err : new Error(navigator.onLine === false ? 'нет сети' : 'Tatoeba не ответил');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  const list = (j.data || [])
    .filter(s => s.script !== 'Hant' && s.text.includes(word)) // simplified only, word really inside
    .map(s => ({ zh: s.text, ru: (s.translations || []).flat().find(t => t && t.lang === 'rus')?.text || '' }))
    .filter(s => s.ru)
    .sort((a, b) => a.zh.length - b.zh.length) // shorter first: easier for a beginner
    .slice(0, 12); // enough to page through, small enough to keep in the card
  tatoebaCache.set(word, list);
  return list;
}

function exampleHtml(ex, word) {
  return `<div class="ex">
    <div class="ex-zh" lang="zh">${markedHtml(ex.zh, [word], false)}
      <button class="ex-say" type="button" data-say="${esc(ex.zh)}" aria-label="Произнести">🔊</button></div>
    <div class="ex-py">${esc(sentencePinyin(ex.zh))}</div>
    <div class="ex-ru">${esc(ex.ru)}</div>
  </div>`;
}

/* ---------- word info: AI explanation + Tatoeba examples ---------- */

// Mounts the "examples and explanation" block. `get()` returns
// { word, translation, context, examples }; `store(patch)` keeps { context } or { examples }
// for that word — a card saves them, so each word is fetched and paid for only once.
function mountWordInfo(box, get, store) {
  box.innerHTML = `
    <div class="wi-ai"></div>
    <div class="wi-tat">
      <div class="wi-sub">Примеры из жизни <span class="muted">· Tatoeba</span></div>
      <div class="wi-tat-list"></div>
    </div>`;
  const aiBox = $('.wi-ai', box), tatList = $('.wi-tat-list', box);
  let shown = 3, tatWord = '', tatCtrl = null;

  box.addEventListener('click', e => {
    const say = e.target.closest('[data-say]');
    if (say) { e.stopPropagation(); speak(say.dataset.say); }
  });

  function renderAi() {
    const { word, context } = get();
    if (!word) { aiBox.innerHTML = ''; return; }
    if (!context) {
      aiBox.innerHTML = `<button class="btn small ghost wide" type="button" data-explain>✨ Объяснить слово: значения, сочетания, примеры</button>`;
      return;
    }
    const c = context;
    aiBox.innerHTML = `
      <div class="wi-card">
        <div class="wi-row"><b>${esc(c.pos || '')}</b>${c.meaning ? ` — ${esc(c.meaning)}` : ''}</div>
        ${(c.usage || []).length ? `<div class="wi-sub">Сочетания</div><ul class="wi-list">${c.usage.map(u => `<li lang="zh">${esc(u)}</li>`).join('')}</ul>` : ''}
        ${c.measure ? `<div class="wi-row"><span class="muted">Счётное слово:</span> <span lang="zh">${esc(c.measure)}</span></div>` : ''}
        ${c.compare ? `<div class="wi-row"><span class="muted">Не путать:</span> <span lang="zh">${esc(c.compare)}</span></div>` : ''}
        ${(c.examples || []).length ? `<div class="wi-sub">Примеры</div>${c.examples.map(ex => exampleHtml(ex, word)).join('')}` : ''}
        <button class="link wi-again" type="button" data-explain>↻ объяснить заново</button>
      </div>`;
  }

  aiBox.addEventListener('click', async e => {
    if (!e.target.closest('[data-explain]')) return;
    const { word, translation } = get();
    if (!word) return;
    aiBox.innerHTML = '<div class="muted wi-wait">✨ Думаю над объяснением…</div>';
    try {
      const ctx = await ai('context', { word, translation });
      store({ context: { ...ctx, created: Date.now() } });
    } catch (err) {
      toast('Не получилось объяснить: ' + err.message);
    }
    renderAi();
  });

  async function renderTatoeba(force = false) {
    const { word, examples } = get();
    tatCtrl?.abort(); // a request for the previous word is no longer needed
    if (!word) { tatList.innerHTML = '<div class="muted">Впиши иероглиф — здесь появятся примеры</div>'; return; }
    if (word !== tatWord) { tatWord = word; shown = 3; }
    let list = !force && Array.isArray(examples) ? examples : null;
    if (!list) {
      tatList.innerHTML = '<div class="muted">Ищу примеры… Tatoeba иногда отвечает долго, до полуминуты.</div>';
      const ctrl = tatCtrl = new AbortController();
      try { list = await tatoebaExamples(word, ctrl.signal); }
      catch (err) {
        if (err.name === 'AbortError') return;
        tatList.innerHTML = `<div class="muted">Не загрузилось: ${esc(err.message)}.
          <button class="link" type="button" data-retry>Попробовать ещё раз</button></div>`;
        return;
      }
      store({ examples: list });
    }
    if (!list.length) { tatList.innerHTML = '<div class="muted">Примеров с переводом на русский нет</div>'; return; }
    tatList.innerHTML = list.slice(0, shown).map(ex => exampleHtml(ex, word)).join('')
      + (list.length > shown ? `<button class="link" type="button" data-more>ещё примеры (${list.length - shown})</button>` : '')
      + '<div class="wi-credit">Примеры: <a href="https://tatoeba.org" target="_blank" rel="noopener">Tatoeba</a>, CC BY 2.0 FR</div>';
  }
  tatList.addEventListener('click', e => {
    if (e.target.closest('[data-retry]')) return renderTatoeba(true);
    if (!e.target.closest('[data-more]')) return;
    shown += 3;
    renderTatoeba();
  });

  const refresh = () => { renderAi(); renderTatoeba(); };
  refresh();
  return { refresh };
}

// Word info as its own sheet (from the study card).
function openWordInfo(card) {
  const { ov, body } = openSheet(`<span lang="zh">${esc(card.hanzi)}</span>`);
  body.innerHTML = `<div class="wi-head"><span class="wi-py">${esc(card.pinyin)}</span> ${esc(card.translation || card.en || '')}</div><div class="wi"></div>`;
  mountWordInfo($('.wi', body),
    () => ({ word: card.hanzi, translation: card.translation || card.en, context: card.context, examples: card.examples }),
    patch => { Object.assign(card, patch); save(); });
  return ov;
}

/* ---------- topics by AI ---------- */

// Asks for topics of many words at once (in chunks the worker accepts) and returns
// Map(hanzi → [topic]). New topic names are added to the shared topic list.
async function aiTopics(words) {
  const result = new Map();
  for (let i = 0; i < words.length; i += 50) {
    const chunk = words.slice(i, i + 50);
    const res = await ai('topics', { words: chunk, topics: db.topics });
    for (const [hanzi, list] of Object.entries(res.topics || {})) {
      if (Array.isArray(list)) result.set(hanzi, addTopics(list));
    }
  }
  return result;
}

/* ---------- texts ---------- */

function knownWordsFor(exclude) {
  const skip = new Set(exclude);
  return shuffle([...new Set(db.cards.map(c => c.hanzi))].filter(h => !skip.has(h))).slice(0, 300);
}

// Step 1: options for a new text from the chosen words.
function openTextMaker(deckId, cards) {
  const words = [...new Set(cards.map(c => c.hanzi))];
  const { ov, body, close } = openSheet('Составить текст');
  let length = 'short', topic = '';
  body.innerHTML = `
    <div class="lbl">Слова для текста · ${words.length}</div>
    <div class="chips tm-words" lang="zh">${words.map(w => `<span class="chip static">${esc(w)}</span>`).join('')}</div>
    ${words.length > 25 ? '<p class="en-hint">Слов много — текст получится длинным, часть слов может не войти. Лучше 5–15 слов.</p>' : ''}
    <div class="lbl">Длина</div>
    <div class="seg" id="tmLen"><button data-v="short" class="on" type="button">Короткий</button><button data-v="medium" type="button">Средний</button></div>
    <div class="lbl">Тема <span class="lbl-note">необязательно</span></div>
    <div class="chips" id="tmTopic">
      <button class="chip on" data-v="" type="button">любая</button>
      ${db.topics.map(t => `<button class="chip" data-v="${esc(t)}" type="button">${esc(t)}</button>`).join('')}
    </div>
    <button class="btn primary wide tm-go" id="tmGo" type="button">✨ Составить текст</button>`;
  $('#tmLen', body).onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    length = b.dataset.v;
    [...$('#tmLen', body).children].forEach(x => x.classList.toggle('on', x === b));
  };
  $('#tmTopic', body).onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    topic = b.dataset.v;
    [...$('#tmTopic', body).children].forEach(x => x.classList.toggle('on', x === b));
  };
  $('#tmGo', body).onclick = () => { close(); generateText(deckId, words, { length, topic }); };
  return ov;
}

// Step 2: ask the worker and show the result in the text viewer.
async function generateText(deckId, words, opts) {
  const { body, close, setRight } = openSheet('Текст');
  body.innerHTML = '<div class="tv-wait">✨ Пишу текст из твоих слов…<div class="muted">обычно 5–15 секунд</div></div>';
  let res;
  try {
    res = await ai('text', { words, known: knownWordsFor(words), length: opts.length, topic: opts.topic });
  } catch (err) {
    body.innerHTML = `<div class="tv-wait">Не получилось: ${esc(err.message)}
      <button class="btn small ghost" type="button" id="tvRetry">↻ Попробовать ещё раз</button></div>`;
    $('#tvRetry', body).onclick = () => { close(); generateText(deckId, words, opts); };
    return;
  }
  const paragraphs = (res.paragraphs || [])
    .map(p => (Array.isArray(p) ? p : []).filter(s => s && typeof s.zh === 'string' && s.zh.trim()))
    .filter(p => p.length);
  if (!paragraphs.length) {
    body.innerHTML = '<div class="tv-wait">Нейросеть вернула пустой текст. Попробуй ещё раз.</div>';
    return;
  }
  const text = { id: uid(), deckId, title: res.title || 'Текст', paragraphs, words, opts, created: Date.now() };
  showText(body, text, { close, setRight, onRegenerate: () => { close(); generateText(deckId, words, opts); } });
}

function openTextViewer(text) {
  const { body, close, setRight } = openSheet('Текст');
  showText(body, text, { close, setRight, saved: true });
}

// Renders a text: characters with the chosen words highlighted; tap a sentence for its
// pinyin and translation; toggles show pinyin above every character and all translations.
function showText(body, text, { close, setRight, saved = false, onRegenerate = null }) {
  const view = { py: !!prefs.textPy, tr: !!prefs.textTr };
  const full = text.paragraphs.flat().map(s => s.zh).join('');
  const missing = text.words.filter(w => !full.includes(w)); // checked here, not trusted to the model

  const remove = () => {
    if (!confirm('Удалить этот текст?')) return;
    db.texts = db.texts.filter(t => t.id !== text.id);
    save(); close(); rerender();
  };
  setRight(saved ? 'Удалить' : 'Сохранить', saved ? remove : () => {
    db.texts.push(text);
    save();
    toast('Текст сохранён в набор');
    setRight('Удалить', remove);
    rerender();
  });

  function draw() {
    body.innerHTML = `
      <h2 class="tv-title">${esc(text.title)}</h2>
      <div class="tv-bar">
        <button class="chip ${view.py ? 'on' : ''}" data-tog="py" type="button">Пиньинь</button>
        <button class="chip ${view.tr ? 'on' : ''}" data-tog="tr" type="button">Перевод</button>
        <button class="chip" data-say-all type="button">🔊 Читать</button>
      </div>
      ${missing.length ? `<p class="tv-missing">Не вошли слова: <span lang="zh">${esc(missing.join('、'))}</span>${onRegenerate ? ' <button class="link" type="button" data-regen>↻ переписать</button>' : ''}</p>` : ''}
      <div class="tv-text ${view.py ? 'show-py' : ''}" lang="zh">
        ${text.paragraphs.map((p, pi) => `
          <p class="tv-p">${p.map((s, si) => `<span class="tv-s" data-p="${pi}" data-s="${si}">${markedHtml(s.zh, text.words, view.py)}</span>`).join('')}</p>
          ${view.tr ? `<p class="tv-tr" lang="ru">${esc(p.map(s => s.ru || '').join(' '))}</p>` : ''}
          <div class="tv-detail" data-detail="${pi}" hidden></div>`).join('')}
      </div>
      ${onRegenerate && !missing.length ? '<button class="link tv-regen" type="button" data-regen>↻ другой вариант текста</button>' : ''}
      <p class="en-hint">Нажми на предложение — покажу пиньинь и перевод.</p>`;
  }
  draw();

  body.onclick = e => {
    const tog = e.target.closest('[data-tog]');
    if (tog) {
      view[tog.dataset.tog] = !view[tog.dataset.tog];
      prefs.textPy = view.py; prefs.textTr = view.tr; savePrefs();
      draw();
      return;
    }
    if (e.target.closest('[data-say-all]')) return speak(full);
    if (e.target.closest('[data-regen]') && onRegenerate) return onRegenerate();
    const say = e.target.closest('[data-say]');
    if (say) return speak(say.dataset.say);
    const s = e.target.closest('.tv-s');
    if (!s) return;
    const sent = text.paragraphs[+s.dataset.p][+s.dataset.s];
    const box = body.querySelector(`[data-detail="${s.dataset.p}"]`);
    const same = !box.hidden && box.dataset.s === s.dataset.s;
    body.querySelectorAll('.tv-detail').forEach(d => { d.hidden = true; });
    body.querySelectorAll('.tv-s.on').forEach(x => x.classList.remove('on'));
    if (same) return;
    box.dataset.s = s.dataset.s;
    box.innerHTML = `<div class="ex-py">${esc(sentencePinyin(sent.zh))}</div><div class="ex-ru">${esc(sent.ru || '')}</div>
      <button class="link" type="button" data-say="${esc(sent.zh)}">🔊 произнести</button>`;
    box.hidden = false;
    s.classList.add('on');
  };
}
