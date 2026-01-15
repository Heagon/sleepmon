/* SleepMon web (public viewer)
   - Chọn 1 hoặc nhiều ngày (7 ngày gần nhất) để lọc:
     + đồ thị SpO2 và RMS
     + danh sách file Abnormal (play trực tiếp + tải WAV)
   - API POST yêu cầu Bearer token; GET có thể public (tuỳ cấu hình Worker).
*/

const API_BASE = "https://sleepmon-api.sleepmon.workers.dev"; // <-- đổi theo Worker của bạn
const TZ = "Asia/Ho_Chi_Minh";

// UI refs
const connPill = document.getElementById("connPill");
const livePill = document.getElementById("livePill");
const dateBox  = document.getElementById("dateBox");
const modeNote = document.getElementById("modeNote");
const liveToggle = document.getElementById("liveToggle");
const reloadBtn  = document.getElementById("reloadBtn");
const abnList   = document.getElementById("abnList");

const tokenInput = document.getElementById("tokenInput");
const saveTokenBtn = document.getElementById("saveTokenBtn");
const clearTokenBtn = document.getElementById("clearTokenBtn");
const tokenHint = document.getElementById("tokenHint");

const spo2Canvas = document.getElementById("spo2Chart");
const rmsCanvas  = document.getElementById("rmsChart");
const spo2Fallback = document.getElementById("spo2Fallback");
const rmsFallback  = document.getElementById("rmsFallback");

const TOKEN_KEY = "sleepmon_token_v1";

let selectedDates = [];
let liveTimer = null;
let lastLiveTs = 0;

// Abnormal cache
let abnAllItems = [];
const abnDecodedCache = new Map(); // key -> { wavBlob, wavUrl, meta }

// Palettes (màu nhẹ để phân biệt ngày)
const PALETTE_SPO2 = ["#7dd3fc", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#60a5fa", "#f472b6"];
const PALETTE_RMS  = ["#c4b5fd", "#93c5fd", "#6ee7b7", "#fde68a", "#fda4af", "#a7f3d0", "#fdba74"];

// ===== Time helpers (không dùng luxon) =====
function partsInTz(date){
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (t) => parts.find(p => p.type === t)?.value;
  return { y: get("year"), m: get("month"), d: get("day") };
}

function hanoiTodayIso(){
  const p = partsInTz(new Date());
  return `${p.y}-${p.m}-${p.d}`; // YYYY-MM-DD
}

function isoFromTsSec(ts){
  const p = partsInTz(new Date(ts * 1000));
  return `${p.y}-${p.m}-${p.d}`;
}

function fmtDayDisp(iso){
  // iso: YYYY-MM-DD -> DD-MM-YYYY
  const [y,m,d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function fmtHanoi(tsSec){
  // dd-mm-yyyy HH:MM:SS in Hanoi
  const s = new Intl.DateTimeFormat("vi-VN", {
    timeZone: TZ,
    year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit",
    hour12:false
  }).format(new Date(tsSec * 1000));
  return s;
}

function last7Dates(){
  const today = hanoiTodayIso();
  const [y,m,d] = today.split("-").map(x=>parseInt(x,10));
  // tạo Date theo TZ +07 ổn định bằng cách parse ISO có offset
  const base = new Date(`${today}T12:00:00+07:00`); // giữa trưa để tránh DST edge
  const out = [];
  for (let i=0;i<7;i++){
    const dt = new Date(base.getTime() - i*86400*1000);
    const p = partsInTz(dt);
    out.push(`${p.y}-${p.m}-${p.d}`);
  }
  return out;
}

// ===== API helpers =====
function getToken(){
  return localStorage.getItem(TOKEN_KEY) || "";
}

function authHeaders(){
  const t = getToken().trim();
  const h = {};
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

async function apiGet(path){
  const r = await fetch(API_BASE + path, {
    method: "GET",
    headers: {
      ...authHeaders(),
    }
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=> "");
    throw new Error(`HTTP ${r.status} ${txt}`.trim());
  }
  return await r.json();
}

async function apiGetBinary(path){
  const r = await fetch(API_BASE + path, {
    method: "GET",
    headers: {
      ...authHeaders(),
    }
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=> "");
    throw new Error(`HTTP ${r.status} ${txt}`.trim());
  }
  return await r.arrayBuffer();
}

function setConn(ok, msg){
  connPill.textContent = ok ? (msg || "API: đã kết nối") : (msg || "API: chưa kết nối");
  connPill.classList.toggle("good", !!ok);
}

function setLivePill(on){
  livePill.textContent = on ? "LIVE: ON" : "LIVE: OFF";
  livePill.classList.toggle("good", !!on);
}

// ===== Charts =====
let spo2Chart = null;
let rmsChart = null;

function chartAvailable(){
  return (typeof Chart !== "undefined");
}

function ensureCharts(){
  if (!chartAvailable()){
    spo2Canvas.style.display = "none";
    rmsCanvas.style.display = "none";
    spo2Fallback.style.display = "block";
    rmsFallback.style.display = "block";
    return;
  }

  if (spo2Chart && rmsChart) return;

  const common = {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: {
          type: "linear",
          ticks: {
            callback: (v) => {
              try{
                const d = new Date(Number(v));
                return new Intl.DateTimeFormat("vi-VN", { timeZone: TZ, hour:"2-digit", minute:"2-digit", hour12:false }).format(d);
              }catch(e){ return ""; }
            }
          }
        },
        y: { beginAtZero: false }
      },
      plugins: {
        legend: { labels: { color: "#e9f0ff" } },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items || !items.length) return "";
              const x = items[0].parsed.x;
              return new Intl.DateTimeFormat("vi-VN", {
                timeZone: TZ,
                year:"numeric", month:"2-digit", day:"2-digit",
                hour:"2-digit", minute:"2-digit", second:"2-digit",
                hour12:false
              }).format(new Date(x));
            }
          }
        }
      }
    }
  };

  spo2Chart = new Chart(spo2Canvas.getContext("2d"), JSON.parse(JSON.stringify(common)));
  rmsChart  = new Chart(rmsCanvas.getContext("2d"), JSON.parse(JSON.stringify(common)));

  // tweak y labels
  spo2Chart.options.scales.y.title = { display: true, text: "SpO2 (%)", color:"#e9f0ff" };
  rmsChart.options.scales.y.title  = { display: true, text: "RMS", color:"#e9f0ff" };
}

function datasetsFromDays(daysObj, field, palette){
  const datasets = [];
  selectedDates.forEach((d, idx) => {
    const arr = (daysObj && daysObj[d]) ? daysObj[d] : [];
    const data = arr
      .filter(p => p[field] !== null && p[field] !== undefined)
      .map(p => ({ x: p.ts * 1000, y: p[field] }));

    datasets.push({
      label: fmtDayDisp(d),
      data,
      pointRadius: 0,
      borderWidth: 2,
      borderColor: palette[idx % palette.length],
      tension: 0.2
    });
  });
  return datasets;
}

// ===== Date selector =====
function canLive(){
  const today = hanoiTodayIso();
  return selectedDates.length === 1 && selectedDates[0] === today;
}

function stopLive(){
  if (liveTimer){ clearInterval(liveTimer); liveTimer = null; }
  setLivePill(false);
}

function setModeNote(){
  if (selectedDates.length === 0){
    modeNote.textContent = "Chưa chọn ngày nào.";
  } else if (selectedDates.length === 1){
    modeNote.textContent = "Đang xem: " + fmtDayDisp(selectedDates[0]) + (canLive() ? " (có thể bật Live)" : "");
  } else {
    modeNote.textContent = "Đang so sánh " + selectedDates.length + " ngày (Live bị tắt).";
  }
}

function renderDateSelector(){
  const dates = last7Dates();
  const today = hanoiTodayIso();

  dateBox.innerHTML = "";
  dates.forEach(d => {
    const chip = document.createElement("label");
    chip.className = "datechip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedDates.includes(d);

    const span = document.createElement("span");
    span.textContent = fmtDayDisp(d) + (d === today ? " (Hôm nay)" : "");

    cb.addEventListener("change", async () => {
      if (cb.checked){
        if (!selectedDates.includes(d)) selectedDates.push(d);
      } else {
        selectedDates = selectedDates.filter(x => x !== d);
        if (selectedDates.length === 0){
          // luôn giữ ít nhất 1 ngày
          selectedDates = [today];
        }
      }

      // sort newest->oldest theo mảng last7Dates
      const order = new Map(dates.map((x,i)=>[x,i]));
      selectedDates.sort((a,b)=>order.get(a)-order.get(b));

      if (selectedDates.length > 1){
        liveToggle.checked = false;
        stopLive();
      }
      setModeNote();
      renderDateSelector();
      await loadSelected();
      renderAbnFiltered();
    });

    chip.appendChild(cb);
    chip.appendChild(span);
    dateBox.appendChild(chip);
  });

  // enforce live toggle state
  liveToggle.disabled = !canLive();
  setModeNote();
}

// ===== Telemetry loading =====
async function loadSelected(){
  ensureCharts();

  if (selectedDates.length === 0){
    if (spo2Chart) { spo2Chart.data.datasets = []; spo2Chart.update(); }
    if (rmsChart)  { rmsChart.data.datasets = []; rmsChart.update(); }
    return;
  }

  try{
    const q = encodeURIComponent(selectedDates.join(","));
    const res = await apiGet(`/telemetry/days?dates=${q}`);
    setConn(true);

    if (chartAvailable()){
      spo2Chart.data.datasets = datasetsFromDays(res.days, "spo2", PALETTE_SPO2);
      rmsChart.data.datasets  = datasetsFromDays(res.days, "rms",  PALETTE_RMS);
      spo2Chart.update();
      rmsChart.update();
    }
  }catch(e){
    setConn(false, "API: lỗi (telemetry)");
    console.error(e);
    // giữ selector vẫn chạy
    if (chartAvailable()){
      spo2Chart.data.datasets = [];
      rmsChart.data.datasets = [];
      spo2Chart.update();
      rmsChart.update();
    }
  }
}

async function pollLive(){
  try{
    const res = await apiGet("/telemetry/latest");
    setConn(true);
    const p = res.point;
    if (!p) return;

    if (p.ts && p.ts <= lastLiveTs) return;
    lastLiveTs = p.ts;

    if (!chartAvailable()) return;
    if (!spo2Chart.data.datasets.length || !rmsChart.data.datasets.length){
      await loadSelected();
      return;
    }

    const dsSpo2 = spo2Chart.data.datasets[0];
    const dsRms  = rmsChart.data.datasets[0];

    if (p.spo2 !== null && p.spo2 !== undefined){
      dsSpo2.data.push({ x: p.ts * 1000, y: p.spo2 });
    }
    if (p.rms !== null && p.rms !== undefined){
      dsRms.data.push({ x: p.ts * 1000, y: p.rms });
    }

    const cutoff = Date.now() - 6 * 3600 * 1000;
    dsSpo2.data = dsSpo2.data.filter(pt => pt.x >= cutoff);
    dsRms.data  = dsRms.data.filter(pt => pt.x >= cutoff);

    spo2Chart.update("none");
    rmsChart.update("none");
  }catch(e){
    setConn(false, "API: lỗi (live)");
  }
}

async function loadTodayThenLive(){
  const today = hanoiTodayIso();
  selectedDates = [today];
  renderDateSelector();
  await loadSelected();

  lastLiveTs = 0;
  stopLive();
  liveTimer = setInterval(pollLive, 2000);
  setLivePill(true);
}

// ===== Abnormal =====
function renderAbnFiltered(){
  const allow = new Set(selectedDates);
  const filtered = (abnAllItems || []).filter(it => allow.has(isoFromTsSec(it.ts)));
  renderAbn(filtered);
}

function renderAbn(items){
  abnList.innerHTML = "";
  if (!items || items.length === 0){
    abnList.innerHTML = `<div class="sub muted">Không có file abnormal cho các ngày đã chọn.</div>`;
    return;
  }

  items.forEach(it => {
    const row = document.createElement("div");
    row.className = "abnRow";

    const meta = document.createElement("div");
    meta.className = "abnMeta";
    meta.innerHTML = `<div class="abnName"><b>${escapeHtml(it.filename || it.r2_key || "unknown")}</b></div>
      <div class="sub muted">${fmtHanoi(it.ts)} • ${(it.size_bytes||0)} bytes</div>`;

    const actions = document.createElement("div");
    actions.className = "abnActions";

    const btnPlay = document.createElement("button");
    btnPlay.className = "btn small";
    btnPlay.textContent = "Giải mã & Play";

    const btnWav = document.createElement("button");
    btnWav.className = "btn small";
    btnWav.textContent = "Tải WAV";

    const btnRaw = document.createElement("button");
    btnRaw.className = "btn small";
    btnRaw.textContent = "Tải file gốc";

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.style.width = "260px";
    audio.style.display = "none";

    const status = document.createElement("div");
    status.className = "sub muted";
    status.style.marginTop = "6px";

    async function ensureDecoded(){
      const key = it.r2_key || it.key;
      if (!key) throw new Error("Missing r2_key");

      if (abnDecodedCache.has(key)){
        return abnDecodedCache.get(key);
      }

      status.textContent = "Đang tải & giải mã…";
      const ab = await apiGetBinary(`/abnormal/get?key=${encodeURIComponent(key)}`);
      const { wavBlob } = decodeSMA1(ab);
      const wavUrl = URL.createObjectURL(wavBlob);
      const cached = { wavBlob, wavUrl };
      abnDecodedCache.set(key, cached);
      status.textContent = "OK";
      return cached;
    }

    btnPlay.addEventListener("click", async () => {
      try{
        const c = await ensureDecoded();
        audio.src = c.wavUrl;
        audio.style.display = "block";
        await audio.play();
      }catch(e){
        console.error(e);
        status.textContent = "Lỗi decode/play: " + (e?.message || e);
      }
    });

    btnWav.addEventListener("click", async () => {
      try{
        const c = await ensureDecoded();
        const base = (it.filename || "abnormal").replace(/\.[^.]+$/,"");
        downloadBlob(c.wavBlob, base + ".wav");
      }catch(e){
        console.error(e);
        status.textContent = "Lỗi tải WAV: " + (e?.message || e);
      }
    });

    btnRaw.addEventListener("click", async () => {
      try{
        const key = it.r2_key || it.key;
        if (!key) throw new Error("Missing r2_key");
        const ab = await apiGetBinary(`/abnormal/get?key=${encodeURIComponent(key)}`);
        const blob = new Blob([ab], { type: "application/octet-stream" });
        const name = (it.filename || "abnormal.sma");
        downloadBlob(blob, name.endsWith(".sma") ? name : (name + ".sma"));
      }catch(e){
        console.error(e);
        status.textContent = "Lỗi tải file gốc: " + (e?.message || e);
      }
    });

    actions.appendChild(btnPlay);
    actions.appendChild(btnWav);
    actions.appendChild(btnRaw);

    row.appendChild(meta);
    row.appendChild(actions);
    row.appendChild(audio);
    row.appendChild(status);
    abnList.appendChild(row);
  });
}

async function loadAbn(){
  try{
    const res = await apiGet(`/abnormal/list?days=7`);
    setConn(true);
    abnAllItems = res.items || [];
    renderAbnFiltered();
  }catch(e){
    setConn(false, "API: lỗi (abnormal)");
    console.error(e);
    abnList.innerHTML = `<div class="sub err">Lỗi tải danh sách abnormal.</div>`;
  }
}

// ===== SMA1 / IMA-ADPCM decode =====
const IMA_INDEX_TABLE = [
  -1,-1,-1,-1, 2, 4, 6, 8,
  -1,-1,-1,-1, 2, 4, 6, 8
];

const IMA_STEP_TABLE = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,
  97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,
  658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,
  3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,
  13899,15289,16818,18500,20350,22385,24623,27086,29794,32767
];

function clamp16(v){
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}

function readU32LE(dv, off){ return dv.getUint32(off, true); }
function readI16LE(dv, off){ return dv.getInt16(off, true); }

function decodeSMA1(arrayBuffer){
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 64) throw new Error("SMA1 too small");

  const magic = String.fromCharCode(
    dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)
  );
  if (magic !== "SMA1") throw new Error("Bad magic: " + magic);

  const headerSize  = readU32LE(dv, 4);
  const sampleRate  = readU32LE(dv, 8);
  const blockSamples= readU32LE(dv, 12);
  const totalSamples= readU32LE(dv, 16);
  // startEpoch at 20 (not used)
  const dataBytes   = readU32LE(dv, 28);

  const dataStart = headerSize || 64;
  const dataEnd   = Math.min(dv.byteLength, dataStart + dataBytes);

  const pcm = new Int16Array(totalSamples || 0);
  let w = 0;

  let p = dataStart;
  const blockBytes = 4 + Math.floor(blockSamples / 2);

  while (p + 4 <= dataEnd && w < pcm.length){
    const predictor = readI16LE(dv, p);
    let index = dv.getUint8(p + 2);
    // reserved = dv.getUint8(p+3)
    p += 4;

    let pred = predictor;
    index = Math.max(0, Math.min(88, index));
    pcm[w++] = pred;

    // number of samples remaining in this block
    let samplesLeft = Math.min(blockSamples - 1, pcm.length - w);

    let nibblePhase = 0; // 0->low,1->high
    let curByte = 0;

    while (samplesLeft > 0 && p < dataEnd){
      if (nibblePhase === 0){
        curByte = dv.getUint8(p++);
      }

      const code = (nibblePhase === 0) ? (curByte & 0x0F) : ((curByte >> 4) & 0x0F);
      nibblePhase ^= 1;

      let step = IMA_STEP_TABLE[index];
      let diffq = step >> 3;
      if (code & 1) diffq += step >> 2;
      if (code & 2) diffq += step >> 1;
      if (code & 4) diffq += step;
      if (code & 8) pred -= diffq; else pred += diffq;
      pred = clamp16(pred);

      index += IMA_INDEX_TABLE[code];
      index = Math.max(0, Math.min(88, index));

      pcm[w++] = pred;
      samplesLeft--;
    }

    // skip padding bytes of this block if any (to fixed size)
    const bytesUsed = 4 + Math.ceil((blockSamples - 1) / 2);
    const pad = blockBytes - bytesUsed;
    if (pad > 0) p = Math.min(dataEnd, p + pad);
  }

  const pcmUsed = (w === pcm.length) ? pcm : pcm.subarray(0, w);
  const wavBuf = pcm16ToWav(pcmUsed, sampleRate || 16000);
  const wavBlob = new Blob([wavBuf], { type: "audio/wav" });
  return { wavBlob, sampleRate, totalSamples: pcmUsed.length };
}

function pcm16ToWav(pcm16, sampleRate){
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample/8);
  const blockAlign = numChannels * (bitsPerSample/8);
  const dataSize = pcm16.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);

  function writeStr(off, s){
    for (let i=0;i<s.length;i++) dv.setUint8(off+i, s.charCodeAt(i));
  }

  writeStr(0,"RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8,"WAVE");
  writeStr(12,"fmt ");
  dv.setUint32(16, 16, true); // PCM chunk size
  dv.setUint16(20, 1, true);  // PCM format
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  writeStr(36,"data");
  dv.setUint32(40, dataSize, true);

  // PCM data
  let off = 44;
  for (let i=0;i<pcm16.length;i++, off+=2){
    dv.setInt16(off, pcm16[i], true);
  }
  return buf;
}

// ===== Small helpers =====
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}

// ===== Events =====
liveToggle.addEventListener("change", async () => {
  if (liveToggle.checked){
    if (!canLive()){
      liveToggle.checked = false;
      return;
    }
    await loadTodayThenLive();
  } else {
    stopLive();
  }
});

reloadBtn.addEventListener("click", async () => {
  stopLive();
  await loadSelected();
  await loadAbn();
});

saveTokenBtn.addEventListener("click", async () => {
  const t = tokenInput.value.trim();
  if (t){
    localStorage.setItem(TOKEN_KEY, t);
    tokenHint.textContent = "Đã lưu token.";
  } else {
    localStorage.removeItem(TOKEN_KEY);
    tokenHint.textContent = "Token rỗng → đã xoá.";
  }
  await warmup();
});

clearTokenBtn.addEventListener("click", async () => {
  localStorage.removeItem(TOKEN_KEY);
  tokenInput.value = "";
  tokenHint.textContent = "Đã xoá token.";
  await warmup();
});

// ===== Warmup =====
async function warmup(){
  // luôn render selector trước
  renderDateSelector();

  // thử /health để cập nhật pill nhanh
  try{
    const r = await fetch(API_BASE + "/health");
    if (r.ok){
      setConn(true);
    } else {
      setConn(false);
    }
  }catch(e){
    setConn(false);
  }

  await loadSelected();
  await loadAbn();
}

// init
(function init(){
  tokenInput.value = getToken();
  tokenHint.textContent = getToken() ? "Token đang được dùng cho API calls." : "Chưa set token (nếu API read yêu cầu auth thì sẽ fail).";

  selectedDates = [hanoiTodayIso()];
  ensureCharts();
  warmup();
})();
