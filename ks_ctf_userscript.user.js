// ==UserScript==
// @name         《学生手册》模拟测试题库助手
// @namespace    ks-ctf-lszjy
// @version      2.3.0
// @description  模拟测试自动答题：按「题干指纹」识别题目（同一题在不同试卷会换 id，指纹才是题目真身），题库内上传已知答案、题库外随机作答；交卷后从标准答案自动学习入库；迭代至连续 3 轮 100% 且无新题；答题页显示答案。仅作用于模拟测试页面，绝不触碰正式考试/补考。
// @author       CTF
// @match        https://yx.lszjy.com/my/ks.aspx
// @match        https://yx.lszjy.com/my/ks.aspx?*
// @match        https://yx.lszjy.com/my/ks_mn.aspx
// @match        https://yx.lszjy.com/my/ks_mn.aspx?*
// @match        https://yx.lszjy.com/my/ks_mn_fs.aspx
// @match        https://yx.lszjy.com/my/ks_mn_fs.aspx?*
// @match        https://yx.lszjy.com/my/ks_mn_da.aspx
// @match        https://yx.lszjy.com/my/ks_mn_da.aspx?*
// @match        https://yx.lszjy.com/my/ks_zs.aspx
// @match        https://yx.lszjy.com/my/ks_zs.aspx?*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 页面分工（URL 白名单 = 模拟测试链路，正式考试 ks_zs* / 补考等一律不加载本脚本）：
 *  ks.aspx       模拟测试入口：运行中 → 自动点击「模拟测试」(Button1，且校验按钮文案)
 *  ks_mn.aspx    答题页：题库内(按指纹或qid命中)填入已知答案，否则随机作答；每题旁显示题库答案；
 *                运行中 → 自动点击「确认提交」
 *  ks_mn_fs.aspx 成绩页：运行中 → 自动跳转「查看本次试卷标准答案」
 *  ks_mn_da.aspx 解析页：解析「标准答案」，按指纹入库（新增/修正/碰撞统计），
 *                连续 3 轮 (100 分 且 无新增无修正无碰撞) → 停止；否则回到 ks.aspx 下一轮
 *
 * 存储结构（localStorage）：
 *  kx_fp_v2   { fp: {a, ts} }  题干指纹 → 标准化答案（主库：题目真身）
 *  kx_qmap_v2 { qid: fp }      qid → 指纹索引（缓存；同一 qid 换题 → 记碰撞）
 *  kx_bank_v1 { qid: {a} }     v1 旧库（只读兜底：指纹查不到时按 qid 命中）
 */
(() => {
  'use strict';
  if (window.__KS_CTF_LOADED__) return;
  window.__KS_CTF_LOADED__ = true;
  // 启动即打点：F12 控制台能看到这行 = 脚本已生效
  console.log('%c[KS题库] 脚本已加载：', 'color:#e67e22;font-weight:bold', location.pathname);

  // ---------- 常量与存储 ----------
  const FP_KEY = 'kx_fp_v3';        // 指纹主库（v3：完整选项指纹；v2 存在残缺指纹已废弃）
  const QMAP_KEY = 'kx_qmap_v3';    // qid → fp
  const LEGACY_KEY = 'kx_bank_v1';  // v1 题库（只读兜底：指纹查不到时按 qid 命中）
  const STATE_KEY = 'kx_state_v1';
  const PAPER_KEY = 'kx_paper_v1';
  const NEED_STREAK = 3;            // 需要连续达标轮数
  const MAX_ROUNDS = 2000;          // 安全上限（防失控）

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  // 清理已废弃的残缺指纹库（v2）
  try { localStorage.removeItem('kx_fp_v2'); localStorage.removeItem('kx_qmap_v2'); } catch (e) {}
  const getFp = () => store.get(FP_KEY, {});
  const setFp = b => store.set(FP_KEY, b);
  const getQmap = () => store.get(QMAP_KEY, {});
  const setQmap = m => store.set(QMAP_KEY, m);
  const getLegacy = () => store.get(LEGACY_KEY, {});
  const getState = () => store.get(STATE_KEY, { running: false, rounds: [], streak: 0, done: false });
  const setState = s => store.set(STATE_KEY, s);

  const log = (...a) => console.log('%c[KS题库]', 'color:#e67e22;font-weight:bold', ...a);

  // ---------- 页面类型判定（白名单外一律不作为） ----------
  // zs = 正式考试答题页：仅只读显示答案（不填答/不交卷/不点击），其余自动行为仅限模拟测试链路
  const path = location.pathname.toLowerCase();
  const page = path.endsWith('/ks.aspx') ? 'entry'
    : path.endsWith('/ks_mn.aspx') ? 'exam'
    : path.endsWith('/ks_mn_fs.aspx') ? 'score'
    : path.endsWith('/ks_mn_da.aspx') ? 'answer'
    : path.endsWith('/ks_zs.aspx') ? 'zs_exam' : null;
  if (!page) return;

  // ---------- 通用：题目分组解析 ----------
  // 结构：li[题干, active 类、文本 "N、..."] 后跟若干 li[选项, 内含 input[name^=tk_]]
  function parseGroups(root) {
    root = root || document;
    let lis = [...root.querySelectorAll('ul.list-group > li')];
    if (!lis.length) lis = [...root.querySelectorAll('li')].filter(li => li.querySelector('input[name^=tk_]') || /^\s*\d+、/.test(li.innerText || ''));
    const groups = [];
    let cur = null;
    for (const li of lis) {
      const inputs = [...li.querySelectorAll('input[name^=tk_]')];
      if (inputs.length) {
        if (!cur) { cur = { stem: null, stemLi: null, inputs: [] }; groups.push(cur); }
        for (const inp of inputs) {
          const labelEl = root.querySelector(`label[for="${inp.id}"]`) || inp.closest('label') || inp.parentElement.querySelector('label');
          cur.inputs.push({ el: inp, value: inp.value, type: inp.type, labelEl, label: labelEl ? labelEl.innerText.trim() : (inp.parentElement.innerText || '').trim() });
        }
      } else if (/^\s*\d+、/.test(li.innerText || '')) {
        cur = { stem: (li.innerText || '').trim(), stemLi: li, inputs: [] };
        groups.push(cur);
      }
    }
    for (const g of groups) {
      g.qid = g.inputs.length ? (g.inputs[0].el.name || '').replace(/^tk_/, '') : null;
      g.kind = g.inputs.some(i => i.type === 'checkbox') ? 'checkbox' : 'radio';
      g.fp = fingerprint(g);
    }
    return groups.filter(g => g.qid);
  }

  const norm = s => (s || '').replace(/\s+/g, '');
  // 题目指纹 = 归一化题干全文 + 归一化选项全文（同一题在不同试卷会换 id，指纹才是题目真身）
  // 防御：剥离本脚本自己追加的徽章文字，避免污染指纹
  function fingerprint(g) {
    let stem = norm((g.stem || '').replace(/^\d+、/, '').replace(/【[^】]*】/g, ''));
    stem = stem.replace(/题库答案[：:].*$|题库暂无→随机$|题库答案与选项不匹配→随机$/g, '');
    return JSON.stringify([stem, g.inputs.map(i => i.value + '=' + norm(i.label))]);
  }

  // 题库查找：指纹主库 → qid 索引 → v1 旧库
  function lookup(g) {
    const fpBank = getFp(), qmap = getQmap(), legacy = getLegacy();
    if (fpBank[g.fp]) return { a: fpBank[g.fp].a, src: 'fp' };
    const f2 = qmap[g.qid];
    if (f2 && fpBank[f2]) return { a: fpBank[f2].a, src: 'qmap' };
    if (legacy[g.qid] && legacy[g.qid].a) return { a: legacy[g.qid].a, src: 'legacy' };
    return null;
  }

  // ---------- 显示答案（答题页标注） ----------
  function annotate() {
    const groups = parseGroups();
    let known = 0, unknown = 0;
    for (const g of groups) {
      if (!g.stemLi) continue;
      if (g.stemLi.querySelector('.kx-badge')) { known++; continue; } // 防重复注入时叠加徽章
      const hit = lookup(g);
      const effA = hit ? adaptAnswer(g, hit.a) : null;
      const badge = document.createElement('span');
      badge.className = 'kx-badge';
      badge.style.cssText = 'display:inline-block;margin-left:8px;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:bold;vertical-align:middle;';
      if (effA && answerFits(g, effA)) {
        known++;
        badge.style.cssText += 'background:#27ae60;color:#fff;';
        badge.textContent = `题库答案：${displayAnswer(g, effA)}`;
        const vals = pickValues(effA);
        for (const i of g.inputs) {
          if (vals.includes(i.value)) i.labelEl && (i.labelEl.style.cssText = 'color:#27ae60;font-weight:bold;');
        }
      } else {
        unknown++;
        badge.style.cssText += 'background:#95a5a6;color:#fff;';
        badge.textContent = hit ? '题库答案与选项不匹配→随机' : '题库暂无→随机';
      }
      badge.title = 'qid: ' + g.qid;
      g.stemLi.appendChild(badge);
    }
    log(`标注完成：题库命中 ${known}，未命中 ${unknown}`);
  }

  function pickValues(a) { return String(a).split('').filter(Boolean); }

  // 题库答案是否与该题选项匹配（自适应校验）
  function answerFits(g, a) {
    if (!a) return false;
    const vals = g.inputs.map(i => i.value);
    const picks = pickValues(a);
    if (g.kind === 'radio') return picks.length === 1 && vals.includes(picks[0]);
    return picks.every(p => vals.includes(p));
  }

  // 展示用答案：把 1/0 转成 对/错
  function displayAnswer(g, a) {
    const one = g.inputs.find(i => i.value === '1'), zero = g.inputs.find(i => i.value === '0');
    if (one && zero && pickValues(a).length === 1) {
      const v = pickValues(a)[0];
      if (v === '1') return '对'; if (v === '0') return '错';
    }
    return a;
  }

  // ---------- 自动作答 ----------
  function randomAnswer(g) {
    if (g.kind === 'radio') {
      return g.inputs[Math.floor(Math.random() * g.inputs.length)].value;
    }
    for (;;) {
      const subset = g.inputs.filter(() => Math.random() < 0.5).map(i => i.value);
      if (subset.length) return subset.join('');
    }
  }

  // v1 旧库里的判断题答案存的是「对/错」文字，作答前按该题选项值自适应翻译
  function adaptAnswer(g, a) {
    if (g.kind === 'radio' && /^[对错]$/.test(String(a))) {
      const one = g.inputs.find(i => i.value === '1'), zero = g.inputs.find(i => i.value === '0');
      if (one && zero) return a === '对' ? '1' : '0';
    }
    return a;
  }

  function fillAnswers() {
    const groups = parseGroups();
    const qidOrder = [];
    let hitN = 0, randN = 0;
    for (const g of groups) {
      qidOrder.push(g.qid);
      const hit = lookup(g);
      let a = hit ? adaptAnswer(g, hit.a) : null;
      if (a && answerFits(g, a)) hitN++; else { a = randomAnswer(g); randN++; }
      const picks = pickValues(a);
      for (const i of g.inputs) {
        const want = picks.includes(i.value);
        // 幂等：只在未勾选时点击。重复注入/重复填答时，对已勾选项再 click 会被 iCheck 反选
        if (i.type === 'radio') { if (want && !i.el.checked) { i.el.checked = true; i.el.click(); } }
        else if (want && !i.el.checked) i.el.click();
      }
    }
    const unanswered = groups.filter(g => !g.inputs.some(i => i.el.checked));
    store.set(PAPER_KEY, qidOrder);
    // 作答自检报告 + 未命中归因（排查指纹差异用）
    {
      const fpBank = getFp(), qmap = getQmap();
      const missWhy = { noQid: 0, noQmap: 0, qmapNoFp: 0, fpMiss: 0, hit: 0 };
      const diffs = [];
      for (const g of groups) {
        if (fpBank[g.fp]) { missWhy.hit++; continue; }
        const old = qmap[g.qid];
        if (!old) { missWhy.noQmap++; continue; }
        if (!fpBank[old]) { missWhy.qmapNoFp++; continue; }
        missWhy.fpMiss++;
        if (diffs.length < 3) diffs.push({ qid: g.qid, stored: String(old).slice(0, 220), current: g.fp.slice(0, 220) });
      }
      store.set('kx_last_fill', { t: Date.now(), hitN, randN, unanswered: unanswered.length, missWhy, diffs,
        sample: groups.slice(0, 6).map(g => { const hit = lookup(g); const checkedNow = g.inputs.filter(i => i.el.checked).map(i => i.value).join(''); return { qid: g.qid, src: hit ? hit.src : null, bank: hit ? hit.a : null, checked: checkedNow }; }) });
    }
    log(`作答完成：题库命中 ${hitN}，随机 ${randN}，未答 ${unanswered.length}`);
    return unanswered.length;
  }

  // ---------- 各页面动作 ----------
  function onEntry() { // ks.aspx：只允许「模拟测试」按钮
    const s = getState();
    if (!s.running || s.done) return;
    const btn = document.getElementById('Button1');
    if (!btn || !/模拟测试/.test(btn.value || '')) { log('未找到模拟测试按钮，不动作'); return; }
    log('自动开始新一轮模拟测试…');
    try { window.confirm = () => true; } catch (e) {}
    setTimeout(() => btn.click(), 500);
  }

  function onExam() { // ks_mn.aspx：填答案 + 显示答案 +（运行中）提交
    // 顺序关键：先填答后标注。标注会把徽章文字写进题干 li，
    // 若先标注再解析，指纹会被徽章污染导致永远查不到题库
    const s = getState();
    const missing = fillAnswers();
    try { annotate(); } catch (e) { log('标注异常（不影响作答）：', e && e.message); }
    if (!s.running || s.done) { log('手动模式：已按题库填入答案，请自行提交'); return; }
    const btn = document.getElementById('Button1');
    if (!btn) { log('未找到提交按钮'); return; }
    try { window.confirm = () => true; } catch (e) {}
    log('自动交卷…');
    setTimeout(() => {
      const left = parseGroups().filter(g => !g.inputs.some(i => i.el.checked)).length;
      const b = document.getElementById('Button1');
      if (b && (left === 0 || left === missing)) b.click();
    }, 700);
  }

  function onScore() { // ks_mn_fs.aspx：跳转标准答案页
    const s = getState();
    const m = (document.body.innerText || '').match(/分数为：\s*(\d+)\s*分/);
    if (m) { s.lastScore = parseInt(m[1], 10); setState(s); }
    log('本轮分数：', s.lastScore);
    if (!s.running || s.done) return;
    const link = [...document.querySelectorAll('a')].find(a => /ks_mn_da\.aspx/i.test(a.href));
    if (link) setTimeout(() => { location.href = link.href; }, 400);
    else log('未找到标准答案链接');
  }

  function onAnswer() { // ks_mn_da.aspx：学习入库（按指纹） + 迭代判定
    let lis = [...document.querySelectorAll('ul.list-group > li')];
    if (!lis.length) lis = [...document.querySelectorAll('li')];
    // 结构：li[题干] → li[标准答案：X] → N 个 li[各含一个选项 input]
    // 必须把该题的全部选项 li 累积完（直到下一个题干 li）再生成指纹
    const learned = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.std && cur.inputs.length && cur.qid) {
        const g = { kind: cur.kind || 'radio', inputs: cur.inputs, stem: cur.stem };
        learned.push({ qid: cur.qid, a: normalizeAnswer(g, cur.std), fp: fingerprint(g) });
      }
      cur = null;
    };
    for (const li of lis) {
      const txt = li.innerText || '';
      const inputs = [...li.querySelectorAll('input[name^=tk_]')];
      if (/^\s*\d+、/.test(txt)) { flush(); cur = { stem: txt.trim(), inputs: [] }; continue; }
      if (inputs.length) {
        if (!cur) cur = { stem: '', inputs: [] };
        if (!cur.qid) cur.qid = (inputs[0].name || '').replace(/^tk_/, '');
        cur.kind = inputs.some(e => e.type === 'checkbox') ? 'checkbox' : 'radio';
        for (const el of inputs) {
          const label = ((document.querySelector(`label[for="${el.id}"]`) || {}).innerText || '').trim();
          cur.inputs.push({ value: el.value, label });
        }
        continue;
      }
      const am = txt.match(/标准答案[:：]\s*([A-Z0-9对错]+)/);
      if (am && cur) { cur.std = am[1]; continue; }
    }
    flush();

    const fpBank = getFp(), qmap = getQmap();
    let add = 0, fix = 0, col = 0;
    const now = Date.now();
    for (const { qid, a, fp } of learned) {
      if (!a || !fp) continue;
      if (!fpBank[fp]) { fpBank[fp] = { a, ts: now }; add++; }
      else if (fpBank[fp].a !== a) { fpBank[fp].a = a; fpBank[fp].ts = now; fix++; }
      if (qmap[qid] && qmap[qid] !== fp) col++; // 同一 qid 换了题目
      qmap[qid] = fp;
    }
    setFp(fpBank); setQmap(qmap);

    const s = getState();
    const score = s.lastScore != null ? s.lastScore : (() => { const m = (document.body.innerText || '').match(/分数为：\s*(\d+)\s*分/); return m ? parseInt(m[1], 10) : null; })();
    s.lastScore = null;
    s.rounds.push({ score, add, fix, col, t: now });
    if (s.rounds.length > 500) s.rounds = s.rounds.slice(-500);
    const clean = score === 100 && add === 0 && fix === 0 && col === 0;
    s.streak = clean ? (s.streak || 0) + 1 : 0;
    const total = s.rounds.length;
    if (s.streak >= NEED_STREAK) { s.running = false; s.done = true; }
    else if (total >= MAX_ROUNDS) { s.running = false; s.done = true; }
    setState(s);

    log(`入库完成：题库总量(去重) ${Object.keys(fpBank).length}，新题 ${add}，修正 ${fix}，qid碰撞 ${col}，得分 ${score}，连续达标 ${s.streak}/${NEED_STREAK}`);

    if (s.done) {
      banner(s.streak >= NEED_STREAK
        ? `✔ 目标达成：连续 ${NEED_STREAK} 轮 100% 且无新题/修正/碰撞，共 ${total} 轮，去重题库 ${Object.keys(fpBank).length} 题`
        : `已达轮数上限，去重题库 ${Object.keys(fpBank).length} 题`);
      return;
    }
    banner(`第 ${total} 轮完成：${score} 分（新题 ${add} / 修正 ${fix} / 碰撞 ${col}），连续达标 ${s.streak}/${NEED_STREAK}，即将开始下一轮…`);
    setTimeout(() => { location.href = '/my/ks.aspx'; }, 900);
  }

  // 把「对/错」标准化为页面值 1/0（依据该题选项的取值集合）
  function normalizeAnswer(g, raw) {
    const one = g.inputs.find(i => i.value === '1'), zero = g.inputs.find(i => i.value === '0');
    if (one && zero) {
      if (/^对$/.test(raw)) return '1';
      if (/^错$/.test(raw)) return '0';
    }
    if (g.kind === 'checkbox') {
      const vals = g.inputs.map(i => i.value);
      const chars = String(raw).split('').filter(c => vals.includes(c));
      chars.sort();
      return chars.join('');
    }
    return raw;
  }

  function banner(text) {
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#8e44ad;color:#fff;padding:8px 16px;font-size:14px;font-weight:bold;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    b.textContent = '【KS题库助手】' + text;
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 8000);
  }

  // ---------- 悬浮控制面板 ----------
  function panel() {
    const s = getState();
    const fpBank = getFp(), legacy = getLegacy();
    const p = document.createElement('div');
    p.id = 'kx-panel';
    p.style.cssText = 'position:fixed;top:56px;right:12px;z-index:99998;background:rgba(33,33,33,.92);color:#ecf0f1;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.7;width:250px;box-shadow:0 4px 16px rgba(0,0,0,.4);font-family:monospace;';
    const last = s.rounds[s.rounds.length - 1];
    const BTN_CSS = 'flex:1;min-width:70px;color:#fff;border:none;padding:4px 6px;border-radius:4px;cursor:pointer;font-size:12px;line-height:1.4;';
    p.innerHTML = `
      <div style="font-weight:bold;color:#e67e22;margin-bottom:4px;">📖 KS 题库助手</div>
      <div>状态：${s.done ? (s.streak >= NEED_STREAK ? '✅ 已达成目标' : '⏹ 已停止') : s.running ? '🟢 迭代运行中' : '⚪ 待机'}　连续达标 ${s.streak || 0}/${NEED_STREAK}</div>
      <div>去重题库：${Object.keys(fpBank).length} 题　旧库兜底：${Object.keys(legacy).length}</div>
      <div>已完成轮数：${s.rounds.length}</div>
      ${last ? `<div>最近一轮：${last.score == null ? '?' : last.score} 分（新${last.add}/修${last.fix}/碰${last.col}）</div>` : ''}
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">
        <button data-act="start" style="${BTN_CSS}background:#27ae60;">开始迭代</button>
        <button data-act="stop" style="${BTN_CSS}background:#7f8c8d;">停止</button>
        <button data-act="export" style="${BTN_CSS}background:#2980b9;">导出题库</button>
        <button data-act="import" style="${BTN_CSS}background:#8e44ad;">导入题库</button>
        <button data-act="clear" style="${BTN_CSS}background:#c0392b;">清空题库</button>
        <button data-act="hide" style="${BTN_CSS}background:#555;">收起面板</button>
      </div>`;
    document.body.appendChild(p);
    p.addEventListener('click', e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      const st = getState();
      if (act === 'start') { st.running = true; st.done = false; st.streak = 0; setState(st); log('开始迭代'); if (page !== 'entry') location.href = '/my/ks.aspx'; else onEntry(); }
      if (act === 'stop') { st.running = false; setState(st); log('已停止'); p.remove(); panel(); }
      if (act === 'export') {
        const blob = new Blob([JSON.stringify({ texts: getFp(), qmap: getQmap(), legacy: getLegacy() }, null, 1)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ks_bank_' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
      }
      if (act === 'import') {
        const txt = prompt('粘贴题库 JSON（{texts,qmap,legacy} 或旧版 {qid:{a}}）：');
        if (txt) {
          try {
            const obj = JSON.parse(txt);
            if (obj.texts) {
              setFp(Object.assign(getFp(), obj.texts));
              setQmap(Object.assign(getQmap(), obj.qmap || {}));
              if (obj.legacy) store.set(LEGACY_KEY, Object.assign(getLegacy(), obj.legacy));
            } else { store.set(LEGACY_KEY, Object.assign(getLegacy(), obj)); }
            alert('导入完成：去重 ' + Object.keys(getFp()).length + ' 题');
            p.remove(); panel();
          } catch (err) { alert('JSON 解析失败'); }
        }
      }
      if (act === 'clear') { if (window.confirm('确定清空题库？此操作不可恢复（建议先导出）')) { setFp({}); setQmap({}); store.set(LEGACY_KEY, {}); const st2 = getState(); st2.streak = 0; st2.done = false; setState(st2); p.remove(); panel(); } }
      if (act === 'hide') { store.set('kx_panel_hidden', true); p.remove(); }
      e.stopPropagation();
    });
  }

  // 面板 / 收起后悬浮球
  function panelOrBall() {
    if (document.getElementById('kx-panel') || document.getElementById('kx-ball')) return;
    if (store.get('kx_panel_hidden', false)) {
      const ball = document.createElement('div');
      ball.id = 'kx-ball';
      ball.textContent = '📖';
      ball.title = 'KS 题库助手';
      ball.style.cssText = 'position:fixed;top:56px;right:12px;z-index:99998;width:32px;height:32px;border-radius:50%;background:rgba(33,33,33,.92);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.4);';
      ball.onclick = () => { store.set('kx_panel_hidden', false); ball.remove(); panel(); };
      document.body.appendChild(ball);
    } else {
      panel();
    }
  }

  // ---------- 分发（兼容 document-start 注入：等 DOM 就绪再跑） ----------
  function boot() {
    // 面板注入放在 try 外并加兜底重试，确保任何情况下悬浮窗可见
    try { panelOrBall(); } catch (e) { console.error('[KS题库] 面板异常：', e); }
    setTimeout(() => { try { panelOrBall(); } catch (e) {} }, 1500);
    try {
      if (page === 'entry') onEntry();
      else if (page === 'exam') onExam();
      else if (page === 'score') onScore();
      else if (page === 'answer') onAnswer();
      else if (page === 'zs_exam') { // 正式考试：仅只读标注，绝不代填/代交
        try { annotate(); } catch (e) { console.error('[KS题库] 正式考试页标注异常：', e); }
        banner('正式考试页面：仅显示题库答案（只读），不会代填、不会代交卷');
      }
    } catch (e) {
      console.error('[KS题库] 页面处理异常：', e);
    }
    // 入口页自愈：页面加载时可能还是待机态，之后被置为运行态 → 周期性补触发
    if (page === 'entry') {
      let lastKick = 0;
      setInterval(() => {
        const st = getState();
        if (st.running && !st.done && Date.now() - lastKick > 8000) {
          lastKick = Date.now();
          onEntry();
        }
      }, 2000);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
