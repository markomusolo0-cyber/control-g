/* ============================================================
   app.js — ESP8266 Process Control Dashboard
   JKUAT · Level, Flow & Temperature Control System
   ============================================================ */

// ── State ──────────────────────────────────────────────────
let readings    = [];
let pidSessions = [];
let charts      = {};
let simTimer    = null;
let simMode     = false;
let simStep     = 0;

// ── Helper: read current setpoint from input ───────────────
const SP = () => parseFloat(document.getElementById('ov-sp').value) || 20;

// ── Storage helpers (localStorage fallback) ────────────────
async function storageGet(key) {
  try {
    if (window.storage) {
      const r = await window.storage.get(key);
      return r ? r.value : null;
    }
  } catch (_) {}
  return localStorage.getItem(key);
}

async function storageSet(key, value) {
  try {
    if (window.storage) { await window.storage.set(key, value); return; }
  } catch (_) {}
  localStorage.setItem(key, value);
}

// ── Load persisted data on startup ────────────────────────
async function load() {
  try {
    const r = await storageGet('esp_readings');
    if (r) readings = JSON.parse(r);
  } catch (_) {}
  try {
    const p = await storageGet('esp_pid');
    if (p) pidSessions = JSON.parse(p);
  } catch (_) {}
  refreshAll();
}

// ── Persist data ───────────────────────────────────────────
async function persist() {
  await storageSet('esp_readings', JSON.stringify(readings));
  await storageSet('esp_pid',      JSON.stringify(pidSessions));
}

// ══════════════════════════════════════════════════════════
//  TAB NAVIGATION
// ══════════════════════════════════════════════════════════
function showTab(t) {
  document.querySelectorAll('.tab').forEach(e => e.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(e => e.classList.remove('active'));
  document.querySelector(`[onclick="showTab('${t}')"]`).classList.add('active');
  document.getElementById('panel-' + t).classList.add('active');

  if (t === 'charts') setTimeout(buildCharts, 80);
  if (t === 'perf')   buildPerf();
  if (t === 'log')    buildLog();
}

// ══════════════════════════════════════════════════════════
//  CONNECTION BADGE TOGGLE
// ══════════════════════════════════════════════════════════
function toggleMode() {
  simMode = !simMode;
  document.getElementById('conn-dot').className   = 'dot ' + (simMode ? 'sim' : 'off');
  document.getElementById('conn-label').textContent = simMode ? 'Simulating' : 'Offline';
}

// ══════════════════════════════════════════════════════════
//  INGEST A READING (from manual entry or simulation)
// ══════════════════════════════════════════════════════════
function ingest(r) {
  r.idx  = readings.length + 1;
  r.ts   = new Date().toLocaleTimeString();
  r.sp   = SP();
  r.mode = document.getElementById('ov-mode').value;
  readings.push(r);
  persist();
  updateMetrics(r);
  updateGauges(r);
  buildAlerts(r);
  document.getElementById('last-update').textContent = 'Last: ' + r.ts;
  document.getElementById('log-count').textContent   = readings.length + ' readings';
}

// ── Manual entry ───────────────────────────────────────────
function addManual() {
  const lvl = parseFloat(document.getElementById('m-level').value);
  if (isNaN(lvl)) { alert('Tank level is required.'); return; }
  ingest({
    level : lvl,
    fin   : parseFloat(document.getElementById('m-fin').value)  || 0,
    fout  : parseFloat(document.getElementById('m-fout').value) || 0,
    temp  : parseFloat(document.getElementById('m-temp').value) || 0,
    pwm   : parseFloat(document.getElementById('m-pwm').value)  || 0,
    note  : document.getElementById('m-note').value
  });
  ['m-level','m-fin','m-fout','m-temp','m-pwm','m-note']
    .forEach(id => document.getElementById(id).value = '');
}

// ── Single simulate point ──────────────────────────────────
function simulateStream() {
  ingest({ level: SP() - 3, fin: 2.0, fout: 1.8, temp: 27, pwm: 60, note: 'manual sim' });
}

// ══════════════════════════════════════════════════════════
//  SIMULATION STREAM (40 readings, step disturbance at 15)
// ══════════════════════════════════════════════════════════
function startSim() {
  if (simTimer) return;
  simStep = 0;
  document.getElementById('sim-status').textContent  = 'Running...';
  document.getElementById('conn-dot').className      = 'dot sim';
  document.getElementById('conn-label').textContent  = 'Simulating';

  simTimer = setInterval(() => {
    simStep++;
    const sp   = SP();
    const dist = simStep === 15 ? 3 : 0;
    const prev = readings.length ? readings[readings.length - 1].level : sp - 5;
    const err  = sp - prev;
    const kp   = parseFloat(document.getElementById('pk').value) || 2.5;
    const ki   = parseFloat(document.getElementById('ik').value) || 0.12;
    const integral = err * simStep * 0.1;

    let pwm   = Math.min(100, Math.max(0, kp * err + ki * integral));
    let level = prev + (pwm / 100) * 0.6 - 0.5 + dist + (Math.random() - .5) * 0.1;
    level     = Math.max(0, Math.min(40, parseFloat(level.toFixed(2))));

    const fin  = parseFloat((1.8 + pwm / 100 * 0.8 + dist * 0.3).toFixed(2));
    const fout = parseFloat((1.6 + level * 0.02).toFixed(2));
    const temp = parseFloat((26  + simStep * 0.05 + Math.random() * 0.2).toFixed(1));

    ingest({ level, fin, fout, temp, pwm: parseFloat(pwm.toFixed(1)), note: dist ? 'step disturbance' : 'sim' });

    // Refresh charts every 5 readings if chart tab is visible
    if (simStep % 5 === 0) {
      const activePanelId = document.querySelector('.panel.active')?.id;
      if (activePanelId === 'panel-charts') buildCharts();
    }

    if (simStep >= 40) stopSim();
  }, 800);
}

function stopSim() {
  clearInterval(simTimer); simTimer = null;
  document.getElementById('sim-status').textContent  = 'Stopped at ' + readings.length + ' readings.';
  document.getElementById('conn-dot').className      = 'dot off';
  document.getElementById('conn-label').textContent  = 'Offline';
  buildCharts(); buildPerf(); buildLog();
}

// ══════════════════════════════════════════════════════════
//  METRIC CARDS
// ══════════════════════════════════════════════════════════
function updateMetrics(r) {
  const err    = (r.level - r.sp).toFixed(2);
  const errCls = Math.abs(err) < 1 ? 'ok-card' : Math.abs(err) < 3 ? 'warn-card' : 'alert-card';

  document.getElementById('mc-level').innerHTML =
    `<div class="mlabel">Tank level</div><div class="mval">${r.level.toFixed(1)}<span class="munit">cm</span></div>`;
  document.getElementById('mc-sp').innerHTML =
    `<div class="mlabel">Setpoint</div><div class="mval">${r.sp}<span class="munit">cm</span></div>`;
  document.getElementById('mc-err').className = 'mc ' + errCls;
  document.getElementById('mc-err').innerHTML =
    `<div class="mlabel">Error</div><div class="mval">${err}<span class="munit">cm</span></div>`;
  document.getElementById('mc-fin').innerHTML =
    `<div class="mlabel">Inflow</div><div class="mval">${r.fin.toFixed(2)}<span class="munit">L/m</span></div>`;
  document.getElementById('mc-temp').innerHTML =
    `<div class="mlabel">Temp</div><div class="mval">${r.temp.toFixed(1)}<span class="munit">°C</span></div>`;
  document.getElementById('mc-pwm').innerHTML =
    `<div class="mlabel">Pump PWM</div><div class="mval">${r.pwm.toFixed(0)}<span class="munit">%</span></div>`;
}

// ══════════════════════════════════════════════════════════
//  GAUGE BARS
// ══════════════════════════════════════════════════════════
function updateGauges(r) {
  const lp = Math.min(100, r.level / 40 * 100);
  document.getElementById('g-level').style.width      = lp + '%';
  document.getElementById('g-level').style.background = lp > 80 ? '#E24B4A' : lp > 60 ? '#EF9F27' : '#185FA5';
  document.getElementById('gv-level').innerHTML       = `${r.level.toFixed(1)} <span class="gauge-unit">/ 40 cm</span>`;

  document.getElementById('g-pwm').style.width  = r.pwm + '%';
  document.getElementById('gv-pwm').innerHTML   = `${r.pwm.toFixed(0)} <span class="gauge-unit">%</span>`;

  const tp = Math.min(100, r.temp / 80 * 100);
  document.getElementById('g-temp').style.width      = tp + '%';
  document.getElementById('g-temp').style.background = tp > 75 ? '#E24B4A' : tp > 50 ? '#EF9F27' : '#1D9E75';
  document.getElementById('gv-temp').innerHTML       = `${r.temp.toFixed(1)} <span class="gauge-unit">/ 80 °C</span>`;
}

// ══════════════════════════════════════════════════════════
//  ALERTS
// ══════════════════════════════════════════════════════════
function buildAlerts(r) {
  const box    = document.getElementById('alerts-box');
  const alerts = [];

  if (r.level > 38) alerts.push({ cls: 'danger', msg: `Tank near overflow — level at ${r.level.toFixed(1)} cm` });
  if (r.level < 3)  alerts.push({ cls: 'danger', msg: `Tank critically low — level at ${r.level.toFixed(1)} cm` });
  if (Math.abs(r.level - r.sp) > 5) alerts.push({ cls: 'warn', msg: `Large error: ${Math.abs(r.level - r.sp).toFixed(1)} cm from setpoint` });
  if (r.temp > 60)  alerts.push({ cls: 'warn',   msg: `High temperature: ${r.temp.toFixed(1)}°C` });
  if (!alerts.length) alerts.push({ cls: 'ok',   msg: 'System nominal — all parameters within range' });

  box.innerHTML = alerts.map(a => `<div class="alert-box ${a.cls}">${a.msg}</div>`).join('');
}

// ══════════════════════════════════════════════════════════
//  CHARTS
// ══════════════════════════════════════════════════════════
function buildCharts() {
  if (!readings.length) return;
  const labels = readings.map(r => r.idx);

  ['cLevel','cFlow','cTemp','cPWM'].forEach(id => {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  });

  // Level vs Setpoint
  charts['cLevel'] = new Chart(document.getElementById('cLevel'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Level', data: readings.map(r => r.level),
          borderColor: '#185FA5', backgroundColor: 'rgba(24,95,165,0.07)',
          tension: .3, fill: true, pointRadius: 2, borderWidth: 2 },
        { label: 'Setpoint', data: readings.map(r => r.sp),
          borderColor: '#E24B4A', borderDash: [5,3],
          tension: 0, pointRadius: 0, borderWidth: 1.5 }
      ]
    },
    options: chartOpts('cm')
  });

  // Flow rates
  charts['cFlow'] = new Chart(document.getElementById('cFlow'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Inflow',  data: readings.map(r => r.fin),
          borderColor: '#1D9E75', tension: .3, pointRadius: 2, borderWidth: 2 },
        { label: 'Outflow', data: readings.map(r => r.fout),
          borderColor: '#EF9F27', borderDash: [4,3], tension: .3, pointRadius: 2, borderWidth: 2 }
      ]
    },
    options: chartOpts('L/min')
  });

  // Temperature
  const tc = document.getElementById('cTemp');
  if (tc) {
    charts['cTemp'] = new Chart(tc, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Temp', data: readings.map(r => r.temp),
          borderColor: '#D85A30', tension: .3, pointRadius: 2, borderWidth: 2 }
      ]},
      options: chartOpts('°C')
    });
  }

  // Pump PWM
  const pc = document.getElementById('cPWM');
  if (pc) {
    charts['cPWM'] = new Chart(pc, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'PWM', data: readings.map(r => r.pwm),
          borderColor: '#7F77DD', tension: .3, pointRadius: 2, borderWidth: 2,
          fill: true, backgroundColor: 'rgba(127,119,221,0.07)' }
      ]},
      options: { ...chartOpts('%'), scales: { y: { min: 0, max: 100, title: { display: true, text: '%' } } } }
    });
  }
}

// Shared Chart.js options
function chartOpts(yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales:  { y: { title: { display: true, text: yLabel } } }
  };
}

function clearData() {
  if (!confirm('Clear all readings? This cannot be undone.')) return;
  readings = [];
  persist();
  refreshAll();
}

// ══════════════════════════════════════════════════════════
//  PID TUNING
// ══════════════════════════════════════════════════════════

// Ziegler–Nichols calculator
function calcZN() {
  const ku = parseFloat(document.getElementById('ku').value);
  const pu = parseFloat(document.getElementById('pu').value);
  if (isNaN(ku) || isNaN(pu)) return;

  document.getElementById('zp-kp').textContent  = (0.5  * ku).toFixed(3);
  document.getElementById('zpi-kp').textContent = (0.45 * ku).toFixed(3);
  document.getElementById('zpi-ti').textContent = `Ti = ${(pu / 1.2).toFixed(2)} s`;
  document.getElementById('zpid-kp').textContent = (0.6 * ku).toFixed(3);
  document.getElementById('zpid-ti').textContent = `Ti = ${(pu / 2).toFixed(2)} s`;
  document.getElementById('zpid-td').textContent = `Td = ${(pu / 8).toFixed(2)} s`;
}

// Apply Z-N PID values to gain fields
function applyZN() {
  const ku = parseFloat(document.getElementById('ku').value);
  const pu = parseFloat(document.getElementById('pu').value);
  if (isNaN(ku) || isNaN(pu)) { alert('Enter Ku and Pu first.'); return; }

  const kp = 0.6 * ku;
  const ti = pu / 2;
  const td = pu / 8;
  document.getElementById('pk').value = kp.toFixed(3);
  document.getElementById('ik').value = (kp / ti).toFixed(4);
  document.getElementById('dk').value = (kp * td).toFixed(4);
  updatePIDDisplay();
}

// Generate ESP8266 Arduino snippet from current gains
function updatePIDDisplay() {
  const kp = parseFloat(document.getElementById('pk').value) || 0;
  const ki = parseFloat(document.getElementById('ik').value) || 0;
  const kd = parseFloat(document.getElementById('dk').value) || 0;

  document.getElementById('arduino-code').textContent =
`double Kp = ${kp.toFixed(4)};
double Ki = ${ki.toFixed(4)};
double Kd = ${kd.toFixed(4)};
double setpoint = ${SP()};

double error, prevError = 0, integral = 0;

// In loop():
double input     = readUltrasonic();   // HC-SR04
error            = setpoint - input;
integral        += error * dt;
double derivative = (error - prevError) / dt;
double output    = Kp*error + Ki*integral + Kd*derivative;
output           = constrain(output, 0, 255);
analogWrite(PUMP_PIN, (int)output);    // ESP8266 PWM
prevError        = error;`;
}

// Save PID session
function savePID() {
  const kp = parseFloat(document.getElementById('pk').value);
  if (isNaN(kp)) { alert('Enter Kp first.'); return; }
  pidSessions.push({
    ts    : new Date().toLocaleTimeString(),
    kp,
    ki    : parseFloat(document.getElementById('ik').value)       || 0,
    kd    : parseFloat(document.getElementById('dk').value)       || 0,
    method: document.getElementById('tune-method').value,
    obs   : document.getElementById('tune-obs').value
  });
  persist();
  buildPIDHist();
}

// Render PID history table
function buildPIDHist() {
  const el = document.getElementById('pid-hist');
  if (!pidSessions.length) {
    el.innerHTML = '<div class="empty">No sessions saved.</div>';
    return;
  }
  const rows = [...pidSessions].reverse().map(p =>
    `<tr>
      <td>${p.ts}</td>
      <td>${p.kp.toFixed(3)}</td>
      <td>${p.ki.toFixed(4)}</td>
      <td>${p.kd.toFixed(4)}</td>
      <td>${p.method}</td>
      <td style="color:#888;font-size:12px">${p.obs || ''}</td>
    </tr>`
  ).join('');
  el.innerHTML = `
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr><th>Time</th><th>Kp</th><th>Ki</th><th>Kd</th><th>Method</th><th>Notes</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  DATA LOG TABLE
// ══════════════════════════════════════════════════════════
function buildLog() {
  document.getElementById('log-count').textContent = readings.length + ' readings';
  const wrap = document.getElementById('log-wrap');

  if (!readings.length) {
    wrap.innerHTML = '<div class="empty">No readings logged yet.</div>';
    return;
  }

  const rows = [...readings].reverse().slice(0, 50).map(r => {
    const err = r.sp ? (r.level - r.sp).toFixed(2) : '—';
    const cls = r.sp
      ? (Math.abs(r.level - r.sp) < 1 ? 'good' : Math.abs(r.level - r.sp) < 3 ? 'warn' : 'bad')
      : 'info';
    return `<tr>
      <td>${r.idx}</td>
      <td>${r.ts}</td>
      <td>${r.level.toFixed(1)}</td>
      <td>${r.sp || '—'}</td>
      <td>${err !== '—' ? `<span class="badge ${cls}">${err}</span>` : '—'}</td>
      <td>${r.fin.toFixed(2)}</td>
      <td>${r.fout.toFixed(2)}</td>
      <td>${r.temp.toFixed(1)}</td>
      <td>${r.pwm.toFixed(0)}</td>
      <td>${r.mode || ''}</td>
      <td style="font-size:12px;color:#888">${r.note || ''}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Time</th><th>Level</th><th>SP</th><th>Error</th>
            <th>Qin</th><th>Qout</th><th>Temp</th><th>PWM</th><th>Mode</th><th>Notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  PERFORMANCE ANALYSIS
// ══════════════════════════════════════════════════════════
function buildPerf() {
  const el   = document.getElementById('perf-wrap');
  const sp_r = readings.filter(r => r.sp > 0);

  if (sp_r.length < 5) {
    el.innerHTML = '<div class="empty">Log at least 5 readings with a setpoint set.</div>';
    return;
  }

  const errors      = sp_r.map(r => r.level - r.sp);
  const absE        = errors.map(Math.abs);
  const maxE        = Math.max(...absE).toFixed(2);
  const ssE         = errors[errors.length - 1].toFixed(2);
  const overshoot   = Math.max(...errors).toFixed(2);
  const sp          = sp_r[0].sp;
  const ovPct       = (Math.max(...errors) / sp * 100).toFixed(1);
  const riseIdx     = sp_r.findIndex(r => r.level >= sp * 0.9);
  const settleCount = errors.filter(e => Math.abs(e) <= sp * 0.02).length;

  const bar = (v, good, bad, max) => {
    const w = Math.min(100, v / max * 100);
    const c = v <= good ? '#1D9E75' : v <= bad ? '#EF9F27' : '#E24B4A';
    return `<div class="perf-bar-bg">
      <div style="height:100%;border-radius:4px;width:${w}%;background:${c};transition:width .4s"></div>
    </div>`;
  };

  const mcCls = (v, g, b) => v <= g ? 'ok-card' : v <= b ? 'warn-card' : 'alert-card';

  el.innerHTML = `
    <div class="metrics">
      <div class="mc ${mcCls(Math.abs(ssE), 0.5, 1.5)}">
        <div class="mlabel">Steady-state error</div>
        <div class="mval">${ssE}<span class="munit">cm</span></div>
      </div>
      <div class="mc ${mcCls(parseFloat(maxE), 1, 3)}">
        <div class="mlabel">Max abs error</div>
        <div class="mval">${maxE}<span class="munit">cm</span></div>
      </div>
      <div class="mc ${mcCls(parseFloat(ovPct), 10, 20)}">
        <div class="mlabel">Overshoot</div>
        <div class="mval">${overshoot}<span class="munit">cm</span></div>
      </div>
      <div class="mc">
        <div class="mlabel">Overshoot %</div>
        <div class="mval">${ovPct}<span class="munit">%</span></div>
      </div>
    </div>

    <div class="card">
      <div class="ctitle">Performance index</div>

      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#666;margin-bottom:3px">
          <span>Steady-state error</span><span>${Math.abs(ssE)} cm</span>
        </div>
        ${bar(Math.abs(ssE), 0.5, 1.5, 5)}
      </div>

      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#666;margin-bottom:3px">
          <span>Max error</span><span>${maxE} cm</span>
        </div>
        ${bar(parseFloat(maxE), 1, 3, 10)}
      </div>

      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#666;margin-bottom:3px">
          <span>Overshoot %</span><span>${ovPct}%</span>
        </div>
        ${bar(parseFloat(ovPct), 10, 20, 50)}
      </div>

      <div style="margin-top:1rem;font-size:13px;color:#666">
        Readings within 2% of SP:
        <strong style="color:#111">${settleCount} / ${sp_r.length}</strong>
        &nbsp;|&nbsp;
        Rise to 90% SP: reading
        <strong style="color:#111">${riseIdx >= 0 ? riseIdx + 1 : '—'}</strong>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  EXPORT CSV
// ══════════════════════════════════════════════════════════
function exportCSV() {
  let csv = 'Index,Time,Level_cm,Setpoint_cm,Error_cm,Inflow_Lmin,Outflow_Lmin,Temp_C,PWM_pct,Mode,Notes\n';
  readings.forEach(r => {
    csv += `${r.idx},${r.ts},${r.level},${r.sp || 0},` +
           `${r.sp ? (r.level - r.sp).toFixed(2) : 0},` +
           `${r.fin},${r.fout},${r.temp},${r.pwm},${r.mode || ''},"${r.note || ''}"\n`;
  });
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'esp8266_control_log.csv';
  a.click();
}

// ══════════════════════════════════════════════════════════
//  MISC
// ══════════════════════════════════════════════════════════
function updateSP() {
  if (readings.length) buildAlerts(readings[readings.length - 1]);
}

function updateMode() { /* reserved for future mode-switch logic */ }

function refreshAll() {
  buildLog();
  buildPIDHist();
  buildAlerts({ level: SP(), sp: SP(), fin: 0, fout: 0, temp: 25, pwm: 0, note: '' });
  if (readings.length) {
    const last = readings[readings.length - 1];
    updateMetrics(last);
    updateGauges(last);
  }
}

// ── Kick off ───────────────────────────────────────────────
load();
