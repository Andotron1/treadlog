import { Treadmill } from './ftms.js';
import { Recorder, fmtDuration, fmtDistance, fmtSpeed, fmtPace, weeklyTotals, personalBests, MIN_RUN_SECONDS } from './metrics.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { units: 'km', step: 0.1, cap: 12, presets: '4, 6, 8, 10', weight: 75, wake: true };
const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('treadlog.settings') || '{}') };
const saveSettings = () => localStorage.setItem('treadlog.settings', JSON.stringify(settings));

const tm = new Treadmill();
let rec = new Recorder({ weightKg: settings.weight });
let runs = [];
let lastData = {};
let targetSpeed = 0;
let targetIncline = 0;
let machine = 'idle'; // idle | running | paused | safety
let wakeLock = null;
let lastAutosave = 0;
let sendTimer = null;
let incTimer = null;
const logLines = [];

// ---------- helpers ----------
function toast(msg, kind = 'info', ms = 6000) {
  const b = $('banner');
  b.textContent = msg;
  b.className = `banner ${kind === 'error' ? '' : 'info'}`;
  b.hidden = false;
  clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => { b.hidden = true; }, ms);
}
function log(line) {
  logLines.push(line);
  if (logLines.length > 400) logLines.shift();
  $('logBox').textContent = logLines.join('\n');
  $('logBox').scrollTop = $('logBox').scrollHeight;
}
const capKmh = () => Math.min(settings.cap, tm.range.maxSpeed);
const unitsMi = () => settings.units === 'mi';
const dispSpeed = (kmh) => fmtSpeed(kmh, settings.units);

// ---------- wake lock ----------
async function setWake(on) {
  try {
    if (on && settings.wake && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not critical */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tm.state === 'connected') setWake(true);
});

// ---------- rendering ----------
function renderUnits() {
  $('unitSpeed').textContent = unitsMi() ? 'mph' : 'km/h';
  $('unitPace').textContent = unitsMi() ? '/mi' : '/km';
  $('unitDist').textContent = unitsMi() ? 'mi' : 'km';
}

function renderPresets() {
  const el = $('presets');
  el.innerHTML = '';
  settings.presets.split(',').map((s) => parseFloat(s)).filter((n) => n > 0).forEach((n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = dispSpeed(n);
    b.disabled = tm.state !== 'connected';
    b.addEventListener('click', () => setTarget(n));
    el.appendChild(b);
  });
}

function renderConn() {
  const chip = $('connBtn');
  chip.className = 'chip';
  const s = tm.state;
  if (s === 'connected') { chip.classList.add('chip-on'); $('connLabel').textContent = tm.name; }
  else if (s === 'connecting') { chip.classList.add('chip-busy'); $('connLabel').textContent = 'Connecting…'; }
  else if (s === 'unsupported') { chip.classList.add('chip-off'); $('connLabel').textContent = 'Not an FTMS treadmill'; }
  else { chip.classList.add('chip-off'); $('connLabel').textContent = 'Connect treadmill'; }
  const live = s === 'connected';
  ['spdUp', 'spdDown', 'incUp', 'incDown', 'startBtn', 'pauseBtn', 'stopBtn'].forEach((id) => { $(id).disabled = !live; });
  $('inclineRow').hidden = !(live && tm.canIncline);
  renderPresets();
  renderButtons();
}

function renderButtons() {
  const running = machine === 'running';
  $('startBtn').textContent = machine === 'paused' ? 'Resume' : 'Start';
  $('startBtn').hidden = running;
  $('pauseBtn').hidden = !running;
  $('stopBtn').disabled = tm.state !== 'connected' || machine === 'idle';
}

function renderLive() {
  const spd = lastData.speed ?? 0;
  $('speedBig').textContent = dispSpeed(spd);
  $('paceNow').textContent = fmtPace(spd, settings.units);
  $('targetSpeed').textContent = targetSpeed ? dispSpeed(targetSpeed) : '–';
  const inc = lastData.incline ?? 0;
  $('sIncline').textContent = `${inc.toFixed(1)}%`;
  $('targetIncline').textContent = `${targetIncline.toFixed(1)}%`;
  $('sHr').textContent = lastData.hr ? String(lastData.hr) : '–';
  const l = rec.live();
  $('sTime').textContent = fmtDuration(l ? l.movingSec : 0);
  $('sDist').textContent = fmtDistance(l ? l.distanceM : 0, settings.units);
  $('sKcal').textContent = String(Math.round(l ? l.kcal : 0));
  $('sAvg').textContent = dispSpeed(l ? l.avgKmh : 0);
}

// ---------- control ----------
function setTarget(kmh) {
  kmh = Math.round(kmh * 10) / 10;
  kmh = Math.max(tm.range.minSpeed, Math.min(capKmh(), kmh));
  targetSpeed = kmh;
  renderLive();
  clearTimeout(sendTimer);
  sendTimer = setTimeout(async () => {
    const r = await tm.setSpeed(targetSpeed).catch((e) => { toast(`Speed change failed: ${e.message}`, 'error'); return -1; });
    if (r !== null && r !== 1 && r !== -1) toast(`Treadmill rejected speed (code ${r}). Is it running?`, 'error');
  }, 250);
}
function bumpSpeed(dir) {
  const base = targetSpeed || lastData.speed || tm.range.minSpeed;
  const step = unitsMi() ? 0.1 * 1.609344 : Number(settings.step);
  setTarget(base + dir * step);
}
function bumpIncline(dir) {
  const base = targetIncline || lastData.incline || 0;
  targetIncline = Math.max(tm.range.minIncline, Math.min(tm.range.maxIncline, Math.round((base + dir * tm.range.inclineStep) * 10) / 10));
  renderLive();
  clearTimeout(incTimer);
  incTimer = setTimeout(() => tm.setIncline(targetIncline).catch((e) => toast(`Incline change failed: ${e.message}`, 'error')), 250);
}

// ---------- recording ----------
async function handleRecorder(res) {
  if (res.event === 'started') toast('Run started – recording.', 'info', 3000);
  if (res.event === 'finished') {
    await db.putRun(res.run);
    toast(`Run saved: ${fmtDistance(res.run.distanceM, settings.units)} ${unitsMi() ? 'mi' : 'km'} in ${fmtDuration(res.run.movingSec)}`, 'info', 8000);
    await loadRuns();
  }
  if (res.event === 'discarded') {
    toast(`Run under ${MIN_RUN_SECONDS}s / 100 m, not saved.`, 'info', 4000);
    if (res.run) await db.deleteRun(res.run.id);
  }
}
function finishRun(reason) { return handleRecorder(rec.finish(Date.now(), reason)); }

async function autosave() {
  const snap = rec.snapshot();
  if (snap) await db.putRun(snap).catch(() => {});
}

// ---------- treadmill events ----------
tm.addEventListener('log', (e) => log(e.detail));
tm.addEventListener('raw', (e) => { $('rawLine').textContent = `last packet: ${e.detail}`; });
tm.addEventListener('state', async (e) => {
  renderConn();
  if (e.detail === 'connected') { setWake(true); toast('Connected.', 'info', 2500); }
  if (e.detail === 'unsupported') toast('This device does not expose the standard FTMS service. Open Settings › Diagnostics, copy the log and send it over.', 'error', 0);
  if (e.detail === 'disconnected') {
    if (!tm.wantConnected) { setWake(false); machine = 'idle'; renderButtons(); if (rec.active) await finishRun('disconnect'); }
    else if (rec.active) toast('Connection lost, trying to reconnect. The run keeps its data.', 'error', 0);
  }
});
tm.addEventListener('gaveup', async () => { toast('Could not reconnect. Run saved.', 'error', 0); if (rec.active) await finishRun('lost'); setWake(false); });
tm.addEventListener('status', (e) => {
  const { op } = e.detail;
  if (op === 0x04) { machine = 'running'; $('banner').hidden = true; }
  else if (op === 0x02) { machine = e.detail.param === 0x02 ? 'paused' : 'idle'; }
  else if (op === 0x03) { machine = 'idle'; toast('Safety key pulled – treadmill stopped.', 'error', 0); }
  renderButtons();
});
tm.addEventListener('data', async (e) => {
  const d = e.detail;
  lastData = { ...lastData, ...d };
  if (d.speed !== undefined) {
    if (d.speed > 0.5 && machine !== 'paused') machine = 'running';
    if (d.speed > 0.5 && !targetSpeed) targetSpeed = d.speed;
    if (!sendTimer && d.speed > 0.5) targetSpeed = d.speed; // follow console changes when not mid-tap
  }
  if (d.incline !== undefined && !incTimer) targetIncline = d.incline;
  const res = rec.feed(d, Date.now());
  if (res.event) await handleRecorder(res);
  if (rec.active && Date.now() - lastAutosave > 15000) { lastAutosave = Date.now(); autosave(); }
  renderLive();
  renderButtons();
});

// ---------- history ----------
async function loadRuns() {
  runs = await db.allRuns();
  // recover runs interrupted by a crash/close
  for (const r of runs) {
    if (r.inProgress && (!rec.active || rec.run.id !== r.id)) {
      r.inProgress = false;
      if (r.movingSec >= MIN_RUN_SECONDS && r.distanceM >= 100) await db.putRun(r); else await db.deleteRun(r.id);
    }
  }
  runs = (await db.allRuns()).filter((r) => !r.inProgress);
  renderHistory();
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const distTxt = (m) => `${fmtDistance(m, settings.units)} ${unitsMi() ? 'mi' : 'km'}`;

function renderHistory() {
  const wk = weeklyTotals(runs, 8);
  const cur = wk[wk.length - 1];
  $('hWeek').textContent = distTxt(cur.distanceM);
  $('hWeekSub').textContent = `${cur.runs} run${cur.runs === 1 ? '' : 's'} · ${fmtDuration(cur.movingSec)}`;
  const totalM = runs.reduce((a, r) => a + r.distanceM, 0);
  $('hTotal').textContent = distTxt(totalM);
  $('hTotalSub').textContent = `${runs.length} run${runs.length === 1 ? '' : 's'} · ${fmtDuration(runs.reduce((a, r) => a + r.movingSec, 0))}`;
  const pb = personalBests(runs);
  $('hLongest').textContent = pb.longestM ? distTxt(pb.longestM.distanceM) : '–';
  $('hLongestSub').textContent = pb.longestM ? fmtDate(pb.longestM.start) : '';
  $('hFastest').textContent = pb.fastestAvg ? `${fmtPace(pb.fastestAvg.avgKmh, settings.units)} ${unitsMi() ? '/mi' : '/km'}` : '–';
  $('hFastestSub').textContent = pb.fastestAvg ? fmtDate(pb.fastestAvg.start) : '';

  // weekly bar chart
  const max = Math.max(1000, ...wk.map((w) => w.distanceM));
  const W = 640, H = 180, pad = 28, bw = (W - pad * 2) / wk.length;
  const bars = wk.map((w, i) => {
    const h = Math.round((w.distanceM / max) * (H - 50));
    const x = pad + i * bw + 8, y = H - 24 - h;
    const label = new Date(w.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `<rect x="${x}" y="${y}" width="${bw - 16}" height="${Math.max(h, 2)}" rx="6" fill="${i === wk.length - 1 ? '#c6f432' : '#3a4452'}"/>` +
      `<text x="${x + (bw - 16) / 2}" y="${H - 6}" text-anchor="middle" font-size="12" fill="#8b95a1">${label}</text>` +
      (w.distanceM > 0 ? `<text x="${x + (bw - 16) / 2}" y="${y - 6}" text-anchor="middle" font-size="12" fill="#eef1f4">${fmtDistance(w.distanceM, settings.units)}</text>` : '');
  }).join('');
  $('weekChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly distance">${bars}</svg>`;

  const ul = $('runList');
  ul.innerHTML = '';
  $('emptyRuns').hidden = runs.length > 0;
  runs.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="d">${fmtDate(r.start)}</span><span class="m">${distTxt(r.distanceM)}</span>` +
      `<span class="sub">${fmtDuration(r.movingSec)} · ${fmtPace(r.avgKmh, settings.units)} ${unitsMi() ? '/mi' : '/km'}${r.avgIncline ? ` · ${r.avgIncline}% incline` : ''}</span>` +
      `<span class="sub m">${r.kcal} kcal</span>`;
    li.addEventListener('click', () => openDetail(r));
    ul.appendChild(li);
  });
}

function sparkline(samples) {
  if (!samples || samples.length < 2) return '';
  const W = 520, H = 120, maxT = samples[samples.length - 1][0] || 1;
  const maxS = Math.max(...samples.map((s) => s[1]), 1);
  const pts = samples.map((s) => `${(s[0] / maxT * W).toFixed(1)},${(H - 8 - (s[1] / maxS) * (H - 20)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Speed over time"><polyline points="${pts}" fill="none" stroke="#c6f432" stroke-width="3" stroke-linejoin="round"/></svg>`;
}

let detailRun = null;
function openDetail(r) {
  detailRun = r;
  $('detailBody').innerHTML = `<h3>${fmtDate(r.start)}</h3><div class="sub">Speed over time</div>${sparkline(r.samples)}` +
    `<div class="kv">` +
    `<div><span class="label">Distance</span><b>${distTxt(r.distanceM)}</b></div>` +
    `<div><span class="label">Time</span><b>${fmtDuration(r.movingSec)}</b></div>` +
    `<div><span class="label">Avg pace</span><b>${fmtPace(r.avgKmh, settings.units)}</b></div>` +
    `<div><span class="label">Avg speed</span><b>${dispSpeed(r.avgKmh)}</b></div>` +
    `<div><span class="label">Max speed</span><b>${dispSpeed(r.maxKmh)}</b></div>` +
    `<div><span class="label">Calories</span><b>${r.kcal}</b></div>` +
    `<div><span class="label">Avg incline</span><b>${r.avgIncline}%</b></div>` +
    `<div><span class="label">Max incline</span><b>${r.maxIncline}%</b></div>` +
    `<div><span class="label">Heart rate</span><b>${r.avgHr ? `${r.avgHr} avg` : '–'}</b></div></div>`;
  $('detail').showModal();
}

// ---------- export / import ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

// ---------- settings UI ----------
function bindSettings() {
  $('setUnits').value = settings.units;
  $('setStep').value = String(settings.step);
  $('setCap').value = settings.cap;
  $('setPresets').value = settings.presets;
  $('setWeight').value = settings.weight;
  $('setWake').checked = settings.wake;
  const upd = () => {
    settings.units = $('setUnits').value;
    settings.step = Number($('setStep').value);
    settings.cap = Math.min(25, Math.max(2, Number($('setCap').value) || DEFAULTS.cap));
    settings.presets = $('setPresets').value || DEFAULTS.presets;
    settings.weight = Math.min(250, Math.max(30, Number($('setWeight').value) || DEFAULTS.weight));
    settings.wake = $('setWake').checked;
    saveSettings();
    rec.weightKg = settings.weight;
    renderUnits(); renderPresets(); renderLive(); renderHistory();
    setWake(settings.wake && tm.state === 'connected');
  };
  ['setUnits', 'setStep', 'setCap', 'setPresets', 'setWeight', 'setWake'].forEach((id) => $(id).addEventListener('change', upd));
}

// ---------- wiring ----------
function init() {
  bindSettings();
  renderUnits(); renderConn(); renderLive();

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${t.dataset.view}`));
    if (t.dataset.view === 'history') renderHistory();
  }));

  $('connBtn').addEventListener('click', async () => {
    if (tm.state === 'connected' || tm.wantConnected) { tm.disconnect(); return; }
    try { await tm.connect(); } catch (e) {
      if (e.name !== 'NotFoundError') toast(e.message, 'error', 0); // NotFoundError = user cancelled the picker
      renderConn();
    }
  });

  $('spdUp').addEventListener('click', () => bumpSpeed(1));
  $('spdDown').addEventListener('click', () => bumpSpeed(-1));
  $('incUp').addEventListener('click', () => bumpIncline(1));
  $('incDown').addEventListener('click', () => bumpIncline(-1));

  $('startBtn').addEventListener('click', async () => {
    const r = await tm.start().catch((e) => { toast(`Start failed: ${e.message}`, 'error'); return -1; });
    if (r !== null && r !== 1 && r !== -1) toast(`Treadmill refused to start (code ${r}). Check the safety key.`, 'error');
  });
  $('pauseBtn').addEventListener('click', () => tm.pause().catch((e) => toast(`Pause failed: ${e.message}`, 'error')));
  $('stopBtn').addEventListener('click', async () => {
    await tm.stop().catch((e) => toast(`Stop failed: ${e.message}`, 'error'));
    machine = 'idle'; targetSpeed = 0;
    if (rec.active) await finishRun('manual');
    renderButtons(); renderLive();
  });

  $('detailClose').addEventListener('click', () => $('detail').close());
  $('detailDelete').addEventListener('click', async () => {
    if (!detailRun || !confirm('Delete this run?')) return;
    await db.deleteRun(detailRun.id); $('detail').close(); await loadRuns();
  });

  $('expJson').addEventListener('click', () => download(`treadlog-backup-${stamp()}.json`, JSON.stringify({ version: 1, runs }, null, 1), 'application/json'));
  $('expCsv').addEventListener('click', () => {
    const head = 'start,distance_km,moving_seconds,avg_kmh,max_kmh,avg_incline,max_incline,kcal,avg_hr';
    const rows = runs.slice().reverse().map((r) => [new Date(r.start).toISOString(), (r.distanceM / 1000).toFixed(3), r.movingSec, r.avgKmh, r.maxKmh, r.avgIncline, r.maxIncline, r.kcal, r.avgHr ?? ''].join(','));
    download(`treadlog-runs-${stamp()}.csv`, [head, ...rows].join('\n'), 'text/csv');
  });
  $('impFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = (data.runs || []).filter((r) => r && typeof r.id === 'number' && typeof r.distanceM === 'number');
      await db.putMany(list); await loadRuns();
      toast(`Imported ${list.length} runs.`, 'info');
    } catch { toast('That file is not a valid TreadLog backup.', 'error'); }
    e.target.value = '';
  });

  $('copyLog').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(logLines.join('\n')); toast('Log copied.', 'info', 2500); } catch { toast('Copy failed – long-press the log to select it.', 'error'); }
  });
  $('clearLog').addEventListener('click', () => { logLines.length = 0; $('logBox').textContent = ''; });

  if (!Treadmill.supported()) toast('This browser has no Web Bluetooth. Open TreadLog in Chrome on your Android tablet.', 'error', 0);
  db.requestPersistence();
  loadRuns();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.addEventListener('pagehide', () => { autosave(); });
init();
