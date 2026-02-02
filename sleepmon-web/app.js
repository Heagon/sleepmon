/* SleepMon web (Time window v6)
   - Bỏ chọn ngày & bảng ngưng thở
   - Chỉ hiển thị cửa sổ 10 phút (mặc định từ 00:00)
   - Chọn thời điểm bằng dropdown 24h: giờ 00-23, phút bước 10
   - Live (tuỳ chọn): hiển thị 10 phút gần nhất (rolling)
*/

const { DateTime } = luxon;

// ===== CHANGE THIS (nếu bạn đổi worker domain) =====
const API_BASE = "https://sleepmon-api.sleepmon.workers.dev";

const TZ = "Asia/Ho_Chi_Minh";
const WINDOW_MIN = 10;

// Colors
const SPO2_COLOR = "#e53935";      // đỏ
const RMS_COLOR  = "#3b82f6";      // xanh dương

// UI refs
const connPill = document.getElementById("connPill");
const livePill = document.getElementById("livePill");
const liveToggle = document.getElementById("liveToggle");
const reloadBtn = document.getElementById("reloadBtn");

const hourPick = document.getElementById("hourPick");
const minPick  = document.getElementById("minPick");
const applyTimeBtn = document.getElementById("applyTimeBtn");
const windowNote = document.getElementById("windowNote");

const spo2DayLabel = document.getElementById("spo2DayLabel");
const rmsDayLabel  = document.getElementById("rmsDayLabel");

// Charts
let spo2Chart, rmsChart;

// Live
let liveTimer = null;

// Cache day data
let cachedDateISO = null;
let cachedDay = null; // { date, points: [{ts,spo2,rms}] }

function setConn(ok) {
  connPill.textContent = ok ? "API: OK" : "API: chưa kết nối";
  connPill.style.color = ok ? "var(--ok)" : "var(--muted)";
}

function setLivePill(on) {
  livePill.textContent = on ? "LIVE: ON" : "LIVE: OFF";
  livePill.style.color = on ? "var(--warn)" : "var(--muted)";
}

function hanoiNow() {
  return DateTime.now().setZone(TZ);
}

function hanoiTodayStr() {
  return hanoiNow().toFormat("yyyy-LL-dd");
}

function fmtDayDisp(isoDate) {
  return DateTime.fromISO(isoDate, { zone: TZ }).toFormat("dd-LL-yyyy");
}

async function apiGet(path){
  const r = await fetch(API_BASE + path, { method:"GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

function pad2(n){ return String(n).padStart(2,"0"); }

function initTimePick(){
  if (!hourPick || !minPick) return;

  hourPick.innerHTML = "";
  for (let h=0; h<=23; h++){
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = pad2(h);
    hourPick.appendChild(opt);
  }

  minPick.innerHTML = "";
  for (let m=0; m<=50; m+=10){
    const opt = document.createElement("option");
    opt.value = String(m);
    opt.textContent = pad2(m);
    minPick.appendChild(opt);
  }

  hourPick.value = "0";
  minPick.value = "0";
}

function getPickedTime(){
  const hh = Math.max(0, Math.min(23, Number(hourPick?.value ?? 0)));
  const mm = Math.max(0, Math.min(50, Number(minPick?.value ?? 0)));
  return { hh, mm };
}

function getWindowMs(dateISO, hh, mm){
  const start = DateTime.fromISO(dateISO, { zone: TZ }).startOf("day").plus({ hours: hh, minutes: mm });
  const end   = start.plus({ minutes: WINDOW_MIN });
  return { startMs: start.toMillis(), endMs: end.toMillis(), start, end };
}

function setDayLabels(dateISO){
  const d = fmtDayDisp(dateISO);
  spo2DayLabel.textContent = d;
  rmsDayLabel.textContent = d;
}

function ensureCharts(){
  if (!spo2Chart){
    spo2Chart = new Chart(document.getElementById("spo2Chart"), {
      type: "line",
      data: { datasets: [] },
      options: baseChartOptions("SpO2 (%)"),
    });
  }
  if (!rmsChart){
    rmsChart = new Chart(document.getElementById("rmsChart"), {
      type: "line",
      data: { datasets: [] },
      options: baseChartOptions("Audio RMS"),
    });
  }
}

function baseChartOptions(title){
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: true, labels: { color: "#dbe7ff" } },
      title:  { display: false, text: title },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const v = ctx.parsed?.y;
            return `${ctx.dataset.label}: ${v ?? ""}`;
          }
        }
      }
    },
    scales: {
      x: {
        type: "time",
        adapters: { date: { zone: TZ } },
        time: { unit: "minute" },
        ticks: { color: "#9db4d6" },
        grid: { color: "rgba(157,180,214,0.15)" },
      },
      y: {
        ticks: { color: "#9db4d6" },
        grid: { color: "rgba(157,180,214,0.15)" },
      }
    }
  };
}

function buildDataset(points, key, label, color){
  return {
    label,
    data: points
      .filter(p => p[key] !== null && p[key] !== undefined)
      .map(p => ({ x: p.ts * 1000, y: p[key] })),
    borderColor: color,
    backgroundColor: "transparent",
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.2,
  };
}

async function fetchTodayDay(){
  const today = hanoiTodayStr();
  if (cachedDateISO === today && cachedDay) return { dateISO: today, day: cachedDay };

  const q = encodeURIComponent(today);
  const res = await apiGet(`/telemetry/days?dates=${q}`);
  // res.days: [{date, points:[{ts,spo2,rms}]}]
  const day = res?.days?.[0];
  if (!day || !Array.isArray(day.points)) throw new Error("No day data");

  cachedDateISO = today;
  cachedDay = day;
  return { dateISO: today, day };
}

function applyWindowToCharts(dateISO, day, hh, mm){
  const { startMs, endMs, start, end } = getWindowMs(dateISO, hh, mm);

  // filter within [start,end)
  const windowPoints = day.points.filter(p => {
    const t = (p.ts ?? 0) * 1000;
    return t >= startMs && t < endMs;
  });

  spo2Chart.data.datasets = [buildDataset(windowPoints, "spo2", "SpO2 (%)", SPO2_COLOR)];
  rmsChart.data.datasets  = [buildDataset(windowPoints, "rms",  "RMS",      RMS_COLOR)];

  // lock x-axis to 10-minute window
  spo2Chart.options.scales.x.min = startMs;
  spo2Chart.options.scales.x.max = endMs;
  rmsChart.options.scales.x.min  = startMs;
  rmsChart.options.scales.x.max  = endMs;

  spo2Chart.update();
  rmsChart.update();

  setDayLabels(dateISO);
  if (windowNote){
    windowNote.textContent = `Đang xem: ${fmtDayDisp(dateISO)} • ${start.toFormat("HH:mm")} → ${end.toFormat("HH:mm")} (${WINDOW_MIN} phút)`;
  }
}

async function loadTodayAndRenderByTime(){
  ensureCharts();

  try{
    const { dateISO, day } = await fetchTodayDay();
    setConn(true);

    const { hh, mm } = getPickedTime();
    applyWindowToCharts(dateISO, day, hh, mm);
  }catch(e){
    setConn(false);
    console.error(e);
    // clear charts
    spo2Chart.data.datasets = [];
    rmsChart.data.datasets = [];
    spo2Chart.update();
    rmsChart.update();
  }
}

// ===== Live mode (rolling 10 minutes) =====
function stopLive(){
  if (liveTimer){
    clearInterval(liveTimer);
    liveTimer = null;
  }
  setLivePill(false);
}

async function startLiveRollingWindow(){
  ensureCharts();
  setLivePill(true);

  // Ensure we have base day loaded (for labels)
  try{
    await fetchTodayDay();
    setConn(true);
  }catch(e){
    setConn(false);
  }

  // Reset datasets
  spo2Chart.data.datasets = [buildDataset([], "spo2", "SpO2 (%)", SPO2_COLOR)];
  rmsChart.data.datasets  = [buildDataset([], "rms",  "RMS",      RMS_COLOR)];
  spo2Chart.update();
  rmsChart.update();

  liveTimer = setInterval(async () => {
    try{
      const res = await apiGet("/telemetry/latest");
      setConn(true);
      const p = res.point;
      if (!p || !p.ts) return;

      const nowMs = p.ts * 1000;
      const startMs = nowMs - WINDOW_MIN * 60 * 1000;
      const endMs = nowMs;

      // push
      const dsSpo2 = spo2Chart.data.datasets[0];
      const dsRms  = rmsChart.data.datasets[0];

      if (p.spo2 !== null && p.spo2 !== undefined){
        dsSpo2.data.push({ x: nowMs, y: p.spo2 });
      }
      if (p.rms !== null && p.rms !== undefined){
        dsRms.data.push({ x: nowMs, y: p.rms });
      }

      // trim
      dsSpo2.data = dsSpo2.data.filter(pt => pt.x >= startMs);
      dsRms.data  = dsRms.data.filter(pt => pt.x >= startMs);

      // lock x axis
      spo2Chart.options.scales.x.min = startMs;
      spo2Chart.options.scales.x.max = endMs;
      rmsChart.options.scales.x.min  = startMs;
      rmsChart.options.scales.x.max  = endMs;

      spo2Chart.update("none");
      rmsChart.update("none");

      const noteStart = DateTime.fromMillis(startMs, { zone: TZ });
      const noteEnd   = DateTime.fromMillis(endMs, { zone: TZ });
      if (windowNote){
        windowNote.textContent = `Live: ${noteStart.toFormat("HH:mm")} → ${noteEnd.toFormat("HH:mm")} (${WINDOW_MIN} phút)`;
      }
      setDayLabels(hanoiTodayStr());
    }catch(e){
      setConn(false);
      console.error(e);
    }
  }, 1000);
}

// ===== UI events =====
applyTimeBtn?.addEventListener("click", async () => {
  if (liveToggle) liveToggle.checked = false;
  stopLive();
  await loadTodayAndRenderByTime();
});

reloadBtn?.addEventListener("click", async () => {
  cachedDateISO = null;
  cachedDay = null;
  if (liveToggle?.checked){
    stopLive();
    startLiveRollingWindow();
  } else {
    await loadTodayAndRenderByTime();
  }
});

liveToggle?.addEventListener("change", async () => {
  if (liveToggle.checked){
    stopLive();
    startLiveRollingWindow();
  } else {
    stopLive();
    await loadTodayAndRenderByTime();
  }
});

// ===== INIT =====
(function init(){
  initTimePick();
  ensureCharts();
  setLivePill(false);
  if (liveToggle) liveToggle.checked = false;
  loadTodayAndRenderByTime();
})();
