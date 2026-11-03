/* 听写小助手 — SPA (no build step) */
'use strict';

const view = document.getElementById('view');
let voices = [];

/* APK（Capacitor 壳）模式：API 走绝对地址，朗读改用安卓原生 TTS。
   浏览器模式 window.Capacitor 不存在，行为与之前完全一致。 */
const IS_NATIVE = typeof window.Capacitor !== 'undefined';
const DEFAULT_SERVER = 'http://192.168.1.45:8090';
const API_BASE = IS_NATIVE
  ? (localStorage.getItem('serverUrl') || DEFAULT_SERVER).replace(/\/+$/, '')
  : '';

/* ------------------------------------------------------------------ util */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = opts.form
    ? await fetch(API_BASE + path, { method: opts.method || 'POST', body: opts.form })
    : await fetch(API_BASE + path, {
        method: opts.method || 'GET',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return res.json();
}

function withPhoto(path, file) {
  const form = new FormData();
  form.append('photo', file, 'photo.jpg');
  return api(path, { form });
}

async function compressImage(file) {
  if (file.size <= 900 * 1024 && file.type.startsWith('image/')) return file;
  const bmp = await createImageBitmap(file);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
}

const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${wd} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const scoreClass = (pct) => (pct >= 90 ? 'ok' : pct >= 70 ? '' : 'bad');
const scoreColor = (pct) => (pct >= 90 ? 'var(--green)' : pct >= 70 ? 'var(--amber)' : 'var(--red)');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fail(err) {
  view.innerHTML += `<div class="warn">出错了：${esc(err.message || err)}</div>`;
}

/* ------------------------------------------------------------------- tts */

const ttsPlugin = IS_NATIVE
  ? (window.Capacitor.Plugins && window.Capacitor.Plugins.TextToSpeech) || null
  : null;

function loadVoices() {
  if (ttsPlugin) {
    if (typeof ttsPlugin.getVoices === 'function') {
      Promise.resolve(ttsPlugin.getVoices())
        .then((r) => {
          const list = (r && r.voices) || r || [];
          voices = list.map((v) => ({
            voiceURI: v.name || v.id, name: v.name || v.id,
            lang: String(v.lang || v.id || '').replace('_', '-').toLowerCase(),
          }));
        })
        .catch(() => {});
    }
    return;
  }
  voices = speechSynthesis.getVoices();
}
if (ttsPlugin) {
  loadVoices();
} else if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function cancelTTS() {
  if (ttsPlugin) { try { ttsPlugin.stop(); } catch {} return; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function auVoices() {
  return voices.filter((v) => (v.lang || '').toLowerCase().replace('_', '-').startsWith('en-au'));
}

function getVoice() {
  const saved = localStorage.getItem('voiceURI');
  if (saved) {
    const v = voices.find((v) => v.voiceURI === saved);
    if (v) return v;
  }
  return auVoices()[0] || null;
}

function speak(word, slow = false) {
  const times = Math.min(3, Number(localStorage.getItem('repeat') || 1));
  const voice = getVoice();
  if (ttsPlugin) {
    cancelTTS();
    const rate = slow ? 0.55 : 0.85;
    for (let i = 0; i < times; i++) {
      const opts = { text: word, lang: 'en-AU', rate, pitch: 1, volume: 0.9, queue: true };
      if (voice && voice.voiceURI) opts.voice = voice.voiceURI;
      Promise.resolve(ttsPlugin.speak(opts)).catch(() => {});
    }
    return;
  }
  if (!('speechSynthesis' in window)) { alert('这台设备的浏览器不支持语音朗读'); return; }
  speechSynthesis.cancel();
  for (let i = 0; i < times; i++) {
    const u = new SpeechSynthesisUtterance(word);
    if (voice) u.voice = voice;
    u.lang = (voice && voice.lang) || 'en-AU';
    u.rate = slow ? 0.55 : 0.85;
    u.pitch = 1;
    speechSynthesis.speak(u);
  }
}

/* ------------------------------------------------------------- photo box */

function photoInput(id) {
  return `<input type="file" id="${id}" accept="image/*" capture="environment">
          <img id="${id}-preview" class="preview" style="display:none" alt="预览">`;
}

function wirePhotoPreview(inputId) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(inputId + '-preview');
  input.addEventListener('change', () => {
    const f = input.files[0];
    if (!f) return;
    preview.src = URL.createObjectURL(f);
    preview.style.display = 'block';
  });
}

/* ----------------------------------------------------------------- views */

async function renderHome() {
  let stats, sessions;
  try {
    [stats, sessions] = await Promise.all([api('/api/stats'), api('/api/sessions?status=all&limit=20')]);
  } catch (e) { return fail(e); }

  const unfinished = sessions.filter((s) => s.status !== 'done');
  const weeks = stats.weeks || [];

  const weekRows = weeks.map((w) => {
    const pct = Math.round((w.avg_score || 0) * 100);
    return `<div class="sess-row">
      <span>${esc(w.week)} · ${w.n} 次 · 最近 ${esc(fmtDateTime(w.last_done))}</span>
      <span class="score-mini ${scoreClass(pct)}">${pct}%</span>
    </div>`;
  }).join('');

  const todo = unfinished.map((s) => {
    const label = s.status === 'draft' ? '整理单词中' : '听写进行中';
    const href = s.status === 'draft' ? `#/edit/${s.id}` : `#/finish/${s.id}`;
    return `<div class="sess-row">
      <a href="${href}">#${s.id} ${esc(label)} · ${(s.words || []).length} 个词</a>
      <button class="btn danger" data-del="${s.id}">删除</button>
    </div>`;
  }).join('');

  const voice = getVoice();
  const noAU = auVoices().length === 0;

  view.innerHTML = `
    <div class="card">
      <h2>本周听写（${esc(stats.current_week)}）
        ${stats.current_week_done
          ? '<span class="ok">　已完成 ✓</span>'
          : '<span class="bad">　还没做</span>'}
      </h2>
      <a class="btn big" href="#/new">${stats.current_week_done ? '再来一次听写' : '开始本周听写'}</a>
      ${stats.review_count ? `<p class="muted">🔁 <a href="#/review">复习池里有 ${stats.review_count} 个以前写错过的词</a>，下次核对时会建议加进单词表。</p>` : ''}
    </div>

    ${unfinished.length ? `<div class="card"><h2>未完成</h2>${todo}</div>` : ''}

    <div class="card">
      <h2>最近成绩</h2>
      ${weekRows || '<div class="muted">还没有完成过听写</div>'}
      <a class="btn ghost" href="#/history">全部历史 →</a>
    </div>

    ${IS_NATIVE ? `
    <div class="card">
      <h2>服务器地址</h2>
      <div class="row">
        <input id="serverUrl" style="flex:1" value="${esc(localStorage.getItem('serverUrl') || DEFAULT_SERVER)}">
        <button class="btn ghost" id="serverSave">保存</button>
      </div>
      <p class="muted">App 连的是家里局域网的服务器；服务器 IP 变了就在这里改，保存后重新打开 App。</p>
    </div>` : ''}

    <div class="card">
      <h2>发音设置</h2>
      ${noAU ? '<div class="warn">这台设备目前找不到澳洲英语（en-AU）语音，将用其它英语语音代替。iPhone 可在「设置 → 辅助功能 → 朗读内容 → 语音」下载 Australian English；Android 可在「文字与语音 → 文字转语音」下载澳洲口音语音包。</div>' : ''}
      <div class="row">
        <select id="voiceSel" style="flex:1"></select>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="muted">每个单词读 <select id="repeatSel">
          <option value="1">1</option><option value="2">2</option><option value="3">3</option>
        </select> 遍</label>
        <button class="btn ghost" id="testBtn">试听</button>
      </div>
    </div>
  `;

  const sel = document.getElementById('voiceSel');
  const sorted = [...auVoices(),
    ...voices.filter((v) => (v.lang || '').toLowerCase().startsWith('en-')),
  ].filter((v, i, arr) => arr.findIndex((x) => x.voiceURI === v.voiceURI) === i);
  sel.innerHTML = sorted.length
    ? sorted.map((v) =>
        `<option value="${esc(v.voiceURI)}" ${voice && v.voiceURI === voice.voiceURI ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)}${auVoices().includes(v) ? ' 🇦🇺' : ''})</option>`).join('')
    : '<option value="">（浏览器没有英语语音）</option>';
  sel.onchange = () => localStorage.setItem('voiceURI', sel.value);

  if (IS_NATIVE) {
    const sIn = document.getElementById('serverUrl');
    document.getElementById('serverSave').onclick = () => {
      const v = (sIn.value || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(v)) { alert('地址要以 http:// 或 https:// 开头'); return; }
      localStorage.setItem('serverUrl', v);
      location.reload();
    };
  }

  const rep = document.getElementById('repeatSel');
  rep.value = localStorage.getItem('repeat') || '1';
  rep.onchange = () => localStorage.setItem('repeat', rep.value);
  document.getElementById('testBtn').onclick = () => speak('Australia');

  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这个未完成的听写？')) return;
      try { await api(`/api/sessions/${b.dataset.del}`, { method: 'DELETE' }); renderHome(); }
      catch (e) { fail(e); }
    };
  });
}

async function renderNew() {
  view.innerHTML = `
    <div class="card">
      <h2>第 1 步：拍单词表</h2>
      <p class="muted">把老师发的听写单词表拍下来（或从相册选一张），识别后可以再修改。</p>
      ${photoInput('listPhoto')}
      <div style="margin-top:12px"><button class="btn big" id="ocrBtn">识别单词</button></div>
      <div id="ocrBusy" class="muted" style="display:none">正在识别，大约要 10–30 秒…</div>
    </div>`;
  wirePhotoPreview('listPhoto');
  document.getElementById('ocrBtn').onclick = async () => {
    const f = document.getElementById('listPhoto').files[0];
    if (!f) { alert('请先拍照或选一张照片'); return; }
    const busy = document.getElementById('ocrBusy');
    busy.style.display = 'block';
    try {
      const out = await withPhoto('/api/sessions', await compressImage(f));
      location.hash = `#/edit/${out.id}`;
    } catch (e) { busy.style.display = 'none'; fail(e); }
  };
}

async function renderEdit(id) {
  let s, review;
  try {
    s = await api(`/api/sessions/${id}`);
    try { review = await api('/api/review'); } catch (e) { review = { words: [] }; }
  } catch (e) { return fail(e); }
  let words = (s.words || []).slice();
  const poolAll = review.words || [];

  const chipsHtml = () => words.map((w, i) =>
    `<span class="chip">${esc(w)}<button data-i="${i}" title="删掉">✕</button></span>`).join('');

  const reviewHtml = () => {
    const suggest = poolAll.filter((p) => !words.includes(p.word));
    if (!suggest.length) return '';
    return `<div class="review-box">
      <p class="muted">🔁 复习池里有 ${suggest.length} 个以前写错过的词（✕次数），建议加进这次听写：</p>
      <div class="chips">${suggest.map((p) =>
        `<span class="chip review-chip" data-word="${esc(p.word)}">${esc(p.word)} ×${p.wrong_count} ＋</span>`).join('')}</div>
      <button class="btn ghost" id="addAllReview">全部加入</button>
    </div>`;
  };

  view.innerHTML = `
    <div class="card">
      <h2>第 2 步：核对单词（${words.length} 个）</h2>
      ${s.list_photo ? `<a class="photo-link" href="/api/sessions/${id}/photo/list" target="_blank"><img class="preview" src="/api/sessions/${id}/photo/list" alt="原单词表"></a>` : ''}
      <div class="chips" id="chips">${chipsHtml()}</div>
      <div id="reviewBox">${reviewHtml()}</div>
      <div class="row">
        <input type="text" id="addWord" placeholder="添加一个单词，回车确认" autocomplete="off">
      </div>
      <div class="row" style="margin-top:10px">
        <textarea id="bulk" rows="3" style="flex:1" placeholder="也可以整批粘贴：每行一个单词，然后点「批量替换」"></textarea>
        <button class="btn ghost" id="bulkBtn">批量替换</button>
      </div>
      <div style="margin-top:14px">
        <button class="btn big" id="startBtn">🔊 开始听写（随机顺序）</button>
      </div>
      <p class="muted">听写时孩子只听到单词、看不到单词，请让孩子准备纸笔，听到一个写一个。</p>
    </div>`;

  const redraw = () => {
    document.getElementById('chips').innerHTML = chipsHtml();
    document.querySelectorAll('#chips button').forEach((b) => {
      b.onclick = () => { words.splice(Number(b.dataset.i), 1); redraw(); };
    });
    const box = document.getElementById('reviewBox');
    box.innerHTML = reviewHtml();
    box.querySelectorAll('.review-chip').forEach((c) => {
      c.onclick = () => {
        const w = c.dataset.word;
        if (w && !words.includes(w)) { words.push(w); redraw(); }
      };
    });
    const allBtn = box.querySelector('#addAllReview');
    if (allBtn) allBtn.onclick = () => {
      poolAll.forEach((p) => { if (!words.includes(p.word)) words.push(p.word); });
      redraw();
    };
  };
  redraw();

  const add = () => {
    const inp = document.getElementById('addWord');
    const w = inp.value.trim().toLowerCase();
    if (w && !words.includes(w)) { words.push(w); inp.value = ''; redraw(); }
  };
  document.getElementById('addWord').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  document.getElementById('addWord').onchange = add;

  document.getElementById('bulkBtn').onclick = () => {
    const list = document.getElementById('bulk').value
      .split(/\s+/).map((w) => w.toLowerCase().replace(/^[0-9.)+]+/, ''))
      .filter((w) => /^[a-z'’-]+$/.test(w));
    if (list.length) {
      words = [...new Set(list)];
      document.getElementById('bulk').value = '';
      redraw();
    }
  };

  document.getElementById('startBtn').onclick = async () => {
    if (!words.length) { alert('单词表是空的'); return; }
    try {
      await api(`/api/sessions/${id}`, { method: 'PUT', body: { words } });
      const order = shuffle(words);
      sessionStorage.setItem(`order-${id}`, JSON.stringify(order));
      sessionStorage.setItem(`idx-${id}`, '-1');
      await api(`/api/sessions/${id}/start`, { method: 'POST', body: { order } });
      location.hash = `#/run/${id}`;
    } catch (e) { fail(e); }
  };
}

async function renderRun(id) {
  let s;
  try { s = await api(`/api/sessions/${id}`); } catch (e) { return fail(e); }
  if (s.status === 'done') { location.hash = `#/result/${id}`; return; }
  if (s.status === 'draft') { location.hash = `#/edit/${id}`; return; }

  let order;
  try { order = JSON.parse(sessionStorage.getItem(`order-${id}`) || 'null'); } catch { order = null; }
  if (!order) { order = shuffle(s.words || []); sessionStorage.setItem(`order-${id}`, JSON.stringify(order)); }
  let idx = Number(sessionStorage.getItem(`idx-${id}`) ?? -1);
  if (idx >= order.length) idx = order.length - 1;

  const persist = () => {
    sessionStorage.setItem(`order-${id}`, JSON.stringify(order));
    sessionStorage.setItem(`idx-${id}`, String(idx));
  };

  const paint = () => {
    document.getElementById('prog').textContent = `${Math.min(idx + 1, order.length)} / ${order.length}`;
    const done = idx >= order.length - 1 && idx >= 0;
    document.getElementById('nextBtn').disabled = !(idx >= 0 && idx < order.length - 1 && played);
    document.getElementById('finishBtn').style.display = done ? 'block' : 'none';
    document.getElementById('hint').textContent =
      idx < 0 ? '点击下方按钮开始，第 1 个单词马上出现'
      : done ? '全部读完了！让孩子检查一遍书写，然后拍照上传'
      : `正在第 ${idx + 1} 个 · 听完写好后点「下一个」`;
  };

  view.innerHTML = `
    <div class="card">
      <div class="progress-num" id="prog"></div>
      <div class="runner-word" id="hint"></div>
      <div class="runner-actions">
        <button class="btn" id="playBtn">🔊 读这个单词</button>
        <button class="btn ghost" id="slowBtn">🐢 慢读一遍</button>
        <button class="btn big" id="nextBtn" style="grid-column:1/3">✅ 下一个</button>
        <button class="btn big" id="finishBtn" style="grid-column:1/3; display:none">📸 拍答卷上传</button>
      </div>
      <p class="muted" style="margin-top:14px">家长注意：听的过程中不要回头重读整张表；每个词只按设置读 1–3 遍。点「下一个」之前先等孩子写好。</p>
      <div class="row">
        <a class="btn ghost" href="#/">中途退出</a>
        <button class="btn danger" id="abortBtn">放弃这次听写</button>
      </div>
    </div>`;

  let played = false;

  document.getElementById('playBtn').onclick = () => {
    if (idx < 0) { idx = 0; persist(); }
    speak(order[idx]);
    played = true;
    paint();
  };
  document.getElementById('slowBtn').onclick = () => {
    if (idx < 0) return;
    speak(order[idx], true);
  };
  document.getElementById('nextBtn').onclick = () => {
    if (idx >= order.length - 1) return;
    idx += 1;
    persist();
    played = false;
    paint();
    speak(order[idx]);
    played = true;
    paint();
  };
  document.getElementById('finishBtn').onclick = () => { location.hash = `#/finish/${id}`; };
  document.getElementById('abortBtn').onclick = async () => {
    if (!confirm('放弃并删除这次听写？')) return;
    sessionStorage.removeItem(`order-${id}`); sessionStorage.removeItem(`idx-${id}`);
    try { await api(`/api/sessions/${id}`, { method: 'DELETE' }); location.hash = '#/'; }
    catch (e) { fail(e); }
  };

  paint();
  if (idx < 0) {
    // 自动读第一个，减少一次空点
    idx = 0; persist(); speak(order[0]); played = true; paint();
  }
}

async function renderFinish(id) {
  view.innerHTML = `
    <div class="card">
      <h2>最后一步：拍孩子的答卷</h2>
      <p class="muted">把听写写出来的纸拍清楚再上传，AI 会核对拼写并指出错误。</p>
      ${photoInput('answerPhoto')}
      <div style="margin-top:12px"><button class="btn big" id="gradeBtn">提交判分</button></div>
      <div id="gradeBusy" class="muted" style="display:none">正在判分，大约要 10–30 秒…</div>
    </div>`;
  wirePhotoPreview('answerPhoto');
  document.getElementById('gradeBtn').onclick = async () => {
    const f = document.getElementById('answerPhoto').files[0];
    if (!f) { alert('请先拍照或选一张照片'); return; }
    const busy = document.getElementById('gradeBusy');
    busy.style.display = 'block';
    try {
      await withPhoto(`/api/sessions/${id}/complete`, await compressImage(f));
      sessionStorage.removeItem(`order-${id}`); sessionStorage.removeItem(`idx-${id}`);
      location.hash = `#/result/${id}`;
    } catch (e) { busy.style.display = 'none'; fail(e); }
  };
}

async function renderResult(id) {
  let s;
  try { s = await api(`/api/sessions/${id}`); } catch (e) { return fail(e); }
  const pct = Math.round((s.score || 0) * 100);
  const r = s.results || { attempts: [], missing: [], notes: '' };
  const wrong = r.attempts.filter((a) => !a.correct);

  const wrongRows = wrong.map((a) =>
    `<tr><td>${esc(a.written) || '<span class="muted">(空)</span>'}</td><td>${esc(a.expected)}</td></tr>`).join('');
  const okRows = r.attempts.filter((a) => a.correct).map((a) => a.expected).join('、');
  const revAdded = r.review_added || [];
  const revGrad = r.review_graduated || [];

  view.innerHTML = `
    <div class="card">
      <div class="score-wrap">
        <div class="score-circle" style="--p:${pct}; --c:${scoreColor(pct)}">
          <div class="inner" style="color:${scoreColor(pct)}">${pct}%</div>
        </div>
        <div>
          <h2 style="margin:0">#${s.id} · ${esc(fmtDateTime(s.completed_at))}</h2>
          <p>写对 <b class="ok">${s.correct_count ?? r.attempts.filter((a) => a.correct).length}</b> / ${s.total ?? (s.words || []).length} 个</p>
          ${r.notes ? `<p class="muted">${esc(r.notes)}</p>` : ''}
        </div>
      </div>
    </div>

    ${wrong.length ? `<div class="card">
      <h2>写错的词（${wrong.length}）</h2>
      <table class="results"><tr><th>孩子写的</th><th>应该是</th></tr>${wrongRows}</table>
    </div>` : '<div class="card"><h2 class="ok">全对！🎉</h2></div>'}

    ${r.missing && r.missing.length ? `<div class="card">
      <h2>漏掉的词（${r.missing.length}）</h2>
      <p>${r.missing.map((w) => `<span class="chip">${esc(w)}</span>`).join(' ')}</p>
    </div>` : ''}

    ${(revAdded.length || revGrad.length) ? `<div class="card">
      <h2>复习池</h2>
      ${revAdded.length ? `<p>这几个词已进复习池，下次核对单词表时会建议带上：</p>
        <p>${revAdded.map((w) => `<span class="chip">${esc(w)}</span>`).join(' ')}</p>` : ''}
      ${revGrad.length ? `<p class="muted">🎓 这次写对了，已从复习池毕业：${revGrad.map((w) => esc(w)).join('、')}</p>` : ''}
    </div>` : ''}

    <div class="card">
      <h2>写对的词</h2>
      <p class="muted">${esc(okRows) || '（无）'}</p>
      ${s.answer_photo ? `<a class="photo-link" href="/api/sessions/${id}/photo/answer" target="_blank"><img class="preview" src="/api/sessions/${id}/photo/answer" alt="答卷照片"></a>` : ''}
      <a class="btn ghost" href="#/history">看历史</a> <a class="btn ghost" href="#/">回首页</a>
    </div>`;
}

async function renderHistory() {
  let sessions;
  try { sessions = await api('/api/sessions?status=done&limit=200'); } catch (e) { return fail(e); }
  const groups = {};
  for (const s of sessions) (groups[s.week] ||= []).push(s);
  const weeks = Object.keys(groups).sort().reverse();

  view.innerHTML = `<div class="card">
    <h2>听写历史（${sessions.length} 次）</h2>
    ${weeks.length ? weeks.map((wk) => `
      <div class="week-group">${esc(wk)}</div>
      ${groups[wk].map((s) => {
        const pct = Math.round((s.score || 0) * 100);
        const bad = ((s.results || {}).attempts || []).filter((a) => !a.correct).length
          + ((s.results || {}).missing || []).length;
        return `<a class="sess-row" href="#/result/${s.id}">
          <span>${esc(fmtDateTime(s.completed_at))} · ${s.total ?? (s.words || []).length} 词 · 错 ${bad}</span>
          <span class="score-mini ${scoreClass(pct)}" style="color:${scoreColor(pct)}">${pct}%</span>
        </a>`;
      }).join('')}
    `).join('') : '<div class="muted">还没有完成过听写</div>'}
  </div>`;
}

async function renderReviewPool() {
  let review;
  try { review = await api('/api/review'); } catch (e) { return fail(e); }
  const pool = review.words || [];

  view.innerHTML = `<div class="card">
    <h2>复习池（${pool.length}）</h2>
    ${pool.length ? `
      <div class="chips" id="poolChips">${pool.map((p) =>
        `<span class="chip" title="上次写错：${esc(fmtDateTime(p.last_wrong_at))}">${esc(p.word)} ×${p.wrong_count}<button data-word="${esc(p.word)}" title="已掌握，从复习池移除">✕</button></span>`).join('')}</div>
      <p class="muted">点 ✕ 移除已经掌握的词；听写里写对一次也会自动出池（毕业）。</p>
    ` : '<p class="muted">复习池是空的——听写里写错或漏写的词会自动进来，下次核对单词表时会建议加上。</p>'}
    <a class="btn big" href="#/new">开始新听写</a>
  </div>`;

  view.querySelectorAll('#poolChips button').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/review/${encodeURIComponent(b.dataset.word)}`, { method: 'DELETE' });
        renderReviewPool();
      } catch (e) { fail(e); }
    };
  });
}

/* --------------------------------------------------------------- router */

function route() {
  cancelTTS();
  const parts = (location.hash.replace(/^#\//, '') || '').split('/');
  const name = parts[0] || '';
  const id = parts[1] ? Number(parts[1]) : null;
  document.querySelectorAll('nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === `#/${name}`);
  });
  if (name === 'new') renderNew();
  else if (name === 'edit') renderEdit(id);
  else if (name === 'run') renderRun(id);
  else if (name === 'finish') renderFinish(id);
  else if (name === 'result') renderResult(id);
  else if (name === 'history') renderHistory();
  else if (name === 'review') renderReviewPool();
  else renderHome();
}

window.addEventListener('hashchange', route);
route();
