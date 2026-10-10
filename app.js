'use strict';
/* ============ NGSA PAYROLL SYSTEM — static, localStorage only ============ */
const $ = s => document.querySelector(s), E = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FUNDS = { salary: '💰 Quỹ Lương', doc: '🚔 Quỹ DOC', bonus: '🏆 Quỹ Thưởng' }, FK = Object.keys(FUNDS);
const ST = { active: '🟢 Active', inactive: '🟡 Inactive', suspended: '🔴 Suspended', retired: '⚫ Retired' };
const CAT = { normal: 'KPI thường', doc: 'KPI DOC', handover: 'Bàn giao' };
const CRIT = { total: 'Tổng KPI', normal: 'KPI bắt giam', doc: 'KPI DOC', handover: 'KPI bàn giao', value: 'Tổng giá trị KPI' };
const COLS = ['members', 'payrollPeriods', 'kpis', 'bonuses', 'penalties', 'transactions', 'audit', 'funds', 'settings', 'meta'];
const fmt = n => (Number(n) || 0).toLocaleString('vi-VN'), uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10) };
const dmy = d => d ? d.split('-').reverse().join('/') : '';
function P(s) { s = String(s).trim().toLowerCase().replace(/\s/g, ''); let m = 1; if (/[km]$/.test(s)) { m = s.endsWith('k') ? 1e3 : 1e6; s = s.slice(0, -1) } if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); s = s.replace(',', '.'); return s === '' || isNaN(Number(s)) ? NaN : Math.round(Number(s) * m * 100) / 100 }

/* ---------- storageService: the ONLY place touching localStorage ---------- */
const storageService = {
  key: c => 'ngsa.' + c,
  get(c, d) { try { const v = localStorage.getItem(this.key(c)); return v ? JSON.parse(v) : d } catch (e) { return d } },
  set(c, v) { try { localStorage.setItem(this.key(c), JSON.stringify(v)); return true } catch (e) { toast('❌ Không thể lưu dữ liệu (bộ nhớ đầy/bị chặn)'); return false } },
  clear() { COLS.forEach(c => localStorage.removeItem(this.key(c))) }
};
const defaults = () => ({
  members: [], payrollPeriods: [], kpis: [], bonuses: [], penalties: [], transactions: [], audit: [],
  funds: { salary: { opening: 0 }, doc: { opening: 0 }, bonus: { opening: 0 } },
  settings: { ranks: Array.from({ length: 13 }, (_, i) => ({ id: i, name: 'Rank ' + i, salary: 0 })), kpiTypes: [], bonusTypes: [], penaltyTypes: [], top: { 1: 0, 2: 0, 3: 0 }, criteria: 'total', overdraft: false, penaltyPolicy: 'cap' },
  meta: { theme: 'dark', demo: false }
});
let S = {};
function load() { const d = defaults(); COLS.forEach(c => S[c] = storageService.get(c, d[c])); S.settings = { ...d.settings, ...S.settings }; S.meta = { ...d.meta, ...S.meta }; S.funds = { ...d.funds, ...S.funds } }
function save(...c) { (c.length ? c : COLS).forEach(x => storageService.set(x, S[x])) }
function log(t) { S.audit.unshift({ id: uid(), at: new Date().toISOString(), text: t }); S.audit = S.audit.slice(0, 500); save('audit') }

/* ---------- CALCULATION ENGINE (single source of truth) ---------- */
const inP = (d, p) => d >= p.start && d <= p.end;
const rankSalary = m => (S.settings.ranks.find(r => r.id == m.rank) || {}).salary || 0;
function calculateRanking(p) {
  const c = S.settings.criteria;
  return S.members.filter(m => m.status === 'active').map(m => {
    const sc = S.kpis.filter(k => k.memberId === m.id && inP(k.date, p)).reduce((a, k) => a + (c === 'value' ? k.qty * k.price : (c === 'total' || c === k.cat) ? k.qty : 0), 0);
    return { id: m.id, name: m.name, score: sc };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
function calculateMemberSalary(m, p, topAmt) {
  const r = { id: m.id, name: m.name, rank: m.rank, rankSalary: rankSalary(m), normal: 0, doc: 0, handover: 0, bonus: 0, top: topAmt, penalty: 0, warn: false };
  const g = { salary: r.rankSalary, doc: 0, bonus: topAmt };
  S.kpis.filter(k => k.memberId === m.id && inP(k.date, p)).forEach(k => { const a = k.qty * k.price; r[k.cat] += a; g[k.fund] += a });
  S.bonuses.filter(b => b.memberId === m.id && inP(b.date, p)).forEach(b => { r.bonus += b.amount; g[b.fund] += b.amount });
  r.gross = r.rankSalary + r.normal + r.doc + r.handover + r.bonus + r.top;
  let pen = S.penalties.filter(x => x.memberId === m.id && inP(x.date, p)).reduce((a, x) => a + x.amount, 0);
  if (pen > r.gross) { r.warn = true; pen = S.settings.penaltyPolicy === 'cap' ? r.gross : 0 }
  r.penalty = pen; r.net = r.gross - pen;
  r.spend = { salary: g.salary, doc: g.doc, bonus: g.bonus };
  let rem = pen; const ks = FK.filter(f => g[f] > 0);
  ks.forEach((f, i) => { const s = i === ks.length - 1 ? rem : Math.min(rem, Math.round(pen * g[f] / r.gross)); r.spend[f] = g[f] - s; rem -= s });
  return r;
}
function calculateFundUsage(rows) { const o = { salary: 0, doc: 0, bonus: 0 }; rows.forEach(r => FK.forEach(f => o[f] += r.spend[f])); return o }
function calculatePayroll(p) {
  const rk = calculateRanking(p), topOf = id => { const i = rk.findIndex(x => x.id === id); return i >= 0 && i < 3 ? (S.settings.top[i + 1] || 0) : 0 };
  const rows = S.members.filter(m => m.status === 'active').map(m => calculateMemberSalary(m, p, topOf(m.id)));
  const t = { rankSalary: 0, normal: 0, doc: 0, handover: 0, bonus: 0, top: 0, gross: 0, penalty: 0, net: 0 };
  rows.forEach(r => Object.keys(t).forEach(k => t[k] += r[k]));
  const fs = calculateFundUsage(rows);
  const ok = FK.reduce((a, f) => a + fs[f], 0) === t.net && t.gross - t.penalty === t.net && rows.every(r => FK.reduce((a, f) => a + r.spend[f], 0) === r.net);
  return { rows, totals: t, fundSpend: fs, ranking: rk, ok };
}
function calculateFundBalance(f) {
  const tx = S.transactions.filter(x => x.fund === f), o = S.funds[f].opening;
  const dep = tx.filter(x => x.type === 'deposit').reduce((a, x) => a + x.amount, 0), exp = -tx.filter(x => x.type === 'payroll').reduce((a, x) => a + x.amount, 0);
  return { opening: o, deposits: dep, expenses: exp, ending: o + dep - exp };
}
const makeFv = res => { const o = {}; FK.forEach(f => { const b = calculateFundBalance(f).ending, s = res.fundSpend[f]; o[f] = { before: b, spend: s, after: b - s, short: Math.max(0, s - b) } }); return o };
const getRes = p => p.status === 'locked' && p.snapshot ? p.snapshot : calculatePayroll(p);
const PP = id => S.payrollPeriods.find(p => p.id === id);

/* ---------- UI helpers ---------- */
const nm = id => (S.members.find(m => m.id === id) || { name: '(đã xóa)' }).name;
const tn = id => (S.settings.kpiTypes.find(t => t.id === id) || { name: '(đã xóa)' }).name;
const rn = n => (S.settings.ranks.find(r => r.id == n) || { name: 'Rank ' + n }).name;
const table = (h, rows, cl) => `<div class="tw"><table><thead><tr>${h.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr${cl ? ` class="ck" tabindex="0" onclick="${cl(i)}"` : ''}>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const empty = t => `<div class="empty">${t}</div>`;
const head = (t, a = '') => `<div class="ph"><h2>${t}</h2><div>${a}</div></div>`;
const opt = (arr, sel) => arr.map(([a, b]) => `<option value="${E(a)}"${String(a) === String(sel) ? ' selected' : ''}>${E(b)}</option>`).join('');
const memOpts = () => S.members.map(m => [m.id, m.name]), fundOpts = () => FK.map(f => [f, FUNDS[f]]);
const btns = (form, coll, id) => `<button class="btn sm" aria-label="Sửa" onclick="event.stopPropagation();A.${form}('${id}')">✏️</button><button class="btn sm dg" aria-label="Xóa" onclick="event.stopPropagation();A.del('${coll}','${id}')">🗑️</button>`;
const kv = a => `<div class="kv">${a.map(([k, v, c]) => `<span class="${c || ''}">${k}</span><span class="${c || ''}">${v}</span>`).join('')}</div>`;
let tt; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2800) }
function modal(h) { $('#modal').innerHTML = `<div class="box">${h}</div>`; $('#modal').classList.add('on') }
function closeModal() { $('#modal').classList.remove('on') }
function ask(msg, fn, yes = 'Xóa') { modal(`<h3>⚠️ Xác nhận</h3><p>${msg}</p><div class="acts"><button class="btn" onclick="closeModal()">Hủy</button><button class="btn ${yes === 'Xóa' ? 'dg' : 'pri'}" id="yes">${yes}</button></div>`); $('#yes').onclick = () => { closeModal(); fn() } }
function formModal(title, fields, v, saveFn) {
  const h = fields.map(f => {
    const val = v[f.k] ?? f.d ?? '', id = 'f_' + f.k;
    const inp = f.t === 'select' ? `<select id="${id}">${opt(f.o, val)}</select>` : f.t === 'area' ? `<textarea id="${id}" rows="2">${E(val)}</textarea>` : `<input id="${id}" type="${f.t === 'date' ? 'date' : 'text'}"${f.t === 'money' ? ' inputmode="decimal"' : ''} value="${E(val)}">`;
    return `<label for="${id}">${f.l}${f.r ? ' *' : ''}</label>${inp}`;
  }).join('');
  modal(`<h3>${title}</h3>${h}<div class="acts"><button class="btn" onclick="closeModal()">Hủy</button><button class="btn pri" id="ok">Lưu</button></div>`);
  $('#ok').onclick = () => {
    const o = {};
    for (const f of fields) {
      let x = $('#f_' + f.k).value.trim();
      if (f.t === 'money') { if (x === '' && !f.r) x = '0'; const n = P(x); if (isNaN(n) || n < 0 || (f.pos && n <= 0)) return toast(`⚠️ ${f.l} không hợp lệ (cần số ${f.pos ? '> 0' : '≥ 0'})`); x = n }
      else if (f.r && !x) return toast(`⚠️ ${f.l} không được để trống`);
      o[f.k] = x;
    }
    if (saveFn(o) !== false) closeModal();
  };
}

/* ---------- Pages ---------- */
const NAV = [['dashboard', '🏠', 'Dashboard'], ['members', '👥', 'Thành viên'], ['payroll', '💰', 'Kỳ lương'], ['kpi', '📊', 'KPI'], ['doc', '🚔', 'DOC'], ['bonus', '🎁', 'Thưởng'], ['discipline', '⚠️', 'Kỷ luật'], ['rank', '🏆', 'Xếp hạng'], ['funds', '💵', 'Quỹ'], ['history', '📜', 'Lịch sử'], ['export', '📤', 'Xuất dữ liệu'], ['settings', '⚙️', 'Cài đặt']];
let V = {}, curPg = '';

function dashboard() {
  const cnt = s => S.members.filter(m => m.status === s).length, q = c => S.kpis.filter(k => k.cat === c).reduce((a, k) => a + k.qty, 0);
  const L = S.payrollPeriods.filter(p => p.status === 'locked' && p.snapshot).map(p => p.snapshot.totals), T = k => L.reduce((a, t) => a + t[k], 0);
  const card = (l, v, s = '') => `<div class="card"><div class="lb">${l}</div><div class="vl">${v}</div>${s ? `<small>${s}</small>` : ''}</div>`;
  const noFund = FK.every(f => { const b = calculateFundBalance(f); return !b.opening && !b.deposits });
  return head('🏠 Dashboard') +
    (!S.members.length && !S.meta.demo ? `<div class="card"><h3>Chào mừng!</h3><p>Chưa có dữ liệu. Bạn có thể nhập dữ liệu thật hoặc xem thử bằng dữ liệu mẫu.</p><button class="btn pri" onclick="A.demo()">🧪 Tạo dữ liệu mẫu</button> <button class="btn" onclick="location.hash='settings'">⚙️ Bắt đầu thiết lập</button></div>` : '') +
    (noFund ? `<div class="warn">Chưa thiết lập quỹ. Vào mục Quỹ để nhập số dư đầu kỳ / nạp quỹ.</div>` : '') +
    `<h3>💰 Quỹ</h3><div class="grid">${FK.map(f => card(FUNDS[f], fmt(calculateFundBalance(f).ending), 'Số dư hiện tại')).join('')}</div>` +
    `<h3>👥 Nhân sự</h3><div class="grid">${card('Tổng thành viên', S.members.length)}${Object.keys(ST).map(s => card(ST[s], cnt(s))).join('')}</div>` +
    `<h3>📊 KPI (số lượng)</h3><div class="grid">${card('Tổng KPI', q('normal') + q('doc') + q('handover'))}${card('KPI thường', q('normal'))}${card('KPI DOC', q('doc'))}${card('KPI bàn giao', q('handover'))}</div>` +
    `<h3>💸 Chi tiền (các kỳ đã phát)</h3><div class="grid">${card('Tổng lương Rank', fmt(T('rankSalary')))}${card('Tổng KPI (thường+bàn giao)', fmt(T('normal') + T('handover')))}${card('Tổng DOC', fmt(T('doc')))}${card('Tổng thưởng (+Top)', fmt(T('bonus') + T('top')))}${card('Tổng phạt', fmt(T('penalty')))}${card('Tổng tiền đã chi (Net)', fmt(T('net')))}</div>`;
}

function members() {
  const divs = [...new Set(S.members.map(m => m.division).filter(Boolean))];
  V.tb = () => {
    const q = (V.q || '').toLowerCase();
    const r = S.members.filter(m => (!q || m.name.toLowerCase().includes(q)) && (V.r == null || V.r === '' || m.rank == V.r) && (!V.d || m.division === V.d) && (!V.s || m.status === V.s));
    const so = V.so || 'name'; r.sort((a, b) => so === 'rank' ? b.rank - a.rank : so === 'status' ? a.status.localeCompare(b.status) : a.name.localeCompare(b.name));
    return r.length ? table(['Tên', 'Rank', 'Division', 'Chức vụ', 'Trạng thái', 'Lương Rank', 'Ghi chú', ''], r.map(m => [E(m.name) + (m.demo ? ' <span class="tag">🧪 DEMO</span>' : ''), E(rn(m.rank)), E(m.division || '-'), E(m.title || '-'), ST[m.status], fmt(rankSalary(m)), E(m.note || ''), btns('memForm', 'members', m.id)])) : empty('Chưa có thành viên.');
  };
  return head('👥 QUẢN LÝ THÀNH VIÊN', '<button class="btn pri" onclick="A.memForm()">+ THÊM THÀNH VIÊN</button>') +
    `<div class="flt"><input type="search" placeholder="🔍 Tìm theo tên" aria-label="Tìm theo tên" oninput="A.fs(this.value)">` +
    `<select aria-label="Lọc Rank" onchange="A.f('r',this.value)"><option value="">Mọi Rank</option>${opt(S.settings.ranks.map(r => [r.id, r.name]))}</select>` +
    `<select aria-label="Lọc Division" onchange="A.f('d',this.value)"><option value="">Mọi Division</option>${opt(divs.map(d => [d, d]))}</select>` +
    `<select aria-label="Lọc trạng thái" onchange="A.f('s',this.value)"><option value="">Mọi trạng thái</option>${opt(Object.entries(ST))}</select>` +
    `<select aria-label="Sắp xếp" onchange="A.f('so',this.value)">${opt([['name', 'Sắp xếp: Tên'], ['rank', 'Sắp xếp: Rank'], ['status', 'Sắp xếp: Trạng thái']])}</select></div><div id="tb">${V.tb()}</div>`;
}

function kpiPage(cats, title) {
  if (!cats.includes(V.kc)) V.kc = cats[0];
  V.tb = () => {
    const r = S.kpis.filter(k => k.cat === V.kc && (!V.ft || k.typeId === V.ft) && (!V.fm || k.memberId === V.fm) && (!V.fd || k.date >= V.fd)).sort((a, b) => b.date.localeCompare(a.date));
    return r.length ? table(['Ngày', 'Thành viên', 'Loại', 'Số lượng', 'Đơn giá', 'Thành tiền', 'Quỹ', ''], r.map(k => [dmy(k.date), E(nm(k.memberId)), E(tn(k.typeId)), k.qty, fmt(k.price), fmt(k.qty * k.price), FUNDS[k.fund], btns('kpiForm', 'kpis', k.id)])) : empty('Chưa có KPI.');
  };
  const types = S.settings.kpiTypes.filter(t => t.cat === V.kc);
  return head(title, '<button class="btn pri" onclick="A.kpiForm()">+ Thêm</button>') +
    (cats.length > 1 ? `<div class="tabs">${cats.map(c => `<button class="btn ${c === V.kc ? 'on' : ''}" onclick="A.v('kc','${c}')">${c === 'handover' ? '📦 HANDOVER KPI' : '📊 ' + CAT[c]}</button>`).join('')}</div>` : '') +
    (!types.length ? `<div class="warn">Chưa có loại ${CAT[V.kc]}. Hãy tạo trong <a href="#settings">Cài đặt</a>.</div>` : '') +
    `<div class="flt"><select aria-label="Lọc loại" onchange="A.f('ft',this.value)"><option value="">Mọi loại</option>${opt(types.map(t => [t.id, t.name]))}</select><select aria-label="Lọc thành viên" onchange="A.f('fm',this.value)"><option value="">Mọi thành viên</option>${opt(memOpts())}</select><input type="date" aria-label="Từ ngày" onchange="A.f('fd',this.value)"></div><div id="tb">${V.tb()}</div>`;
}

function bonusPage() {
  const r = [...S.bonuses].sort((a, b) => b.date.localeCompare(a.date));
  return head('🎁 THƯỞNG', '<button class="btn pri" onclick="A.bonusForm()">+ Thêm thưởng</button>') +
    (r.length ? table(['Ngày', 'Thành viên', 'Loại', 'Tiền', 'Quỹ', 'Lý do', ''], r.map(b => [dmy(b.date), E(nm(b.memberId)), E(b.name), fmt(b.amount), FUNDS[b.fund], E(b.reason || ''), btns('bonusForm', 'bonuses', b.id)])) : empty('Chưa có thưởng.'));
}
function discPage() {
  const r = [...S.penalties].sort((a, b) => b.date.localeCompare(a.date));
  return head('⚠️ KỶ LUẬT / PHẠT', '<button class="btn pri" onclick="A.penForm()">+ Thêm phạt</button>') + '<p><small>Tiền phạt được trừ khỏi Gross để ra Net (không phải khoản chi thêm).</small></p>' +
    (r.length ? table(['Ngày', 'Thành viên', 'Lý do', 'Số tiền', 'Người xử lý', 'Ghi chú', ''], r.map(x => [dmy(x.date), E(nm(x.memberId)), E(x.reason), fmt(x.amount), E(x.handler || ''), E(x.note || ''), btns('penForm', 'penalties', x.id)])) : empty('Chưa có khoản phạt.'));
}

function rankPage() {
  const ps = S.payrollPeriods, sel = V.rp || (ps.length ? ps[ps.length - 1].id : 'all');
  const p = sel === 'all' ? { start: '0000-00-00', end: '9999-99-99' } : (PP(sel) || { start: '0000', end: '9999' });
  const rk = calculateRanking(p), ic = ['🥇', '🥈', '🥉'];
  return head('🏆 XẾP HẠNG TOP KPI') +
    `<div class="flt"><select aria-label="Kỳ" onchange="A.v('rp',this.value)">${opt([['all', 'Tất cả thời gian'], ...ps.map(x => [x.id, x.name])], sel)}</select><select aria-label="Tiêu chí xếp top" onchange="A.crit(this.value)">${opt(Object.entries(CRIT), S.settings.criteria)}</select></div>` +
    (rk.length ? table(['Hạng', 'Thành viên', CRIT[S.settings.criteria], 'Thưởng Top (Quỹ Thưởng)'], rk.map((x, i) => [(ic[i] || '#' + (i + 1)) + (i < 3 ? ' TOP ' + (i + 1) : ''), E(x.name), fmt(x.score), i < 3 ? fmt(S.settings.top[i + 1]) : '-'])) : empty('Chưa có KPI.'));
}

function fundsPage() {
  const tx = [...S.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return head('💵 QUẢN LÝ QUỸ', '<button class="btn pri" onclick="A.depForm()">+ Nạp quỹ</button><button class="btn" onclick="A.openForm()">✏️ Số dư đầu kỳ</button>') +
    `<div class="grid">${FK.map(f => { const b = calculateFundBalance(f); return `<div class="card"><h3>${FUNDS[f]}</h3>${kv([['Đầu kỳ', fmt(b.opening)], ['Nạp', fmt(b.deposits)], ['Đã chi', fmt(b.expenses)], ['Còn lại', fmt(b.ending), 'tot']])}</div>` }).join('')}</div>` +
    '<h3>Transactions</h3>' + (tx.length ? table(['Ngày', 'Quỹ', 'Số tiền', 'Nội dung', ''], tx.map(x => [dmy(x.date), FUNDS[x.fund], `<b class="${x.amount < 0 ? 'er' : 'ok'}">${x.amount > 0 ? '+' : ''}${fmt(x.amount)}</b>`, E(x.desc) + (x.demo ? ' <span class="tag">🧪</span>' : ''), x.type === 'deposit' ? `<button class="btn sm dg" aria-label="Xóa" onclick="A.delTx('${x.id}')">🗑️</button>` : ''])) : empty('Chưa thiết lập quỹ.'));
}

function historyPage() {
  const t = V.ht || 'pay', L = S.payrollPeriods.filter(p => p.status === 'locked' && p.snapshot);
  let b;
  if (t === 'pay') b = L.length ? table(['ID', 'Tên kỳ', 'Ngày', 'Quỹ đầu kỳ', 'Gross', 'Phạt', 'Net', 'DOC', 'Thưởng+Top', 'Số dư sau'], L.map(p => { const s = p.snapshot, fv = s.fv, T = s.totals; return [p.id.slice(-5), E(p.name), dmy(p.start) + ' → ' + dmy(p.end), fmt(FK.reduce((a, f) => a + fv[f].before, 0)), fmt(T.gross), fmt(T.penalty), fmt(T.net), fmt(T.doc), fmt(T.bonus + T.top), fmt(FK.reduce((a, f) => a + fv[f].after, 0))] }), i => `location.hash='payroll/${L[i].id}'`) : empty('Chưa có kỳ lương nào được phát.');
  else b = S.audit.length ? table(['Thời gian', 'Hành động'], S.audit.map(a => [new Date(a.at).toLocaleString('vi-VN'), E(a.text)])) : empty('Chưa có nhật ký.');
  return head('📜 LỊCH SỬ') + `<div class="tabs"><button class="btn ${t === 'pay' ? 'on' : ''}" onclick="A.v('ht','pay')">Payroll</button><button class="btn ${t === 'audit' ? 'on' : ''}" onclick="A.v('ht','audit')">Audit Log</button></div>` + b;
}

function exportPage() {
  const ps = S.payrollPeriods, sel = V.ep || (ps.length ? ps[ps.length - 1].id : '');
  return head('📤 XUẤT DỮ LIỆU') + `<div class="card"><h3>Backup toàn bộ</h3><button class="btn pri" onclick="A.expJson()">📤 Export JSON Backup</button> <button class="btn" onclick="$('#imp').click()">📥 Import JSON Backup</button></div>` +
    `<div class="card"><h3>Xuất theo kỳ lương</h3>${ps.length ? `<select aria-label="Chọn kỳ" onchange="V.ep=this.value">${opt(ps.map(p => [p.id, p.name]), sel)}</select><div class="acts" style="justify-content:flex-start"><button class="btn" onclick="A.expCsv()">CSV</button><button class="btn" onclick="A.expXls()">Excel (10 sheet)</button><button class="btn" onclick="A.pdf()">PDF (In → Lưu PDF)</button><button class="btn" onclick="A.discord()">📋 COPY DISCORD</button></div>` : empty('Chưa có kỳ lương.')}</div>`;
}

function settingsPage() {
  const s = S.settings;
  const tbl = (h, rows) => rows.length ? table(h, rows) : empty('Chưa có.');
  return head('⚙️ CÀI ĐẶT') +
    `<div class="card"><h3>Rank 0 → 12 (tên + lương)</h3><div class="tw"><table><thead><tr><th>#</th><th>Tên Rank</th><th>Lương Rank</th></tr></thead><tbody>${s.ranks.map(r => `<tr><td>${r.id}</td><td><input id="rn${r.id}" aria-label="Tên Rank ${r.id}" value="${E(r.name)}"></td><td><input id="rs${r.id}" aria-label="Lương Rank ${r.id}" inputmode="decimal" value="${r.salary}"></td></tr>`).join('')}</tbody></table></div><button class="btn pri" onclick="A.saveRanks()">Lưu Rank</button></div>` +
    `<div class="card"><h3>Loại KPI / DOC / Bàn giao</h3><p><small>Đơn giá mới chỉ áp dụng cho bản ghi KPI tạo sau đó.</small></p><button class="btn" onclick="A.typeForm()">+ Thêm loại</button>${tbl(['Nhóm', 'Tên', 'Đơn giá', 'Quỹ', ''], s.kpiTypes.map(t => [CAT[t.cat], E(t.name), fmt(t.price), FUNDS[t.fund], btns('typeForm', 'kpiTypes', t.id)]))}</div>` +
    `<div class="card"><h3>Loại thưởng</h3><button class="btn" onclick="A.btForm()">+ Thêm loại thưởng</button>${tbl(['Tên', 'Số tiền', 'Quỹ', ''], s.bonusTypes.map(t => [E(t.name), fmt(t.amount), FUNDS[t.fund], btns('btForm', 'bonusTypes', t.id)]))}</div>` +
    `<div class="card"><h3>Loại phạt</h3><button class="btn" onclick="A.ptForm()">+ Thêm loại phạt</button>${tbl(['Tên', 'Số tiền', ''], s.penaltyTypes.map(t => [E(t.name), fmt(t.amount), btns('ptForm', 'penaltyTypes', t.id)]))}</div>` +
    `<div class="card"><h3>Top thưởng (từ Quỹ Thưởng) & tuỳ chọn</h3><div class="flt"><div><label for="t1">Top 1</label><input id="t1" inputmode="decimal" value="${s.top[1]}"></div><div><label for="t2">Top 2</label><input id="t2" inputmode="decimal" value="${s.top[2]}"></div><div><label for="t3">Top 3</label><input id="t3" inputmode="decimal" value="${s.top[3]}"></div></div>` +
    `<label for="cr">Tiêu chí xếp Top</label><select id="cr">${opt(Object.entries(CRIT), s.criteria)}</select><label for="od">Cho phép vượt quỹ</label><select id="od">${opt([['0', 'TẮT (mặc định)'], ['1', 'BẬT']], s.overdraft ? '1' : '0')}</select><label for="pp">Khi phạt vượt Gross</label><select id="pp">${opt([['cap', 'Chỉ trừ tối đa bằng Gross (Net = 0)'], ['skip', 'Không áp dụng phạt']], s.penaltyPolicy)}</select><div class="acts" style="justify-content:flex-start"><button class="btn pri" onclick="A.saveOpts()">Lưu</button></div></div>` +
    `<div class="card"><h3>Dữ liệu</h3><button class="btn" onclick="A.demo()">🧪 Tạo dữ liệu mẫu</button> <button class="btn" onclick="A.delDemo()">🗑️ Xóa dữ liệu mẫu</button> <button class="btn dg" onclick="A.reset()">🚀 Bắt đầu dữ liệu thật (xóa tất cả)</button></div>`;
}

/* ---------- Payroll ---------- */
function payrollList() {
  const ps = [...S.payrollPeriods].sort((a, b) => b.start.localeCompare(a.start));
  V.tb = () => {
    const r = ps.filter(p => (!V.q || p.name.toLowerCase().includes(V.q.toLowerCase())) && (!V.fd || p.end >= V.fd));
    return r.length ? table(['Kỳ', 'Từ', 'Đến', 'Trạng thái', 'Ghi chú'], r.map(p => [E(p.name) + (p.demo ? ' <span class="tag">🧪 DEMO</span>' : ''), dmy(p.start), dmy(p.end), p.status === 'locked' ? '🔒 Đã phát' : '📝 Nháp', E(p.note || '')]), i => `location.hash='payroll/${r[i].id}'`) : empty('Chưa có kỳ lương.');
  };
  return head('💰 KỲ LƯƠNG', '<button class="btn pri" onclick="A.perForm()">+ TẠO KỲ LƯƠNG</button>') + `<div class="flt"><input type="search" placeholder="🔍 Tìm kỳ" aria-label="Tìm kỳ" oninput="A.fs(this.value)"><input type="date" aria-label="Đến ngày từ" onchange="A.f('fd',this.value)"></div><div id="tb">${V.tb()}</div>`;
}
function payTabs(p, res) {
  const rec = cat => S.kpis.filter(k => k.cat === cat && inP(k.date, p)).map(k => [nm(k.memberId), tn(k.typeId), k.qty, k.price, k.qty * k.price]);
  return {
    total: { t: 'Tổng lương', n: '1. Tổng lương', h: ['Tên', 'Rank', 'Lương Rank', 'KPI thường', 'KPI DOC', 'Bàn giao', 'Thưởng', 'Top', 'Gross', 'Phạt', 'Net'], m: [2, 3, 4, 5, 6, 7, 8, 9, 10], click: 1, r: res.rows.map(x => [x.name, rn(x.rank), x.rankSalary, x.normal, x.doc, x.handover, x.bonus, x.top, x.gross, x.penalty, x.net]) },
    rank: { t: 'Lương Rank', n: '2. Lương Rank', h: ['Tên', 'Rank', 'Lương'], m: [2], r: res.rows.map(x => [x.name, rn(x.rank), x.rankSalary]) },
    normal: { t: 'KPI thường', n: '3. KPI thường', h: ['Tên', 'KPI', 'Số lượng', 'Đơn giá', 'Tổng'], m: [3, 4], r: rec('normal') },
    doc: { t: 'DOC', n: '4. DOC', h: ['Tên', 'Loại DOC', 'Số lượng', 'Đơn giá', 'Tổng'], m: [3, 4], r: rec('doc') },
    handover: { t: 'Bàn giao', n: '5. Bàn giao', h: ['Tên', 'Loại', 'Số lượng', 'Đơn giá', 'Tổng'], m: [3, 4], r: rec('handover') },
    bonus: { t: 'Thưởng', n: '6. Thưởng', h: ['Tên', 'Loại', 'Tiền', 'Lý do'], m: [2], r: S.bonuses.filter(b => inP(b.date, p)).map(b => [nm(b.memberId), b.name, b.amount, b.reason || '']) },
    top: { t: 'Top', n: '7. Top', h: ['Hạng', 'Tên', 'Điểm', 'Thưởng'], m: [3], r: res.ranking.slice(0, 3).map((x, i) => ['Top ' + (i + 1), x.name, x.score, S.settings.top[i + 1] || 0]) },
    pen: { t: 'Phạt', n: '8. Phạt', h: ['Tên', 'Lý do', 'Tiền'], m: [2], r: S.penalties.filter(x => inP(x.date, p)).map(x => [nm(x.memberId), x.reason, x.amount]) }
  };
}
function payrollDetail(id) {
  const p = PP(id); if (!p) return empty('Không tìm thấy kỳ lương.') + '<a class="btn" href="#payroll">← Quay lại</a>';
  const res = getRes(p), fv = p.status === 'locked' && p.snapshot ? p.snapshot.fv : makeFv(res), T = res.totals, tabs = payTabs(p, res), tk = V.pt && tabs[V.pt] ? V.pt : 'total', t = tabs[tk], lk = p.status === 'locked';
  const short = FK.filter(f => fv[f].short > 0), warns = res.rows.filter(r => r.warn);
  const noFund = FK.every(f => { const b = calculateFundBalance(f); return !b.opening && !b.deposits });
  return head(`${lk ? '🔒' : '📝'} ${E(p.name)} <small>${dmy(p.start)} → ${dmy(p.end)}</small>`,
    `<a class="btn" href="#payroll">←</a>` + (lk ? `<button class="btn" onclick="A.unlock('${p.id}')">🔓 Mở khóa kỳ lương</button>` : `<button class="btn pri" onclick="A.lock('${p.id}')">✅ XÁC NHẬN PHÁT LƯƠNG</button>`) + `<button class="btn" onclick="A.discord('${p.id}')">📋 COPY DISCORD</button><button class="btn dg" onclick="A.delPeriod('${p.id}')">🗑️</button>`) +
    (p.note ? `<p><small>${E(p.note)}</small></p>` : '') +
    (noFund && !lk ? '<div class="warn">Chưa thiết lập quỹ.</div>' : '') +
    (short.length && !lk ? `<div class="bad">⚠️ KHÔNG ĐỦ QUỸ — ${short.map(f => `${FUNDS[f]} thiếu ${fmt(fv[f].short)}`).join('; ')}${S.settings.overdraft ? ' (đang cho phép vượt quỹ)' : ' — không thể xác nhận phát lương'}</div>` : '') +
    (warns.length ? `<div class="warn">⚠️ Khoản phạt vượt quá tiền lương: ${warns.map(r => E(r.name)).join(', ')}</div>` : '') +
    (!res.ok ? '<div class="bad">❌ Đối chiếu công thức không khớp!</div>' : '') +
    `<div class="card"><h3>🔎 PREVIEW PAYROLL</h3><div class="grid"><div>${kv([['Tổng thành viên', res.rows.length], ['Lương Rank', fmt(T.rankSalary)], ['KPI thường', fmt(T.normal)], ['DOC', fmt(T.doc)], ['Bàn giao', fmt(T.handover)], ['Thưởng', fmt(T.bonus)], ['Top', fmt(T.top)]])}</div><div>${kv([['TỔNG GROSS', fmt(T.gross)], ['TỔNG PHẠT', fmt(T.penalty), 'er'], ['TỔNG NET THỰC CHI', fmt(T.net), 'tot ok']])}</div></div>` +
    table(['Quỹ', lk ? 'Số dư trước' : 'Số dư hiện tại', 'Chi', 'Còn lại', 'Trạng thái'], FK.map(f => [FUNDS[f], fmt(fv[f].before), fmt(fv[f].spend), fmt(fv[f].after), fv[f].short > 0 ? `<b class="er">⚠️ KHÔNG ĐỦ QUỸ (thiếu ${fmt(fv[f].short)})</b>` : '<span class="ok">✔ Đủ</span>'])) + '</div>' +
    `<div class="tabs">${Object.entries(tabs).map(([k, x]) => `<button class="btn ${k === tk ? 'on' : ''}" onclick="A.v('pt','${k}')">${x.n}</button>`).join('')}</div>` +
    (t.r.length ? table(t.h, t.r.map(r => r.map((c, i) => t.m.includes(i) ? fmt(c) : E(c))), t.click ? i => `A.detail('${p.id}',${i})` : null) : empty(tk === 'total' ? 'Chưa có thành viên.' : tk === 'bonus' || tk === 'pen' || tk === 'top' ? 'Chưa có dữ liệu.' : 'Chưa có KPI.'));
}

const PAGES = { dashboard, members, payroll: id => id ? payrollDetail(id) : payrollList(), kpi: () => kpiPage(['normal', 'handover'], '📊 KPI THƯỜNG'), doc: () => kpiPage(['doc'], '🚔 DOC KPI'), bonus: bonusPage, discipline: discPage, rank: rankPage, funds: fundsPage, history: historyPage, export: exportPage, settings: settingsPage };
function render() {
  const [pg, arg] = (location.hash.slice(1) || 'dashboard').split('/');
  if (pg !== curPg) { V = {}; curPg = pg }
  try { $('#view').innerHTML = (PAGES[pg] || dashboard)(arg) } catch (e) { console.error(e); $('#view').innerHTML = `<div class="bad">Lỗi hiển thị: ${E(e.message)}</div>` }
  $('#nav').innerHTML = NAV.map(([k, i, l]) => `<a href="#${k}" class="${k === pg ? 'on' : ''}">${i} ${l}</a>`).join('');
  $('#demo').hidden = !S.meta.demo; document.body.classList.remove('nav');
  document.documentElement.dataset.theme = S.meta.theme; $('#theme').textContent = S.meta.theme === 'dark' ? '☀️ Light' : '🌙 Dark';
}

/* ---------- Actions ---------- */
const A = {};
let dbt;
A.f = (k, v) => { V[k] = v; $('#tb').innerHTML = V.tb() };
A.fs = v => { clearTimeout(dbt); dbt = setTimeout(() => A.f('q', v), 200) };
A.v = (k, v) => { V[k] = v; render() };
A.crit = v => { S.settings.criteria = v; save('settings'); log('Đổi tiêu chí xếp Top: ' + CRIT[v]); render() };
const LBL = { members: 'thành viên', kpis: 'KPI', bonuses: 'thưởng', penalties: 'khoản phạt', kpiTypes: 'loại KPI', bonusTypes: 'loại thưởng', penaltyTypes: 'loại phạt' };
A.del = (c, id) => {
  const arr = S[c] || S.settings[c], x = arr.find(i => i.id === id); if (!x) return;
  if (c === 'kpiTypes' && S.kpis.some(k => k.typeId === id)) return toast('⚠️ Loại này đã có KPI sử dụng, không thể xóa');
  ask('Bạn có chắc chắn muốn xóa dữ liệu này?' + (c === 'members' ? '<br><small>Toàn bộ KPI/thưởng/phạt của thành viên này cũng bị xóa.</small>' : ''), () => {
    const lb = x.name || nm(x.memberId);
    if (c === 'members') ['kpis', 'bonuses', 'penalties'].forEach(k => S[k] = S[k].filter(r => r.memberId !== id));
    if (S[c]) S[c] = S[c].filter(i => i.id !== id); else S.settings[c] = S.settings[c].filter(i => i.id !== id);
    save(); log(`Đã xóa ${LBL[c]}: ${lb}`); toast('✅ Đã xóa.'); render();
  });
};
A.memForm = id => {
  const m = id ? S.members.find(x => x.id === id) : null;
  formModal(m ? '✏️ Sửa thành viên' : '+ Thêm thành viên', [{ k: 'name', l: 'Tên', r: 1 }, { k: 'rank', l: 'Rank', t: 'select', o: S.settings.ranks.map(r => [r.id, `${r.name} (${fmt(r.salary)})`]) }, { k: 'division', l: 'Division' }, { k: 'title', l: 'Chức vụ' }, { k: 'status', l: 'Trạng thái', t: 'select', o: Object.entries(ST), d: 'active' }, { k: 'note', l: 'Ghi chú', t: 'area' }], m || {}, o => {
    o.rank = +o.rank; if (!S.settings.ranks.some(r => r.id === o.rank)) { toast('⚠️ Rank không hợp lệ'); return false }
    if (S.members.some(x => x.id !== id && x.name.toLowerCase() === o.name.toLowerCase())) { toast('⚠️ Tên thành viên đã tồn tại'); return false }
    if (m) { if (m.rank !== o.rank) log(`Thay đổi Rank của ${m.name}: ${rn(m.rank)} → ${rn(o.rank)}`); Object.assign(m, o); log('Đã sửa thành viên ' + o.name) } else { S.members.push({ id: uid(), ...o }); log('Đã thêm thành viên ' + o.name) }
    save('members'); toast(m ? '✅ Đã lưu.' : '✅ Đã thêm thành viên.'); render();
  });
};
A.kpiForm = id => {
  const k = id ? S.kpis.find(x => x.id === id) : null, cat = k ? k.cat : V.kc, types = S.settings.kpiTypes.filter(t => t.cat === cat);
  if (!S.members.length) return toast('⚠️ Chưa có thành viên.'); if (!types.length) return toast('⚠️ Chưa có loại KPI — tạo trong Cài đặt');
  formModal(k ? '✏️ Sửa KPI' : '+ Thêm ' + CAT[cat], [{ k: 'memberId', l: 'Thành viên', t: 'select', o: memOpts() }, { k: 'typeId', l: 'Loại', t: 'select', o: types.map(t => [t.id, `${t.name} (${fmt(t.price)})`]) }, { k: 'qty', l: 'Số lượng', t: 'money', pos: 1, r: 1 }, { k: 'date', l: 'Ngày', t: 'date', r: 1, d: today() }], k || {}, o => {
    const t = types.find(x => x.id === o.typeId); if (!t) return false; if (!Number.isInteger(o.qty)) { toast('⚠️ Số lượng phải là số nguyên'); return false }
    const rec = { memberId: o.memberId, typeId: t.id, cat: t.cat, qty: o.qty, price: k && k.typeId === t.id ? k.price : t.price, fund: t.fund, date: o.date };
    if (k) Object.assign(k, rec); else S.kpis.push({ id: uid(), ...rec });
    save('kpis'); log(`Đã ${k ? 'sửa' : 'thêm'} ${t.name} cho ${nm(o.memberId)}: +${o.qty}`); toast('✅ Đã lưu.'); render();
  });
};
A.bonusForm = id => {
  const b = id ? S.bonuses.find(x => x.id === id) : null; if (!S.members.length) return toast('⚠️ Chưa có thành viên.');
  formModal(b ? '✏️ Sửa thưởng' : '+ Thêm thưởng', [{ k: 'memberId', l: 'Thành viên', t: 'select', o: memOpts() }, { k: 'type', l: 'Loại thưởng (có sẵn)', t: 'select', o: [['', '— Tự nhập —'], ...S.settings.bonusTypes.map(t => [t.id, `${t.name} (${fmt(t.amount)})`])] }, { k: 'name', l: 'Tên khoản thưởng (nếu tự nhập)' }, { k: 'amount', l: 'Số tiền (bỏ trống = theo loại)', t: 'money' }, { k: 'fund', l: 'Nguồn quỹ (nếu tự nhập)', t: 'select', o: fundOpts(), d: 'bonus' }, { k: 'reason', l: 'Lý do' }, { k: 'date', l: 'Ngày', t: 'date', r: 1, d: today() }], b || {}, o => {
    const t = S.settings.bonusTypes.find(x => x.id === o.type), name = t ? t.name : o.name, amount = o.amount || (t ? t.amount : 0), fund = t ? t.fund : o.fund;
    if (!name) { toast('⚠️ Cần chọn loại hoặc nhập tên thưởng'); return false } if (!(amount > 0)) { toast('⚠️ Số tiền thưởng phải > 0'); return false }
    const rec = { memberId: o.memberId, name, amount, fund, reason: o.reason, date: o.date };
    if (b) Object.assign(b, rec); else S.bonuses.push({ id: uid(), ...rec });
    save('bonuses'); log(`Đã ${b ? 'sửa' : 'thêm'} thưởng "${name}" ${fmt(amount)} cho ${nm(o.memberId)}`); toast('✅ Đã lưu.'); render();
  });
};
A.penForm = id => {
  const x = id ? S.penalties.find(i => i.id === id) : null; if (!S.members.length) return toast('⚠️ Chưa có thành viên.');
  formModal(x ? '✏️ Sửa phạt' : '+ Thêm phạt', [{ k: 'memberId', l: 'Thành viên', t: 'select', o: memOpts() }, { k: 'type', l: 'Loại phạt (có sẵn)', t: 'select', o: [['', '— Tự nhập —'], ...S.settings.penaltyTypes.map(t => [t.id, `${t.name} (${fmt(t.amount)})`])] }, { k: 'reason', l: 'Lý do' }, { k: 'amount', l: 'Số tiền (bỏ trống = theo loại)', t: 'money' }, { k: 'date', l: 'Ngày', t: 'date', r: 1, d: today() }, { k: 'handler', l: 'Người xử lý' }, { k: 'note', l: 'Ghi chú', t: 'area' }], x || {}, o => {
    const t = S.settings.penaltyTypes.find(i => i.id === o.type), reason = o.reason || (t ? t.name : ''), amount = o.amount || (t ? t.amount : 0);
    if (!reason) { toast('⚠️ Lý do không được để trống'); return false } if (!(amount > 0)) { toast('⚠️ Số tiền phạt phải > 0'); return false }
    const rec = { memberId: o.memberId, reason, amount, date: o.date, handler: o.handler, note: o.note };
    if (x) Object.assign(x, rec); else S.penalties.push({ id: uid(), ...rec });
    save('penalties'); log(`Đã ${x ? 'sửa' : 'thêm'} phạt ${fmt(amount)} cho ${nm(o.memberId)}: ${reason}`); toast('✅ Đã lưu.'); render();
  });
};
A.typeForm = id => {
  const t = id ? S.settings.kpiTypes.find(x => x.id === id) : null;
  formModal(t ? '✏️ Sửa loại' : '+ Thêm loại KPI', [{ k: 'cat', l: 'Nhóm', t: 'select', o: Object.entries(CAT) }, { k: 'name', l: 'Tên', r: 1 }, { k: 'price', l: 'Đơn giá', t: 'money', r: 1 }, { k: 'fund', l: 'Nguồn quỹ', t: 'select', o: fundOpts() }], t || { cat: 'normal', fund: 'salary' }, o => {
    if (t) { if (t.price !== o.price) log(`Đổi đơn giá ${t.name}: ${fmt(t.price)} → ${fmt(o.price)}`); Object.assign(t, o) } else { S.settings.kpiTypes.push({ id: uid(), ...o }); log('Đã thêm loại KPI ' + o.name) }
    save('settings'); toast('✅ Đã lưu.'); render();
  });
};
A.btForm = id => {
  const t = id ? S.settings.bonusTypes.find(x => x.id === id) : null;
  formModal(t ? '✏️ Sửa loại thưởng' : '+ Thêm loại thưởng', [{ k: 'name', l: 'Tên', r: 1 }, { k: 'amount', l: 'Số tiền', t: 'money', r: 1, pos: 1 }, { k: 'fund', l: 'Nguồn quỹ', t: 'select', o: fundOpts(), d: 'bonus' }], t || {}, o => { if (t) Object.assign(t, o); else S.settings.bonusTypes.push({ id: uid(), ...o }); save('settings'); log('Đã lưu loại thưởng ' + o.name); toast('✅ Đã lưu.'); render() });
};
A.ptForm = id => {
  const t = id ? S.settings.penaltyTypes.find(x => x.id === id) : null;
  formModal(t ? '✏️ Sửa loại phạt' : '+ Thêm loại phạt', [{ k: 'name', l: 'Tên', r: 1 }, { k: 'amount', l: 'Số tiền', t: 'money', r: 1, pos: 1 }], t || {}, o => { if (t) Object.assign(t, o); else S.settings.penaltyTypes.push({ id: uid(), ...o }); save('settings'); log('Đã lưu loại phạt ' + o.name); toast('✅ Đã lưu.'); render() });
};
A.saveRanks = () => {
  const rs = S.settings.ranks.map(r => ({ id: r.id, name: $('#rn' + r.id).value.trim(), salary: P($('#rs' + r.id).value) }));
  const bad = rs.find(r => !r.name || isNaN(r.salary) || r.salary < 0); if (bad) return toast(`⚠️ Rank ${bad.id}: tên trống hoặc lương không hợp lệ (số ≥ 0)`);
  rs.forEach((r, i) => { const o = S.settings.ranks[i]; if (o.salary !== r.salary) log(`Thay đổi lương ${r.name}: ${fmt(o.salary)} → ${fmt(r.salary)}`) });
  S.settings.ranks = rs; S.meta.ranksDemo = false; save('settings', 'meta'); toast('✅ Đã lưu.');
};
A.saveOpts = () => {
  const t = [1, 2, 3].map(i => P($('#t' + i).value)); if (t.some(x => isNaN(x) || x < 0)) return toast('⚠️ Tiền thưởng Top không hợp lệ (số ≥ 0)');
  S.settings.top = { 1: t[0], 2: t[1], 3: t[2] }; S.settings.criteria = $('#cr').value; S.settings.overdraft = $('#od').value === '1'; S.settings.penaltyPolicy = $('#pp').value; S.meta.topDemo = false;
  save('settings', 'meta'); log('Đã lưu cài đặt Top/tuỳ chọn'); toast('✅ Đã lưu.');
};
A.depForm = () => formModal('+ Nạp quỹ', [{ k: 'fund', l: 'Quỹ', t: 'select', o: fundOpts() }, { k: 'amount', l: 'Số tiền', t: 'money', pos: 1, r: 1 }, { k: 'date', l: 'Ngày', t: 'date', r: 1, d: today() }, { k: 'desc', l: 'Nội dung', d: 'Admin cấp quỹ' }], {}, o => { S.transactions.push({ id: uid(), date: o.date, fund: o.fund, amount: o.amount, desc: o.desc || 'Nạp quỹ', type: 'deposit' }); save('transactions'); log(`Nạp ${FUNDS[o.fund]} +${fmt(o.amount)}`); toast('✅ Đã lưu.'); render() });
A.openForm = () => formModal('Số dư đầu kỳ', FK.map(f => ({ k: f, l: FUNDS[f], t: 'money' })), { salary: S.funds.salary.opening, doc: S.funds.doc.opening, bonus: S.funds.bonus.opening }, o => { FK.forEach(f => S.funds[f].opening = o[f]); save('funds'); log('Thay đổi số dư đầu kỳ các quỹ'); toast('✅ Đã lưu.'); render() });
A.delTx = id => {
  const x = S.transactions.find(t => t.id === id); if (!x) return;
  if (calculateFundBalance(x.fund).ending - x.amount < 0) return toast('❌ Không thể xóa: quỹ sẽ bị âm');
  ask('Bạn có chắc chắn muốn xóa dữ liệu này?', () => { S.transactions = S.transactions.filter(t => t.id !== id); save('transactions'); log(`Xóa giao dịch ${FUNDS[x.fund]} +${fmt(x.amount)}`); toast('✅ Đã xóa.'); render() });
};
A.perForm = () => formModal('+ Tạo kỳ lương', [{ k: 'name', l: 'Tên kỳ', r: 1, d: 'Payroll #' + String(S.payrollPeriods.length + 1).padStart(3, '0') }, { k: 'start', l: 'Ngày bắt đầu', t: 'date', r: 1, d: today() }, { k: 'end', l: 'Ngày kết thúc', t: 'date', r: 1, d: today() }, { k: 'd_salary', l: 'Nạp thêm Quỹ Lương', t: 'money' }, { k: 'd_doc', l: 'Nạp thêm Quỹ DOC', t: 'money' }, { k: 'd_bonus', l: 'Nạp thêm Quỹ Thưởng', t: 'money' }, { k: 'note', l: 'Ghi chú', t: 'area' }], {}, o => {
  if (o.end < o.start) { toast('⚠️ Ngày kết thúc phải sau ngày bắt đầu'); return false }
  const p = { id: uid(), name: o.name, start: o.start, end: o.end, note: o.note, status: 'draft', snapshot: null }; S.payrollPeriods.push(p);
  FK.forEach(f => { if (o['d_' + f] > 0) S.transactions.push({ id: uid(), date: today(), fund: f, amount: o['d_' + f], desc: 'Cấp quỹ ' + o.name, type: 'deposit' }) });
  save('payrollPeriods', 'transactions'); log('Đã tạo kỳ lương ' + o.name); toast('✅ Đã tạo kỳ lương.'); location.hash = 'payroll/' + p.id;
});
A.detail = (pid, i) => {
  const p = PP(pid), r = getRes(p).rows[i]; if (!r) return;
  modal(`<h3>💰 CHI TIẾT LƯƠNG — ${E(r.name)}</h3>${kv([['Lương Rank', fmt(r.rankSalary)], ['KPI thường', fmt(r.normal)], ['KPI DOC', fmt(r.doc)], ['Bàn giao', fmt(r.handover)], ['Thưởng', fmt(r.bonus)], ['Top', fmt(r.top)], ['Gross', fmt(r.gross), 'tot'], ['Phạt', fmt(r.penalty), 'er'], ['Net', fmt(r.net), 'tot ok']])}${r.warn ? '<div class="warn">⚠️ Khoản phạt vượt quá tiền lương.</div>' : ''}<h4>Chi từ quỹ</h4>${kv(FK.map(f => [FUNDS[f], fmt(r.spend[f])]))}<div class="acts"><button class="btn" onclick="closeModal()">Đóng</button></div>`);
};
A.lock = id => {
  const p = PP(id), res = calculatePayroll(p);
  if (!res.rows.length) return toast('⚠️ Chưa có thành viên.'); if (!res.ok) return toast('❌ Đối chiếu công thức không khớp');
  const fv = makeFv(res), sh = FK.filter(f => fv[f].short > 0);
  if (sh.length && !S.settings.overdraft) return toast('❌ Không đủ quỹ: ' + sh.map(f => `${FUNDS[f]} thiếu ${fmt(fv[f].short)}`).join(', '));
  ask(`Xác nhận phát lương "${E(p.name)}"? Tổng Net thực chi: <b>${fmt(res.totals.net)}</b>. Kỳ sẽ bị khóa và trừ quỹ.`, () => {
    res.rows.forEach(r => FK.forEach(f => r.spend[f] > 0 && S.transactions.push({ id: uid(), date: today(), fund: f, amount: -r.spend[f], desc: (f === 'doc' ? 'DOC KPI ' : f === 'bonus' ? 'Thưởng ' : 'Payroll ') + r.name, type: 'payroll', periodId: p.id, memberId: r.id, demo: !!p.demo })));
    p.status = 'locked'; p.lockedAt = today(); p.snapshot = { ...res, fv };
    save('transactions', 'payrollPeriods'); log(`Phát lương ${p.name}: Net ${fmt(res.totals.net)}`); toast('✅ Đã tính lương — kỳ đã khóa.'); render();
  }, 'Xác nhận');
};
A.unlock = id => ask('Mở khóa kỳ lương sẽ hoàn lại các transaction đã trừ quỹ. Tiếp tục?', () => {
  const p = PP(id); S.transactions = S.transactions.filter(t => t.periodId !== id); p.status = 'draft'; p.snapshot = null;
  save('transactions', 'payrollPeriods'); log('Mở khóa kỳ lương ' + p.name); toast('✅ Đã mở khóa.'); render();
}, 'Mở khóa');
A.delPeriod = id => { const p = PP(id); if (p.status === 'locked') return toast('⚠️ Hãy mở khóa kỳ lương trước khi xóa'); ask('Bạn có chắc chắn muốn xóa dữ liệu này?', () => { S.payrollPeriods = S.payrollPeriods.filter(x => x.id !== id); save('payrollPeriods'); log('Xóa kỳ lương ' + p.name); toast('✅ Đã xóa.'); location.hash = 'payroll' }) };

/* ---------- Demo / reset ---------- */
A.demo = () => {
  if (S.meta.demo) return toast('⚠️ Dữ liệu mẫu đã tồn tại');
  ask('Tạo dữ liệu mẫu? Rank, đơn giá, Top sẽ được đặt giá trị mẫu (đánh dấu 🧪 DEMO).', () => {
    const D = o => ({ id: uid(), demo: true, ...o }), d = '2026-10-05';
    S.settings.ranks = S.settings.ranks.map(r => ({ ...r, salary: r.id * 10000 })); S.meta.ranksDemo = true; S.meta.topDemo = true; S.settings.top = { 1: 50000, 2: 30000, 3: 20000 };
    const tn_ = D({ cat: 'normal', name: 'Bắt giam thường', price: 3000, fund: 'salary' }), th = D({ cat: 'handover', name: 'Bàn giao tù nhân', price: 3000, fund: 'salary' }), ta = D({ cat: 'doc', name: 'DOC Arrest', price: 4000, fund: 'doc' });
    S.settings.kpiTypes.push(tn_, th, ta, D({ cat: 'doc', name: 'Full Bandicam', price: 5000, fund: 'doc' }), D({ cat: 'doc', name: 'LTA', price: 2000, fund: 'doc' }));
    S.settings.bonusTypes.push(D({ name: 'Thưởng thường', amount: 10000, fund: 'bonus' })); S.settings.penaltyTypes.push(D({ name: 'Vi phạm quy định', amount: 5000 }));
    const M = (name, rank, division, title) => { const m = D({ name, rank, division, title, status: 'active', note: '' }); S.members.push(m); return m.id };
    const jia = M('Jia', 5, 'Alpha', 'Commander'), lam = M('Lam Tinh', 4, 'Alpha', 'Officer'), ben = M('Ben Tran', 2, 'Bravo', 'Agent'), hm = M('Hoàng Minh', 3, 'Bravo', 'Officer'), ak = M('Anh Khoa', 2, 'Charlie', 'Agent');
    const K = (m, t, qty) => S.kpis.push(D({ memberId: m, typeId: t.id, cat: t.cat, qty, price: t.price, fund: t.fund, date: d }));
    K(jia, tn_, 10); K(jia, ta, 5); K(jia, th, 10); K(lam, tn_, 8); K(lam, th, 5); K(ben, tn_, 3); K(ben, ta, 2); K(ben, th, 4); K(hm, tn_, 22); K(ak, tn_, 16);
    S.bonuses.push(D({ memberId: jia, name: 'Thưởng thường', amount: 10000, fund: 'bonus', reason: 'Demo', date: d }), D({ memberId: lam, name: 'Thưởng thường', amount: 5000, fund: 'bonus', reason: 'Demo', date: d }));
    S.penalties.push(D({ memberId: ben, reason: 'Vi phạm quy định', amount: 5000, date: d, handler: 'Admin', note: 'Demo' }));
    S.payrollPeriods.push(D({ name: 'Payroll #001', start: '2026-10-01', end: '2026-10-08', note: 'Kỳ lương mẫu', status: 'draft', snapshot: null }));
    [['salary', 2000000], ['doc', 500000], ['bonus', 500000]].forEach(([f, a]) => S.transactions.push(D({ date: '2026-10-01', fund: f, amount: a, desc: 'Admin cấp quỹ (demo)', type: 'deposit' })));
    S.meta.demo = true; save(); log('Đã tạo dữ liệu mẫu'); toast('✅ Đã tạo dữ liệu mẫu.'); render();
  }, 'Tạo');
};
A.delDemo = () => {
  if (!S.meta.demo) return toast('⚠️ Không có dữ liệu mẫu');
  ask('Xóa toàn bộ dữ liệu mẫu (🧪)? Dữ liệu thật được giữ nguyên.', () => {
    ['members', 'kpis', 'bonuses', 'penalties', 'transactions', 'payrollPeriods'].forEach(c => S[c] = S[c].filter(x => !x.demo));
    ['kpiTypes', 'bonusTypes', 'penaltyTypes'].forEach(c => S.settings[c] = S.settings[c].filter(x => !x.demo));
    if (S.meta.ranksDemo) S.settings.ranks = S.settings.ranks.map(r => ({ ...r, salary: 0 })); if (S.meta.topDemo) S.settings.top = { 1: 0, 2: 0, 3: 0 };
    S.meta.demo = false; S.meta.ranksDemo = S.meta.topDemo = false; save(); log('Đã xóa dữ liệu mẫu'); toast('✅ Đã xóa dữ liệu mẫu.'); render();
  });
};
A.reset = () => ask('XÓA TOÀN BỘ dữ liệu (cả dữ liệu thật) và bắt đầu lại? Hãy Export Backup trước. Không thể hoàn tác.', () => { const th = S.meta.theme; storageService.clear(); S = {}; load(); S.meta.theme = th; save(); log('Đã reset dữ liệu — bắt đầu dữ liệu thật'); toast('🚀 Đã sẵn sàng nhập dữ liệu thật.'); location.hash = 'dashboard'; render() }, 'Xóa tất cả');

/* ---------- Export ---------- */
function dl(name, data, mime) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: mime })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast('✅ Đã xuất file.') }
const selP = () => PP(V.ep || (S.payrollPeriods.length ? S.payrollPeriods[S.payrollPeriods.length - 1].id : '')) || (toast('⚠️ Chưa có kỳ lương') && null);
function sheets(p) {
  const res = getRes(p), tb = payTabs(p, res), out = Object.values(tb).map(t => [t.n.replace(/^\d+\.\s*/, ''), [t.h, ...t.r]]);
  out.push(['Quỹ', [['Quỹ', 'Đầu kỳ', 'Nạp', 'Đã chi', 'Còn lại'], ...FK.map(f => { const b = calculateFundBalance(f); return [FUNDS[f], b.opening, b.deposits, b.expenses, b.ending] })]]);
  out.push(['Transactions', [['Ngày', 'Quỹ', 'Số tiền', 'Nội dung'], ...S.transactions.map(x => [x.date, FUNDS[x.fund], x.amount, x.desc])]]);
  return out;
}
A.expJson = () => { const o = {}; COLS.forEach(c => o[c] = S[c]); o._app = 'NGSA-PAYROLL'; dl(`NGSA-PAYROLL-BACKUP-${today()}.json`, JSON.stringify(o, null, 2), 'application/json'); log('Export JSON backup') };
A.expCsv = () => { const p = selP(); if (!p) return; const q = c => typeof c === 'number' ? c : `"${String(c).replace(/"/g, '""')}"`; dl(`NGSA-PAYROLL-${p.name.replace(/\W+/g, '_')}.csv`, '\ufeff' + sheets(p)[0][1].map(r => r.map(q).join(',')).join('\r\n'), 'text/csv;charset=utf-8'); log('Export CSV ' + p.name) };
A.expXls = () => {
  const p = selP(); if (!p) return; const x = s => E(s);
  const xml = '<?xml version="1.0" encoding="UTF-8"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' + sheets(p).map(([n, rows]) => `<Worksheet ss:Name="${x(n).slice(0, 31)}"><Table>${rows.map(r => '<Row>' + r.map(c => typeof c === 'number' ? `<Cell><Data ss:Type="Number">${c}</Data></Cell>` : `<Cell><Data ss:Type="String">${x(c)}</Data></Cell>`).join('') + '</Row>').join('')}</Table></Worksheet>`).join('') + '</Workbook>';
  dl(`NGSA-PAYROLL-${p.name.replace(/\W+/g, '_')}.xls`, xml, 'application/vnd.ms-excel'); log('Export Excel ' + p.name);
};
A.pdf = () => { const p = selP(); if (!p) return; location.hash = 'payroll/' + p.id; toast('Chọn "Lưu dưới dạng PDF" trong hộp thoại in'); setTimeout(() => window.print(), 600) };
A.discord = id => {
  const p = id ? PP(id) : selP(); if (!p) return; const res = getRes(p), fv = p.status === 'locked' && p.snapshot ? p.snapshot.fv : makeFv(res), ic = ['🥇', '🥈', '🥉'], ln = '━━━━━━━━━━━━━━━━━━';
  const txt = `💰 NGSA PAYROLL\n\n${ln}\n\n📅 Kỳ lương: ${p.name} (${dmy(p.start)} → ${dmy(p.end)})\n\n👥 Thành viên: ${res.rows.length}\n\n` +
    [['salary', '💵 QUỸ LƯƠNG'], ['doc', '🚔 QUỸ DOC'], ['bonus', '🏆 QUỸ THƯỞNG']].map(([f, t]) => `${t}\nĐã chi: ${fmt(fv[f].spend)}\nCòn: ${fmt(fv[f].after)}\n`).join('\n') +
    `\n${ln}\n\n🏆 TOP KPI\n\n${[0, 1, 2].map(i => `${ic[i]} Top ${i + 1}: ${res.ranking[i] ? res.ranking[i].name : '-'}`).join('\n')}\n\n${ln}\n\n💰 TỔNG THỰC CHI: ${fmt(res.totals.net)}`;
  const done = () => toast('✅ Đã copy Discord.');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done, () => modal(`<h3>Copy thủ công</h3><textarea rows="12">${E(txt)}</textarea><div class="acts"><button class="btn" onclick="closeModal()">Đóng</button></div>`));
  else { const t = document.createElement('textarea'); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done() } catch (e) { } t.remove() }
};
function importJson(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const o = JSON.parse(r.result); if (!o || !Array.isArray(o.members) || !o.settings || !Array.isArray(o.payrollPeriods)) throw new Error('Sai định dạng');
      ask('Import sẽ GHI ĐÈ toàn bộ dữ liệu hiện tại. Tiếp tục?', () => { const d = defaults(); COLS.forEach(c => S[c] = o[c] ?? d[c]); S.settings = { ...d.settings, ...S.settings }; S.meta = { ...d.meta, ...S.meta }; save(); log('Import JSON backup'); toast('✅ Đã khôi phục dữ liệu.'); render() }, 'Import');
    } catch (e) { toast('❌ File backup không hợp lệ: ' + e.message) }
  };
  r.readAsText(file);
}

/* ---------- Init ---------- */
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); if (e.key === 'Enter' && e.target.matches && e.target.matches('tr.ck')) e.target.click() });
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal() });
$('#burger').onclick = () => document.body.classList.toggle('nav');
$('#theme').onclick = () => { S.meta.theme = S.meta.theme === 'dark' ? 'light' : 'dark'; save('meta'); render() };
$('#imp').onchange = e => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = '' };
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0) });
load(); render();
