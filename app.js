/* 미국주식 매매장부 — 완전 로컬(IndexedDB), 현재가/평가손익 없음.
 * 실현손익 계산: 이동평균법 (매수 시 평균단가 갱신, 매도 시 평균단가 기준으로 손익 확정)
 */
'use strict';

const ACC = { MAIN: '주계좌', DIV: '배당계좌' };
const TYPE = { BUY: '매수', SELL: '매도', DEPOSIT: '입금', WITHDRAW: '출금' };
const EPS = 1e-9;

/* ================= IndexedDB ================= */
const DB = (() => {
  let db = null;
  let memory = null; // IndexedDB를 못 쓰는 환경용 대체
  function open() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) { memory = { events: new Map(), notes: new Map() }; return resolve(); }
      const req = indexedDB.open('us-stock-ledger', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      };
      req.onsuccess = () => { db = req.result; resolve(); };
      req.onerror = () => { memory = { events: new Map(), notes: new Map() }; resolve(); };
    });
  }
  function tx(store, mode, fn) {
    if (memory) return Promise.resolve(fn(null, memory[store]));
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      const r = fn(s);
      if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  return {
    open,
    get usingMemory() { return !!memory; },
    all: (store) => tx(store, 'readonly', (s, m) => m ? [...m.values()] : s.getAll()),
    put: (store, obj) => tx(store, 'readwrite', (s, m) => m ? m.set(obj.id, obj) : s.put(obj)),
    del: (store, id) => tx(store, 'readwrite', (s, m) => m ? m.delete(id) : s.delete(id)),
    replaceAll: (store, list) => tx(store, 'readwrite', (s, m) => {
      if (m) { m.clear(); list.forEach(o => m.set(o.id, o)); return; }
      s.clear(); list.forEach(o => s.put(o));
    }),
  };
})();

/* ================= 상태 ================= */
const state = {
  acc: load('acc', 'ALL'),
  tab: load('tab', 'home'),
  ticker: null,
  events: [],
  notes: [],
  calc: null,
  filters: { tradesYear: 'ALL', tradesType: 'ALL', tradesQ: '', tickerQ: '', diaryQ: '' },
};
function load(k, d) { try { return localStorage.getItem('ledger.' + k) || d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem('ledger.' + k, v); } catch { /* 무시 */ } }

/* ================= 포맷 ================= */
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function money(n) {
  const v = round2(Math.abs(n));
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return (n < 0 && v !== 0 ? '-$' : '$') + s;
}
function signed(n) {
  const v = round2(n);
  if (v === 0) return '$0';
  return (v > 0 ? '+' : '-') + money(Math.abs(v));
}
function cls(n) { const v = round2(n); return v > 0 ? 'gain' : v < 0 ? 'loss' : 'zero'; }
function pct(n) { if (!isFinite(n)) return ''; const v = Math.round(n * 1000) / 10; return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }
function qty(n) { return (+n).toLocaleString('en-US', { maximumFractionDigits: 4 }); }
function md(d) { return d ? d.slice(5).replace('-', '/') : ''; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function today() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function badge(acc) { return `<span class="badge ${acc}">${ACC[acc]}</span>`; }

/* ================= 계산 엔진 ================= */
function sortEvents(list) {
  return [...list].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0));
}

function compute(events) {
  const accounts = {};
  for (const k of Object.keys(ACC)) accounts[k] = { deposit: 0, withdraw: 0, cash: 0, realized: 0, positions: {} };
  const realized = [];      // 매도로 확정된 손익
  const timeline = {};      // "계좌|종목" -> 이벤트 목록 (사이클 포함)
  const errors = [];
  const byId = {};

  for (const e of sortEvents(events)) {
    const a = accounts[e.account];
    if (!a) continue;
    if (e.type === 'DEPOSIT') { a.deposit += e.amount; a.cash += e.amount; continue; }
    if (e.type === 'WITHDRAW') { a.withdraw += e.amount; a.cash -= e.amount; continue; }

    const key = e.account + '|' + e.ticker;
    const p = a.positions[e.ticker] || (a.positions[e.ticker] = { qty: 0, cost: 0, cycle: 0, lastDate: '' });
    const tl = timeline[key] || (timeline[key] = []);
    const fee = e.fee || 0;
    p.lastDate = e.date;

    if (e.type === 'BUY') {
      if (p.qty <= EPS) { p.qty = 0; p.cost = 0; p.cycle += 1; }
      const amount = e.qty * e.price;
      p.qty += e.qty;
      p.cost += amount + fee;
      a.cash -= amount + fee;
      const item = { ev: e, cycle: p.cycle, amount, afterQty: p.qty, afterAvg: p.cost / p.qty };
      tl.push(item); byId[e.id] = item;
    } else if (e.type === 'SELL') {
      if (e.qty > p.qty + EPS) {
        errors.push({ id: e.id, msg: `${e.date} ${ACC[e.account]} ${e.ticker}: 보유 ${qty(p.qty)}주인데 ${qty(e.qty)}주 매도` });
        continue;
      }
      const avg = p.cost / p.qty;
      const basis = avg * e.qty;
      const amount = e.qty * e.price;
      const proceeds = amount - fee;
      const pnl = proceeds - basis;
      p.qty -= e.qty;
      p.cost -= basis;
      if (p.qty <= EPS) { p.qty = 0; p.cost = 0; }
      a.cash += proceeds;
      a.realized += pnl;
      const r = { id: e.id, date: e.date, account: e.account, ticker: e.ticker, qty: e.qty, avg, price: e.price,
                  amount, basis, fee, pnl, pct: basis > 0 ? pnl / basis : NaN, memo: e.memo, cycle: p.cycle };
      realized.push(r);
      const item = { ev: e, cycle: p.cycle, amount, realized: r, afterQty: p.qty, afterAvg: p.qty ? p.cost / p.qty : 0 };
      tl.push(item); byId[e.id] = item;
    }
  }
  return { accounts, realized, timeline, errors, byId };
}

/* 계좌 필터 적용 요약 */
function accList() { return state.acc === 'ALL' ? Object.keys(ACC) : [state.acc]; }
function summary() {
  const c = state.calc;
  const s = { deposit: 0, withdraw: 0, cash: 0, realized: 0, holdCost: 0, holdings: [], realizedList: [] };
  for (const k of accList()) {
    const a = c.accounts[k];
    s.deposit += a.deposit; s.withdraw += a.withdraw; s.cash += a.cash; s.realized += a.realized;
    for (const [tk, p] of Object.entries(a.positions)) {
      if (p.qty > EPS) {
        s.holdings.push({ account: k, ticker: tk, qty: p.qty, avg: p.cost / p.qty, cost: p.cost, lastDate: p.lastDate });
        s.holdCost += p.cost;
      }
    }
  }
  s.holdings.sort((x, y) => y.cost - x.cost);
  s.realizedList = c.realized.filter(r => accList().includes(r.account));
  return s;
}

/* 종목별 집계 */
function tickerStats() {
  const c = state.calc;
  const map = {};
  for (const [key, items] of Object.entries(c.timeline)) {
    const [account, ticker] = key.split('|');
    if (!accList().includes(account)) continue;
    const t = map[ticker] || (map[ticker] = { ticker, realized: 0, sells: 0, wins: 0, holdQty: 0, holdCost: 0, lastDate: '', accounts: new Set() });
    t.accounts.add(account);
    for (const it of items) {
      if (it.ev.date > t.lastDate) t.lastDate = it.ev.date;
      if (it.realized) { t.realized += it.realized.pnl; t.sells += 1; if (round2(it.realized.pnl) > 0) t.wins += 1; }
    }
    const p = c.accounts[account].positions[ticker];
    if (p && p.qty > EPS) { t.holdQty += p.qty; t.holdCost += p.cost; }
  }
  return Object.values(map);
}

/* ================= 렌더 ================= */
const $view = document.getElementById('view');

function render() {
  document.querySelectorAll('#accountSeg button').forEach(b => b.classList.toggle('on', b.dataset.acc === state.acc));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  const views = { home: vHome, tickers: state.ticker ? vTicker : vTickers, holdings: vHoldings, trades: vTrades, cash: vCash, diary: vDiary, data: vData };
  let html = (views[state.tab] || vHome)();
  if (state.calc.errors.length) {
    html = `<div class="card pad" style="margin-bottom:12px;border-color:#c62828"><div class="err">계산 오류가 있는 거래가 있습니다 (매도 수량 &gt; 보유 수량). 해당 매도는 계산에서 제외됐습니다.</div>
      <div class="small muted" style="margin-top:6px">${state.calc.errors.map(e => esc(e.msg)).join('<br>')}</div></div>` + html;
  }
  $view.innerHTML = html;
}

function vHome() {
  const s = summary();
  const year = today().slice(0, 4);
  const yearPnl = s.realizedList.filter(r => r.date.startsWith(year)).reduce((x, r) => x + r.pnl, 0);
  const net = s.deposit - s.withdraw;
  let h = `
  <section class="card hero">
    <div class="label">💰 누적 실현손익 ${state.acc !== 'ALL' ? badge(state.acc) : ''}</div>
    <div class="big ${cls(s.realized)}">${signed(s.realized)}</div>
    <div class="meta">매도해서 확정된 손익만 · 매도 ${s.realizedList.length}건 · ${year}년 <b class="${cls(yearPnl)}">${signed(yearPnl)}</b></div>
  </section>
  <section class="stats">
    <div class="card stat"><div class="label">총 투입금</div><div class="val">${money(net)}</div>
      <div class="meta">입금 ${money(s.deposit)}${s.withdraw ? ' · 출금 ' + money(s.withdraw) : ''}</div></div>
    <div class="card stat"><div class="label">현재 현금</div><div class="val">${money(s.cash)}</div><div class="meta">계좌에 남은 달러</div></div>
    <div class="card stat"><div class="label">보유주식 매수금액</div><div class="val">${money(s.holdCost)}</div><div class="meta">${s.holdings.length}종목 · 산 가격 기준</div></div>
  </section>`;

  if (state.acc === 'ALL') {
    h += `<h2>계좌별</h2><section class="accgrid">`;
    for (const k of Object.keys(ACC)) {
      const a = state.calc.accounts[k];
      const hc = Object.values(a.positions).reduce((x, p) => x + p.cost, 0);
      h += `<div class="card acc" data-action="acc" data-acc="${k}">
        <h3>${ACC[k]}</h3>
        <div class="kv"><span>투입금</span><span>${money(a.deposit - a.withdraw)}</span></div>
        <div class="kv"><span>현재 현금</span><span>${money(a.cash)}</span></div>
        <div class="kv"><span>보유주식 매수금액</span><span>${money(hc)}</span></div>
        <div class="kv"><span>누적 실현손익</span><span class="${cls(a.realized)}">${signed(a.realized)}</span></div>
      </div>`;
    }
    h += `</section>`;
  }

  h += `<h2>현재 보유 <span class="sub">${s.holdings.length}종목</span></h2><section class="card list">`;
  h += s.holdings.length ? s.holdings.map(x => `
    <div class="row click" data-action="ticker" data-ticker="${esc(x.ticker)}">
      <div class="l"><span class="tk">${esc(x.ticker)}</span>${state.acc === 'ALL' ? badge(x.account) : ''}
        <span class="muted"> · ${qty(x.qty)}주 · 평균 ${money(x.avg)}</span></div>
      <div class="r muted small">${money(x.cost)}</div>
    </div>`).join('') : `<div class="empty">보유 중인 주식이 없습니다</div>`;
  h += `</section>`;

  const recent = [...s.realizedList].reverse().slice(0, 8);
  h += `<h2>최근 매매 <span class="sub">확정된 손익</span></h2><section class="card list">`;
  h += recent.length ? recent.map(realizedRow).join('') : `<div class="empty">아직 매도한 기록이 없습니다</div>`;
  h += `</section>`;
  if (!state.events.length) {
    h += `<p class="muted small" style="margin-top:18px">시작하기: <b>+ 입출금</b>으로 계좌에 넣은 돈을 기록한 뒤, <b>+ 매수</b> / <b>+ 매도</b>로 거래를 기록하세요.</p>`;
  }
  return h;
}

function realizedRow(r) {
  return `<div class="row click" data-action="ticker" data-ticker="${esc(r.ticker)}">
    <div class="l"><span class="muted small">${md(r.date)}</span> <span class="tk">${esc(r.ticker)}</span>${state.acc === 'ALL' ? badge(r.account) : ''}
      <div class="small muted">${qty(r.qty)}주 ${money(r.avg)} → ${money(r.price)}</div></div>
    <div class="r"><div class="pnl ${cls(r.pnl)}">${signed(r.pnl)}</div><div class="small ${cls(r.pnl)}">${pct(r.pct)}</div></div>
  </div>`;
}

function vTickers() {
  const q = state.filters.tickerQ.trim().toUpperCase();
  const list = tickerStats().filter(t => !q || t.ticker.includes(q)).sort((a, b) => b.lastDate.localeCompare(a.lastDate));
  const total = list.reduce((x, t) => x + t.realized, 0);
  let h = `<div class="toolbar"><input id="tickerQ" placeholder="종목 검색" value="${esc(state.filters.tickerQ)}" autocomplete="off">
    <span class="muted small" style="margin-left:auto">합계 <b class="${cls(total)}">${signed(total)}</b></span></div>
    <section class="card list">`;
  h += list.length ? list.map(t => `
    <div class="row click" data-action="ticker" data-ticker="${esc(t.ticker)}">
      <div class="l"><span class="tk">${esc(t.ticker)}</span>${state.acc === 'ALL' ? [...t.accounts].map(badge).join('') : ''}
        <div class="small muted">매도 ${t.sells}회${t.sells ? ` (익절 ${t.wins})` : ''} · ${t.holdQty > EPS ? `보유 ${qty(t.holdQty)}주 · 평균 ${money(t.holdCost / t.holdQty)}` : '보유 없음'}</div></div>
      <div class="r"><div class="pnl ${cls(t.realized)}">${signed(t.realized)}</div><div class="small muted">누적 실현</div></div>
    </div>`).join('') : `<div class="empty">종목 기록이 없습니다</div>`;
  return h + `</section>`;
}

function vTicker() {
  const tk = state.ticker;
  const c = state.calc;
  const accs = accList().filter(a => c.timeline[a + '|' + tk]);
  let realized = 0, holdQty = 0, holdCost = 0;
  for (const a of accs) {
    for (const it of c.timeline[a + '|' + tk]) if (it.realized) realized += it.realized.pnl;
    const p = c.accounts[a].positions[tk];
    if (p && p.qty > EPS) { holdQty += p.qty; holdCost += p.cost; }
  }
  let h = `<div class="toolbar"><button class="btn small" data-action="back">← 종목 목록</button>
    <span style="margin-left:auto"></span>
    <button class="btn small buy" data-new="BUY" data-ticker="${esc(tk)}">+ 매수</button>
    <button class="btn small sell" data-new="SELL" data-ticker="${esc(tk)}">+ 매도</button>
    <button class="btn small" data-new="NOTE" data-ticker="${esc(tk)}">+ 일기</button></div>
  <section class="card tkhead">
    <div><div class="name">${esc(tk)}</div>
      <div class="muted">${holdQty > EPS ? `현재 보유 <b style="color:var(--text)">${qty(holdQty)}주</b> · 평균매수가 <b style="color:var(--text)">${money(holdCost / holdQty)}</b> · 매수금액 ${money(holdCost)}` : '현재 보유 없음'}</div></div>
    <div><div class="muted small" style="text-align:right">${esc(tk)} 누적 실현손익</div><div class="big ${cls(realized)}">${signed(realized)}</div></div>
  </section>`;

  if (!accs.length) h += `<div class="card empty" style="margin-top:12px">${state.acc === 'ALL' ? '' : ACC[state.acc] + '에 '}이 종목의 거래가 없습니다</div>`;

  for (const a of accs) {
    const items = c.timeline[a + '|' + tk];
    const cycles = {};
    for (const it of items) (cycles[it.cycle] || (cycles[it.cycle] = [])).push(it);
    const nums = Object.keys(cycles).map(Number).sort((x, y) => y - x);
    if (accs.length > 1 || state.acc === 'ALL') h += `<h2>${ACC[a]}</h2>`;
    else h += `<h2>매매 기록</h2>`;
    for (const n of nums) {
      const its = cycles[n];
      const last = its[its.length - 1];
      const open = last.afterQty > EPS;
      const cyPnl = its.reduce((x, it) => x + (it.realized ? it.realized.pnl : 0), 0);
      const sells = its.filter(it => it.realized).length;
      h += `<section class="card cycle">
        <div class="cycle-h"><span>${n}번째 매매 <span class="muted small" style="font-weight:500">${md(its[0].ev.date)}${its.length > 1 ? ' ~ ' + md(last.ev.date) : ''}</span></span>
          <span class="st ${open ? 'open' : ''}">${open ? '보유 중' : '완료'}</span></div>`;
      for (const it of its) h += evRow(it);
      h += `<div class="cycle-f"><span class="muted">${open ? `남은 보유 ${qty(last.afterQty)}주 · 평균 ${money(last.afterAvg)}` : '전량 매도'}</span>
        <span>${sells ? `실현손익 <b class="pnl ${cls(cyPnl)}">${signed(cyPnl)}</b>` : '<span class="muted">아직 매도 없음</span>'}</span></div>
      </section>`;
    }
  }

  const notes = state.notes.filter(n => n.ticker === tk).sort((a, b) => b.date.localeCompare(a.date));
  if (notes.length) h += `<h2>${esc(tk)} 일기</h2><section class="card">${notes.map(noteRow).join('')}</section>`;
  return h;
}

function evRow(it) {
  const e = it.ev;
  const linked = state.notes.filter(n => n.tradeId === e.id).length;
  const memo = (e.memo ? `<div class="memo">${esc(e.memo)}</div>` : '') + (linked ? `<div class="memo">📝 연결된 일기 ${linked}개</div>` : '');
  const tools = `<div><button class="linkbtn" data-action="edit" data-id="${e.id}">수정</button><button class="linkbtn" data-action="del" data-id="${e.id}">삭제</button></div>`;
  if (e.type === 'BUY') {
    return `<div class="ev"><div class="d">${md(e.date)}</div>
      <div class="main"><span class="tag BUY">매수</span> <span class="flow">${qty(e.qty)}주 × ${money(e.price)}</span>
        <div class="sub">매수금액 ${money(it.amount)}${e.fee ? ` · 수수료 ${money(e.fee)}` : ''} · 매수 후 ${qty(it.afterQty)}주, 평균 ${money(it.afterAvg)}</div>${memo}</div>
      <div class="r">${tools}</div></div>`;
  }
  const r = it.realized;
  return `<div class="ev sell"><div class="d">${md(e.date)}</div>
    <div class="main"><span class="tag SELL">매도</span> <span class="flow">${qty(e.qty)}주 × ${money(e.price)}</span>
      <div class="sub">매도금액 ${money(it.amount)}${e.fee ? ` · 수수료 ${money(e.fee)}` : ''}</div>
      <div class="flow" style="margin-top:2px">${money(r.avg)} 매수 → ${money(r.price)} 매도</div>${memo}</div>
    <div class="r"><div class="pnl ${cls(r.pnl)}" style="font-size:17px">${signed(r.pnl)}</div><div class="small ${cls(r.pnl)}">${pct(r.pct)}</div>${tools}</div></div>`;
}

function vHoldings() {
  const s = summary();
  const all = state.acc === 'ALL';
  let h = `<section class="stats" style="grid-template-columns:repeat(2,1fr)">
    <div class="card stat"><div class="label">현재 현금</div><div class="val">${money(s.cash)}</div></div>
    <div class="card stat"><div class="label">보유주식 매수금액</div><div class="val">${money(s.holdCost)}</div></div>
  </section><h2>보유 주식 <span class="sub">산 가격 기준 · 현재가 미반영</span></h2>
  <section class="card tablewrap"><table><thead><tr>${all ? '<th>계좌</th>' : ''}<th>종목</th><th class="n">보유수량</th><th class="n">평균매수가</th><th class="n">매수금액</th></tr></thead><tbody>`;
  h += s.holdings.length ? s.holdings.map(x => `<tr class="row-click" data-action="ticker" data-ticker="${esc(x.ticker)}" style="cursor:pointer">
    ${all ? `<td>${badge(x.account)}</td>` : ''}<td class="tk">${esc(x.ticker)}</td><td class="n">${qty(x.qty)}</td><td class="n">${money(x.avg)}</td><td class="n">${money(x.cost)}</td></tr>`).join('')
    : `<tr><td colspan="${all ? 5 : 4}" class="empty">보유 중인 주식이 없습니다</td></tr>`;
  h += `</tbody>${s.holdings.length ? `<tfoot><tr><td colspan="${all ? 4 : 3}">합계</td><td class="n">${money(s.holdCost)}</td></tr></tfoot>` : ''}</table></section>`;
  return h;
}

function vTrades() {
  const f = state.filters;
  const c = state.calc;
  const trades = state.events.filter(e => (e.type === 'BUY' || e.type === 'SELL') && accList().includes(e.account));
  const years = [...new Set(trades.map(e => e.date.slice(0, 4)))].sort().reverse();
  const q = f.tradesQ.trim().toUpperCase();
  const list = sortEvents(trades).reverse().filter(e =>
    (f.tradesYear === 'ALL' || e.date.startsWith(f.tradesYear)) &&
    (f.tradesType === 'ALL' || e.type === f.tradesType) &&
    (!q || e.ticker.includes(q)));

  // 연도별 실현손익
  const byYear = {};
  for (const r of c.realized) if (accList().includes(r.account)) byYear[r.date.slice(0, 4)] = (byYear[r.date.slice(0, 4)] || 0) + r.pnl;
  let h = '';
  const ys = Object.keys(byYear).sort().reverse();
  if (ys.length) {
    h += `<section class="card list" style="margin-bottom:12px">${ys.map(y => `<div class="row"><div class="l">${y}년 실현손익</div><div class="r pnl ${cls(byYear[y])}">${signed(byYear[y])}</div></div>`).join('')}</section>`;
  }
  h += `<div class="toolbar">
    <select id="tradesYear"><option value="ALL">전체 기간</option>${years.map(y => `<option ${f.tradesYear === y ? 'selected' : ''} value="${y}">${y}년</option>`).join('')}</select>
    <select id="tradesType"><option value="ALL">매수+매도</option><option value="BUY" ${f.tradesType === 'BUY' ? 'selected' : ''}>매수만</option><option value="SELL" ${f.tradesType === 'SELL' ? 'selected' : ''}>매도만</option></select>
    <input id="tradesQ" placeholder="종목" value="${esc(f.tradesQ)}" size="8" autocomplete="off">
    <span class="muted small" style="margin-left:auto">${list.length}건</span></div>
  <section class="card tablewrap"><table><thead><tr><th>날짜</th>${state.acc === 'ALL' ? '<th>계좌</th>' : ''}<th>종목</th><th>구분</th><th class="n">수량</th><th class="n">가격</th><th class="n">금액</th><th class="n">실현손익</th><th>메모</th><th></th></tr></thead><tbody>`;
  h += list.length ? list.map(e => {
    const it = c.byId[e.id];
    const r = it && it.realized;
    return `<tr><td class="num">${e.date}</td>${state.acc === 'ALL' ? `<td>${badge(e.account)}</td>` : ''}
      <td><a href="#" class="tk" data-action="ticker" data-ticker="${esc(e.ticker)}" style="color:inherit">${esc(e.ticker)}</a></td>
      <td><span class="tag ${e.type}">${TYPE[e.type]}</span></td>
      <td class="n">${qty(e.qty)}</td><td class="n">${money(e.price)}</td><td class="n">${money(e.qty * e.price)}</td>
      <td class="n">${r ? `<span class="pnl ${cls(r.pnl)}">${signed(r.pnl)}</span><div class="small muted">${money(r.avg)} → ${money(r.price)}</div>` : (it ? '' : '<span class="err">오류</span>')}</td>
      <td class="memo">${esc(e.memo)}</td>
      <td><button class="linkbtn" data-action="edit" data-id="${e.id}">수정</button><button class="linkbtn" data-action="del" data-id="${e.id}">삭제</button></td></tr>`;
  }).join('') : `<tr><td colspan="10" class="empty">거래 기록이 없습니다</td></tr>`;
  return h + `</tbody></table></section>`;
}

function vCash() {
  const s = summary();
  const list = sortEvents(state.events.filter(e => (e.type === 'DEPOSIT' || e.type === 'WITHDRAW') && accList().includes(e.account))).reverse();
  let h = `<section class="stats">
    <div class="card stat"><div class="label">총 투입금</div><div class="val">${money(s.deposit - s.withdraw)}</div><div class="meta">입금 − 출금</div></div>
    <div class="card stat"><div class="label">입금 합계</div><div class="val">${money(s.deposit)}</div></div>
    <div class="card stat"><div class="label">출금 합계</div><div class="val">${money(s.withdraw)}</div></div>
  </section>
  <h2>현금 흐름 <span class="sub">입금 → 현금↑ · 매수 → 현금↓ · 매도 → 현금↑ · 출금 → 현금↓</span></h2>
  <section class="card list">${accList().map(k => {
    const a = state.calc.accounts[k];
    const bought = state.events.filter(e => e.account === k && e.type === 'BUY').reduce((x, e) => x + e.qty * e.price + (e.fee || 0), 0);
    const sold = state.calc.realized.filter(r => r.account === k).reduce((x, r) => x + r.amount - r.fee, 0);
    return `<div class="row"><div class="l"><b>${ACC[k]}</b><div class="small muted">입금 ${money(a.deposit)} − 출금 ${money(a.withdraw)} − 매수 ${money(bought)} + 매도 ${money(sold)}</div></div>
      <div class="r"><div class="small muted">현재 현금</div><b>${money(a.cash)}</b></div></div>`;
  }).join('')}</section>
  <h2>입출금 내역</h2>
  <section class="card tablewrap"><table><thead><tr><th>날짜</th>${state.acc === 'ALL' ? '<th>계좌</th>' : ''}<th>구분</th><th class="n">금액</th><th>메모</th><th></th></tr></thead><tbody>`;
  h += list.length ? list.map(e => `<tr><td class="num">${e.date}</td>${state.acc === 'ALL' ? `<td>${badge(e.account)}</td>` : ''}
    <td><span class="tag ${e.type}">${TYPE[e.type]}</span></td>
    <td class="n"><b>${e.type === 'DEPOSIT' ? '+' : '-'}${money(e.amount)}</b></td><td class="memo">${esc(e.memo)}</td>
    <td><button class="linkbtn" data-action="edit" data-id="${e.id}">수정</button><button class="linkbtn" data-action="del" data-id="${e.id}">삭제</button></td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">입출금 기록이 없습니다. <b>+ 입출금</b>으로 계좌에 넣은 돈을 기록하세요.</td></tr>`;
  return h + `</tbody></table></section>`;
}

function noteRow(n) {
  const t = n.tradeId && state.events.find(e => e.id === n.tradeId);
  return `<div class="note"><div class="h"><span>${n.date}${n.ticker ? ` · <a href="#" class="tk" data-action="ticker" data-ticker="${esc(n.ticker)}" style="color:inherit">${esc(n.ticker)}</a>` : ''}${t ? ` · ${md(t.date)} ${TYPE[t.type]} ${qty(t.qty)}주 × ${money(t.price)} ${badge(t.account)}` : ''}</span>
    <span><button class="linkbtn" data-action="editNote" data-id="${n.id}">수정</button><button class="linkbtn" data-action="delNote" data-id="${n.id}">삭제</button></span></div>
    <div class="body">${esc(n.text)}</div></div>`;
}

function vDiary() {
  const q = state.filters.diaryQ.trim().toUpperCase();
  const list = [...state.notes].filter(n => !q || (n.ticker || '').includes(q) || n.text.toUpperCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  return `<div class="toolbar"><input id="diaryQ" placeholder="종목 / 내용 검색" value="${esc(state.filters.diaryQ)}" autocomplete="off">
    <span class="muted small" style="margin-left:auto">${list.length}개</span></div>
    <section class="card">${list.length ? list.map(noteRow).join('') : `<div class="empty">일기가 없습니다. <b>+ 일기</b>로 매매 이유나 생각을 남겨보세요.</div>`}</section>`;
}

function vData() {
  return `<h2>데이터</h2>
  <section class="card list">
    <div class="row"><div class="l"><b>JSON 내보내기</b><div class="small muted">거래 ${state.events.length}건 · 일기 ${state.notes.length}개를 파일로 저장 (백업용)</div></div>
      <div class="r"><button class="btn small" data-action="export">내보내기</button></div></div>
    <div class="row"><div class="l"><b>JSON 가져오기</b><div class="small muted">백업 파일로 <b>현재 데이터를 교체</b>합니다</div></div>
      <div class="r"><button class="btn small" data-action="import">가져오기</button><input type="file" id="importFile" accept=".json,application/json" hidden></div></div>
    <div class="row"><div class="l"><b>데이터 초기화</b><div class="small muted">모든 거래와 일기를 삭제합니다. 먼저 내보내기로 백업하세요.</div></div>
      <div class="r"><button class="btn small danger" data-action="reset">초기화</button></div></div>
  </section>
  <h2>계산 방식</h2>
  <section class="card pad small muted" style="line-height:1.7">
    · 데이터는 이 브라우저의 IndexedDB에만 저장됩니다 (서버·로그인·인터넷 불필요).${DB.usingMemory ? ' <span class="err">현재 IndexedDB를 사용할 수 없어 새로고침하면 사라집니다 — 내보내기로 백업하세요.</span>' : ''}<br>
    · 실현손익 = 매도금액 − (평균매수가 × 매도수량) − 수수료. 평균매수가는 <b>이동평균법</b>(국내 증권사 방식)으로 계산합니다.<br>
    · 수수료를 입력하면 매수 시 평균매수가에 포함되고, 매도 시 손익에서 차감됩니다.<br>
    · 보유 주식은 산 가격 기준으로만 표시하며 현재가·평가손익은 계산하지 않습니다.<br>
    · 같은 날짜의 거래는 입력한 순서대로 처리됩니다.
  </section>`;
}

/* ================= 모달 / 폼 ================= */
const $modal = document.getElementById('modal');
const $form = document.getElementById('modalForm');

function segHtml(name, opts, val) {
  return `<div class="seg full" data-seg="${name}">${Object.entries(opts).map(([k, v]) => `<button type="button" data-v="${k}" class="${k === val ? 'on' : ''}">${v}</button>`).join('')}</div>
    <input type="hidden" name="${name}" value="${val}">`;
}
function defaultAcc() { return state.acc === 'ALL' ? 'MAIN' : state.acc; }

function openTrade(type, ev, presetTicker) {
  const e = ev || { type, date: today(), account: defaultAcc(), ticker: presetTicker || '', qty: '', price: '', fee: '', memo: '' };
  const tickers = [...new Set(state.events.filter(x => x.ticker).map(x => x.ticker))].sort();
  $form.innerHTML = `
    <div class="mh"><h3>${ev ? '거래 수정' : '거래 기록'}</h3><button type="button" class="linkbtn" data-close>닫기</button></div>
    <div class="mb">
      ${segHtml('type', { BUY: '매수', SELL: '매도' }, e.type)}
      <div class="two">
        <label class="field"><span>날짜</span><input type="date" name="date" value="${e.date}" required></label>
        <label class="field"><span>계좌</span><select name="account">${Object.entries(ACC).map(([k, v]) => `<option value="${k}" ${k === e.account ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>종목</span><input name="ticker" value="${esc(e.ticker)}" list="tickerList" placeholder="예: SNDK" autocomplete="off" required style="text-transform:uppercase">
        <datalist id="tickerList">${tickers.map(t => `<option value="${esc(t)}">`).join('')}</datalist></label>
      <div class="two">
        <label class="field"><span>수량 (주)</span><input name="qty" type="number" step="any" min="0" inputmode="decimal" value="${e.qty}" required></label>
        <label class="field"><span id="priceLabel">가격 ($)</span><input name="price" type="number" step="any" min="0" inputmode="decimal" value="${e.price}" required></label>
      </div>
      <label class="field"><span>수수료 ($, 선택)</span><input name="fee" type="number" step="any" min="0" inputmode="decimal" value="${e.fee || ''}" placeholder="0"></label>
      <label class="field"><span>메모</span><input name="memo" value="${esc(e.memo)}" placeholder="선택"></label>
      <div class="preview" id="preview"></div>
      <div class="err" id="formErr"></div>
    </div>
    <div class="mf">${ev ? `<button type="button" class="btn" data-action="del" data-id="${ev.id}" style="margin-right:auto">삭제</button>` : ''}
      <button type="button" class="btn" data-close>취소</button><button type="submit" class="btn primary">저장</button></div>`;
  $form.dataset.kind = 'trade';
  $form.dataset.id = ev ? ev.id : '';
  showModal();
  updateTradePreview();
  if (!ev) setTimeout(() => (e.ticker ? $form.qty : $form.ticker).focus(), 30);
}

function readTradeForm() {
  const f = $form;
  return {
    type: f.type.value, date: f.date.value, account: f.account.value,
    ticker: f.ticker.value.trim().toUpperCase(),
    qty: parseFloat(f.qty.value), price: parseFloat(f.price.value),
    fee: parseFloat(f.fee.value) || 0, memo: f.memo.value.trim(),
  };
}

/* 폼에 입력된 거래를 포함해서 다시 계산 (수정 중이면 기존 거래 대체) */
function candidateEvents(obj, id) {
  const existing = id && state.events.find(x => x.id === id);
  const ev = { ...(existing || {}), ...obj, id: id || '__new__', createdAt: existing ? existing.createdAt : Date.now() };
  return { ev, list: state.events.filter(x => x.id !== id).concat(ev) };
}

function updateTradePreview() {
  const v = readTradeForm();
  const id = $form.dataset.id;
  document.getElementById('priceLabel').textContent = v.type === 'BUY' ? '매수가 ($)' : '매도가 ($)';
  const pv = document.getElementById('preview');
  const errEl = document.getElementById('formErr');
  errEl.textContent = '';
  // 그 날짜 직전 보유 현황
  const before = compute(state.events.filter(x => x.id !== id && (x.date < v.date || (x.date === v.date && (!id || (x.createdAt || 0) < (state.events.find(y => y.id === id)?.createdAt || Infinity))))));
  const pos = v.ticker && before.accounts[v.account].positions[v.ticker];
  const held = pos && pos.qty > EPS ? `${ACC[v.account]} ${v.ticker} 보유 ${qty(pos.qty)}주 · 평균 ${money(pos.cost / pos.qty)}` : (v.ticker ? `${ACC[v.account]}에 ${v.ticker} 보유 없음` : '');
  if (!(v.qty > 0) || !(v.price >= 0) || isNaN(v.price)) { pv.innerHTML = `<span class="muted">${held || '수량과 가격을 입력하세요'}</span>`; return; }
  const amount = v.qty * v.price;
  if (v.type === 'BUY') {
    pv.innerHTML = `매수금액 <span class="big">${money(amount)}</span>${v.fee ? ` <span class="muted">+ 수수료 ${money(v.fee)}</span>` : ''}
      <div class="small muted">${held}</div>`;
  } else {
    if (!pos || v.qty > pos.qty + EPS) {
      pv.innerHTML = `<span class="muted">${held}</span>`;
      errEl.textContent = `매도 수량이 보유 수량보다 많습니다.`;
      return;
    }
    const avg = pos.cost / pos.qty;
    const pnl = amount - v.fee - avg * v.qty;
    pv.innerHTML = `${money(avg)} 매수 → ${money(v.price)} 매도 · 매도금액 ${money(amount)}
      <div>실현손익 <span class="big ${cls(pnl)}">${signed(pnl)}</span> <span class="${cls(pnl)}">${pct(pnl / (avg * v.qty))}</span></div>
      <div class="small muted">${held} → 매도 후 ${qty(pos.qty - v.qty)}주</div>`;
  }
}

function openCash(ev) {
  const e = ev || { type: 'DEPOSIT', date: today(), account: defaultAcc(), amount: '', memo: '' };
  $form.innerHTML = `
    <div class="mh"><h3>${ev ? '입출금 수정' : '입출금 기록'}</h3><button type="button" class="linkbtn" data-close>닫기</button></div>
    <div class="mb">
      ${segHtml('type', { DEPOSIT: '입금', WITHDRAW: '출금' }, e.type)}
      <div class="two">
        <label class="field"><span>날짜</span><input type="date" name="date" value="${e.date}" required></label>
        <label class="field"><span>계좌</span><select name="account">${Object.entries(ACC).map(([k, v]) => `<option value="${k}" ${k === e.account ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>금액 ($)</span><input name="amount" type="number" step="any" min="0" inputmode="decimal" value="${e.amount}" required></label>
      <label class="field"><span>메모</span><input name="memo" value="${esc(e.memo)}" placeholder="선택"></label>
      <div class="err" id="formErr"></div>
    </div>
    <div class="mf">${ev ? `<button type="button" class="btn" data-action="del" data-id="${ev.id}" style="margin-right:auto">삭제</button>` : ''}
      <button type="button" class="btn" data-close>취소</button><button type="submit" class="btn primary">저장</button></div>`;
  $form.dataset.kind = 'cash';
  $form.dataset.id = ev ? ev.id : '';
  showModal();
  if (!ev) setTimeout(() => $form.amount.focus(), 30);
}

function openNote(n, presetTicker) {
  const e = n || { date: today(), ticker: presetTicker || '', tradeId: '', text: '' };
  const tickers = [...new Set(state.events.filter(x => x.ticker).map(x => x.ticker))].sort();
  $form.innerHTML = `
    <div class="mh"><h3>${n ? '일기 수정' : '투자 일기'}</h3><button type="button" class="linkbtn" data-close>닫기</button></div>
    <div class="mb">
      <div class="two">
        <label class="field"><span>날짜</span><input type="date" name="date" value="${e.date}" required></label>
        <label class="field"><span>종목 (선택)</span><input name="ticker" value="${esc(e.ticker || '')}" list="tickerList2" autocomplete="off" style="text-transform:uppercase">
          <datalist id="tickerList2">${tickers.map(t => `<option value="${esc(t)}">`).join('')}</datalist></label>
      </div>
      <label class="field"><span>연결할 거래 (선택)</span><select name="tradeId"></select></label>
      <label class="field"><span>내용</span><textarea name="text" required placeholder="예: SNDK 10주 매수. 이번에는 스윙 목적으로 접근.">${esc(e.text)}</textarea></label>
    </div>
    <div class="mf"><button type="button" class="btn" data-close>취소</button><button type="submit" class="btn primary">저장</button></div>`;
  $form.dataset.kind = 'note';
  $form.dataset.id = n ? n.id : '';
  fillTradeOptions(e.tradeId);
  showModal();
  if (!n) setTimeout(() => $form.text.focus(), 30);
}
function fillTradeOptions(selected) {
  const tk = $form.ticker.value.trim().toUpperCase();
  const opts = sortEvents(state.events.filter(x => (x.type === 'BUY' || x.type === 'SELL') && (!tk || x.ticker === tk))).reverse().slice(0, 50);
  $form.tradeId.innerHTML = `<option value="">연결 안 함</option>` + opts.map(x =>
    `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${x.date} ${ACC[x.account]} ${x.ticker} ${TYPE[x.type]} ${qty(x.qty)}주 × ${money(x.price)}</option>`).join('');
}

function showModal() { if (!$modal.open) $modal.showModal(); }
function closeModal() { $modal.close(); }

async function submitForm() {
  const kind = $form.dataset.kind;
  const id = $form.dataset.id;
  const errEl = document.getElementById('formErr');
  if (kind === 'trade') {
    const v = readTradeForm();
    if (!v.date || !v.ticker || !(v.qty > 0) || !(v.price >= 0) || isNaN(v.price)) { errEl.textContent = '날짜, 종목, 수량, 가격을 확인하세요.'; return; }
    const { ev, list } = candidateEvents(v, id);
    const err = compute(list).errors;
    if (err.length > state.calc.errors.length || err.some(x => x.id === ev.id)) {
      errEl.textContent = '저장하면 매도 수량이 보유 수량을 넘는 거래가 생깁니다: ' + err.map(x => x.msg).join(', ');
      return;
    }
    if (!id) ev.id = uid();
    await DB.put('events', ev);
    toast(v.type === 'SELL' ? '매도 기록 완료' : '매수 기록 완료');
  } else if (kind === 'cash') {
    const f = $form;
    const v = { type: f.type.value, date: f.date.value, account: f.account.value, amount: parseFloat(f.amount.value), memo: f.memo.value.trim() };
    if (!v.date || !(v.amount > 0)) { errEl.textContent = '날짜와 금액을 확인하세요.'; return; }
    const { ev } = candidateEvents(v, id);
    if (!id) ev.id = uid();
    await DB.put('events', ev);
    toast(v.type === 'DEPOSIT' ? '입금 기록 완료' : '출금 기록 완료');
  } else if (kind === 'note') {
    const f = $form;
    const old = id && state.notes.find(x => x.id === id);
    const n = { ...(old || {}), id: id || uid(), date: f.date.value, ticker: f.ticker.value.trim().toUpperCase(), tradeId: f.tradeId.value, text: f.text.value.trim(), createdAt: old ? old.createdAt : Date.now() };
    if (!n.text) return;
    if (n.tradeId && !n.ticker) n.ticker = state.events.find(x => x.id === n.tradeId)?.ticker || '';
    await DB.put('notes', n);
    toast('일기 저장');
  }
  closeModal();
  await reload();
}

async function deleteEvent(id) {
  const e = state.events.find(x => x.id === id);
  if (!e) return;
  const desc = e.ticker ? `${e.date} ${ACC[e.account]} ${e.ticker} ${TYPE[e.type]} ${qty(e.qty)}주 × ${money(e.price)}` : `${e.date} ${ACC[e.account]} ${TYPE[e.type]} ${money(e.amount)}`;
  const err = compute(state.events.filter(x => x.id !== id)).errors;
  if (err.length > state.calc.errors.length) {
    alert('이 거래를 지우면 이후 매도 수량이 보유 수량보다 많아집니다.\n먼저 관련 매도를 수정/삭제하세요.\n\n' + err.map(x => x.msg).join('\n'));
    return;
  }
  if (!confirm(`이 거래를 삭제할까요?\n\n${desc}`)) return;
  await DB.del('events', id);
  if ($modal.open) closeModal();
  toast('삭제됨');
  await reload();
}

/* ================= 데이터 ================= */
function exportJson() {
  const data = { app: 'us-stock-ledger', version: 1, exportedAt: new Date().toISOString(), events: sortEvents(state.events), notes: state.notes };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `매매장부-${today()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('내보내기 완료');
}

async function importJson(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { alert('JSON 파일을 읽을 수 없습니다.'); return; }
  if (!data || !Array.isArray(data.events)) { alert('매매장부 백업 파일 형식이 아닙니다.'); return; }
  const okType = new Set(Object.keys(TYPE));
  const events = data.events.filter(e => e && e.id && okType.has(e.type) && ACC[e.account] && /^\d{4}-\d{2}-\d{2}$/.test(e.date)).map(e => ({
    ...e, qty: e.qty != null ? +e.qty : undefined, price: e.price != null ? +e.price : undefined,
    amount: e.amount != null ? +e.amount : undefined, fee: +e.fee || 0, ticker: e.ticker ? String(e.ticker).toUpperCase() : undefined,
  }));
  const notes = Array.isArray(data.notes) ? data.notes.filter(n => n && n.id && n.date && typeof n.text === 'string') : [];
  if (!confirm(`가져오기: 거래 ${events.length}건, 일기 ${notes.length}개\n\n현재 데이터(거래 ${state.events.length}건, 일기 ${state.notes.length}개)는 교체됩니다. 계속할까요?`)) return;
  await DB.replaceAll('events', events);
  await DB.replaceAll('notes', notes);
  toast('가져오기 완료');
  await reload();
}

async function resetAll() {
  const ans = prompt(`모든 거래(${state.events.length}건)와 일기(${state.notes.length}개)를 삭제합니다.\n되돌릴 수 없습니다. 계속하려면 "초기화"라고 입력하세요.`);
  if (ans !== '초기화') return;
  await DB.replaceAll('events', []);
  await DB.replaceAll('notes', []);
  toast('초기화 완료');
  await reload();
}

/* ================= 이벤트 ================= */
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

function go(tab, ticker = null) {
  state.tab = tab; state.ticker = ticker; save('tab', tab);
  render(); window.scrollTo(0, 0);
}

document.getElementById('accountSeg').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  state.acc = b.dataset.acc; save('acc', state.acc); render();
});
document.getElementById('tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (b) go(b.dataset.tab);
});

document.addEventListener('click', (ev) => {
  const nb = ev.target.closest('[data-new]');
  if (nb) {
    const k = nb.dataset.new, tk = nb.dataset.ticker;
    if (k === 'BUY' || k === 'SELL') openTrade(k, null, tk);
    else if (k === 'CASH') openCash();
    else if (k === 'NOTE') openNote(null, tk);
    return;
  }
  if (ev.target.closest('[data-close]')) { closeModal(); return; }
  const sb = ev.target.closest('[data-seg] button');
  if (sb) {
    const seg = sb.parentElement;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === sb));
    seg.nextElementSibling.value = sb.dataset.v;
    if ($form.dataset.kind === 'trade') updateTradePreview();
    return;
  }
  const a = ev.target.closest('[data-action]');
  if (!a) return;
  const act = a.dataset.action;
  if (a.tagName === 'A') ev.preventDefault();
  if (act === 'ticker') { if ($modal.open) closeModal(); go('tickers', a.dataset.ticker); }
  else if (act === 'back') go('tickers');
  else if (act === 'acc') { state.acc = a.dataset.acc; save('acc', state.acc); render(); }
  else if (act === 'edit') {
    const e = state.events.find(x => x.id === a.dataset.id);
    if (!e) return;
    if (e.type === 'BUY' || e.type === 'SELL') openTrade(e.type, e); else openCash(e);
  }
  else if (act === 'del') deleteEvent(a.dataset.id);
  else if (act === 'editNote') openNote(state.notes.find(x => x.id === a.dataset.id));
  else if (act === 'delNote') {
    if (confirm('이 일기를 삭제할까요?')) DB.del('notes', a.dataset.id).then(reload);
  }
  else if (act === 'export') exportJson();
  else if (act === 'import') document.getElementById('importFile').click();
  else if (act === 'reset') resetAll();
});

$form.addEventListener('submit', (ev) => { ev.preventDefault(); submitForm(); });
$form.addEventListener('input', (ev) => {
  if ($form.dataset.kind === 'trade') updateTradePreview();
  if ($form.dataset.kind === 'note' && ev.target.name === 'ticker') fillTradeOptions($form.tradeId.value);
});
$form.addEventListener('change', () => { if ($form.dataset.kind === 'trade') updateTradePreview(); });

document.addEventListener('input', (ev) => {
  const id = ev.target.id;
  const map = { tickerQ: 'tickerQ', tradesQ: 'tradesQ', diaryQ: 'diaryQ' };
  if (map[id]) {
    state.filters[map[id]] = ev.target.value;
    const pos = ev.target.selectionStart;
    render();
    const el = document.getElementById(id); el.focus(); el.setSelectionRange(pos, pos);
  }
});
document.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'tradesYear' || id === 'tradesType') { state.filters[id] = ev.target.value; render(); }
  if (id === 'importFile' && ev.target.files[0]) importJson(ev.target.files[0]);
});

/* ================= 시작 ================= */
async function reload() {
  state.events = await DB.all('events');
  state.notes = await DB.all('notes');
  state.calc = compute(state.events);
  render();
}
DB.open().then(reload);
