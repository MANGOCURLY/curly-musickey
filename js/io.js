// ================= 저장 (브라우저 안 IndexedDB) =================
// 작업(슬롯 1~8)과 내 소리 3칸을 이 기기의 이 브라우저에 저장한다.
// 크롬 '인터넷 사용 기록 삭제'에서 사이트 데이터를 지우면 함께 사라진다.
const DB_NAME = "curly-musickey";
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("projects"); r.result.createObjectStore("samples"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function dbPut(store, key, val) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).put(val, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbGet(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

// 바뀔 때마다 1초 뒤에 자동 저장 (연달아 바뀌면 마지막 한 번만)
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1000);
}
async function saveNow() {
  clearTimeout(saveTimer);
  const p = { ...proj, events: proj.events.map(stripRec) };
  try { await dbPut("projects", slot, p); localStorage.setItem("cmk-slot", slot); } catch (e) { console.warn(e); }
}

// first = 페이지를 처음 열 때. 이때는 아직 빈 작업이라 저장하면 슬롯을 빈 것으로 덮어쓴다
async function loadSlot(n, first = false) {
  if (!first) await saveNow();
  stopPlay();
  slot = n;
  const p = await dbGet("projects", n).catch(() => null);
  proj = Object.assign(newProject(), p || {});
  undoStack.length = 0; redoStack.length = 0;
  lastEvo = "";
  if (delayNode) delayNode.delayTime.value = delayTimeForBpm();
  render(); renderGrid();
  try { localStorage.setItem("cmk-slot", n); } catch (e) {}
  return !!p;
}

async function loadSamples() {
  for (let i = 0; i < 3; i++) {
    const s = await dbGet("samples", i).catch(() => null);
    if (s) SAMPLES[i] = toBuffer(s.data, s.rate);
  }
}
// AudioBuffer는 어느 오디오 컨텍스트에서도 쓸 수 있어서, 시작 전에도 OfflineAudioContext로 만들어 둔다
function toBuffer(data, rate) {
  const b = new OfflineAudioContext(1, data.length, rate).createBuffer(1, data.length, rate);
  b.copyToChannel(data, 0);
  return b;
}

// ================= 마이크 =================
// 마이크 → (같은 오디오 시계로) 소리 조각을 모은다. 내 소리 녹음과 비트박스가 같이 쓴다
const mic = { stream: null, node: null, chunks: [], mode: null, slot: 0, timer: null };

async function micStart(mode) {
  toast(t("micAsk"));
  try {
    if (navigator.audioSession) navigator.audioSession.type = "play-and-record";
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: mode === "beatbox", noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    toast(t("micFail"));
    return false;
  }
  if (ctx.state !== "running") await ctx.resume();
  const src = ctx.createMediaStreamSource(mic.stream);
  const node = ctx.createScriptProcessor(2048, 1, 1);
  mic.chunks = [];
  node.onaudioprocess = e => {
    // 이 조각이 실제로 들어온 시각 ≈ 지금 시각 - 조각 길이
    mic.chunks.push({ time: ctx.currentTime - e.inputBuffer.duration, data: new Float32Array(e.inputBuffer.getChannelData(0)) });
  };
  const mute = gainNode(0);
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);  // 연결해 둬야 iOS에서 계속 돈다
  mic.node = { src, node, mute };
  mic.mode = mode;
  return true;
}

function micStop() {
  if (mic.node) { mic.node.src.disconnect(); mic.node.node.disconnect(); mic.node.mute.disconnect(); }
  if (mic.stream) mic.stream.getTracks().forEach(tr => tr.stop());
  mic.stream = null; mic.node = null; mic.mode = null;
  clearTimeout(mic.timer);
  if (navigator.audioSession) navigator.audioSession.type = "playback";
}

// ---------- 내 소리 녹음 (Ctrl + I / [ / \) ----------
const SAMPLE_MAX_SEC = 6;
async function toggleSampleRec(n) {
  if (mic.mode === "sample") { finishSample(); return; }
  if (mic.mode) return;
  if (!(await micStart("sample"))) return;
  mic.slot = n;
  toast(t("micRec")(trackShort("u" + n)), 60000);
  mic.timer = setTimeout(finishSample, SAMPLE_MAX_SEC * 1000);
  render();
}

function finishSample() {
  const n = mic.slot, rate = ctx.sampleRate;
  const all = concat(mic.chunks.map(c => c.data));
  micStop();
  // 앞뒤 조용한 부분을 잘라 내고, 가장 큰 소리를 0.9에 맞춘다
  let a = 0, b = all.length - 1;
  while (a < all.length && Math.abs(all[a]) < 0.02) a++;
  while (b > a && Math.abs(all[b]) < 0.02) b--;
  if (b - a < rate * 0.03) { toast(t("micEmpty")); render(); return; }
  a = Math.max(0, a - Math.floor(rate * 0.005));
  const data = all.slice(a, b + 1);
  let peak = 0;
  for (const x of data) peak = Math.max(peak, Math.abs(x));
  const fade = Math.min(data.length, Math.floor(rate * 0.01));
  for (let i = 0; i < data.length; i++) {
    data[i] *= 0.9 / peak;
    if (i > data.length - fade) data[i] *= (data.length - i) / fade;
  }
  SAMPLES[n] = toBuffer(data, rate);
  dbPut("samples", n, { data, rate }).catch(e => console.warn(e));
  proj.track = "u" + n;
  focus = proj.track;
  toast(t("micDone")(trackShort(proj.track)));
  const now = ctx.currentTime;
  startSample(n, 60, now);
  render();
}

function concat(arrs) {
  const out = new Float32Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ---------- 비트박스 → 드럼 (Ctrl+B) ----------
// 다음 루프 첫 칸부터 한 바퀴 동안 메트로놈만 들려주고 마이크를 듣는다.
// 끝나면 소리 난 순간을 찾아 낮은 소리=킥, 높은 소리=하이햇, 나머지=스네어로 바꿔 넣는다.
const beatbox = { state: null, t0: 0, t1: 0 };
const BEATBOX_OFFSET = 0.0;   // 기록이 늘 한쪽으로 밀리면 여기서 보정 (초)

async function startBeatbox() {
  if (beatbox.state) return;
  if (mic.mode) return;
  if (!(await micStart("beatbox"))) return;
  if (!playing) startPlay();
  beatbox.state = "armed";
  toast(t("bbArm"), 60000);
  render();
}
function beatboxLoopStart(time) {
  if (beatbox.state === "armed") {
    beatbox.state = "rec";
    beatbox.t0 = time;
    beatbox.t1 = time + totalSteps() * stepDur();
    setTimeout(() => toast(t("bbRec"), 60000), Math.max(0, (time - ctx.currentTime) * 1000));
    setTimeout(finishBeatbox, (beatbox.t1 - ctx.currentTime + 0.3) * 1000);
  }
}
const beatboxMuting = time => beatbox.state === "rec" && time >= beatbox.t0 && time < beatbox.t1;

function finishBeatbox() {
  if (beatbox.state !== "rec") return;
  const chunks = mic.chunks, rate = ctx.sampleRate;
  micStop();
  beatbox.state = null;
  // 조각들을 하나로 이으면서 각 샘플의 시각을 알 수 있게 첫 시각을 기억한다
  const startTime = chunks.length ? chunks[0].time : 0;
  const all = concat(chunks.map(c => c.data));
  const hits = detectHits(all, rate);
  const sd = stepDur(), n = totalSteps(), seen = new Set(), evs = [];
  for (const h of hits) {
    const time = startTime + h.i / rate - BEATBOX_OFFSET;
    if (time < beatbox.t0 - sd / 2 || time >= beatbox.t1 - sd / 2) continue;
    const step = Math.round((time - beatbox.t0) / sd) % n;
    const k = h.idx + ":" + step;
    if (seen.has(k)) continue;
    seen.add(k);
    evs.push({ kind: "drum", kit: proj.kit, idx: h.idx, step });
  }
  if (evs.length) { change(() => proj.events.push(...evs)); focus = "drums"; toast(t("bbDone")(evs.length)); }
  else toast(t("bbNone"));
  render();
}

// 소리 난 순간 찾기: 짧은 구간(256샘플)의 크기가 직전 평균보다 확 커지면 '타격'
function detectHits(x, rate) {
  const hop = 256, hits = [];
  const frames = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += x[j] * x[j];
    frames.push(Math.sqrt(s / hop));
  }
  let lastHit = -1e9;
  for (let f = 4; f < frames.length; f++) {
    const avg = (frames[f - 1] + frames[f - 2] + frames[f - 3] + frames[f - 4]) / 4;
    if (frames[f] > 0.04 && frames[f] > avg * 2.5 && (f - lastHit) * hop > rate * 0.08) {
      lastHit = f;
      hits.push({ i: f * hop, idx: classify(x, f * hop, rate) });
    }
  }
  return hits;
}
// 타격 직후 40ms의 낮은 소리(약 150Hz 아래)와 높은 소리(약 4kHz 위) 비율로 종류를 정한다
function classify(x, i0, rate) {
  const n = Math.min(x.length - i0, Math.floor(rate * 0.04));
  const aLo = 1 - Math.exp(-2 * Math.PI * 150 / rate), aHi = 1 - Math.exp(-2 * Math.PI * 4000 / rate);
  let lo = 0, lp4 = 0, eLo = 0, eHi = 0, eAll = 0;
  for (let i = i0; i < i0 + n; i++) {
    lo += aLo * (x[i] - lo);
    lp4 += aHi * (x[i] - lp4);
    const hi = x[i] - lp4;
    eLo += lo * lo; eHi += hi * hi; eAll += x[i] * x[i];
  }
  if (eAll === 0) return 1;
  if (eLo / eAll > 0.3) return 0;   // 킥
  if (eHi / eAll > 0.3) return 3;   // 닫힌 하이햇
  return 1;                          // 스네어
}

// ================= 세션 녹음 (시작 화면에서 켰을 때) =================
// 스피커로 나가는 소리를 그대로 압축 녹음한다. 형식은 브라우저가 정한다 (아이폰: m4a, 크롬 PC: webm)
const session = { rec: null, chunks: [], type: "" };
function startSession() {
  if (!window.MediaRecorder) return;
  const dest = ctx.createMediaStreamDestination();
  analyser.connect(dest);
  session.type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(m => MediaRecorder.isTypeSupported(m)) || "";
  session.rec = new MediaRecorder(dest.stream, session.type ? { mimeType: session.type } : undefined);
  session.chunks = [];
  session.rec.ondataavailable = e => { if (e.data.size) session.chunks.push(e.data); };
  session.rec.start(1000);
}

// ================= 내보내기 (Ctrl+E) =================
// 루프·진화 재생은 '오프라인 오디오'로 실제 시간보다 빠르게 그려서 파일로 만든다
const EX_WHAT = ["loop", "evo", "session"], EX_FMT = ["wav", "mp3"];
const exportUI = { open: false, what: 0, fmt: 0, busy: false, file: null };

function openExport() { exportUI.open = true; exportUI.file = null; exportUI.busy = false; renderOverlay(); }
function closeExport() { exportUI.open = false; renderOverlay(); }

function exportKey(code) {
  if (code === "Escape") return closeExport();
  if (exportUI.busy) return;
  if (exportUI.file && code === "Enter") return deliver(exportUI.file);
  if (code === "ArrowUp") exportUI.what = (exportUI.what + 2) % 3;
  else if (code === "ArrowDown") exportUI.what = (exportUI.what + 1) % 3;
  else if (code === "ArrowLeft" || code === "ArrowRight") exportUI.fmt = 1 - exportUI.fmt;
  else if (code === "Enter") return makeExport();
  exportUI.file = null;
  renderOverlay();
}

async function makeExport() {
  const what = EX_WHAT[exportUI.what], fmt = EX_FMT[exportUI.fmt];
  const name = `curly-musickey-${slot}-${what}`;
  if (what === "session") {
    if (!session.rec) { exportUI.msg = t("exNoSession"); renderOverlay(); return; }
    session.rec.requestData();
    await new Promise(r => setTimeout(r, 300));
    const ext = session.type.includes("mp4") ? "m4a" : "webm";
    exportUI.file = new File(session.chunks, `${name}.${ext}`, { type: session.type || "audio/webm" });
    renderOverlay();
    return;
  }
  if (fmt === "mp3" && !window.lamejs) { exportUI.msg = t("mp3Missing"); renderOverlay(); return; }
  if (what === "evo" && !proj.evo.length) { exportUI.msg = t("evoNone"); renderOverlay(); return; }
  exportUI.busy = true; exportUI.msg = t("exRendering"); renderOverlay();
  await new Promise(r => setTimeout(r, 50));  // 화면에 '만드는 중'이 먼저 보이게
  try {
    const loops = what === "loop" ? Array(4).fill(proj) : proj.evo;
    const buf = await renderLoops(loops);
    const blob = fmt === "wav" ? encodeWav(buf) : encodeMp3(buf);
    exportUI.file = new File([blob], `${name}.${fmt}`, { type: fmt === "wav" ? "audio/wav" : "audio/mpeg" });
    exportUI.msg = "";
  } catch (e) {
    console.error(e);
    exportUI.msg = String(e.message || e);
  }
  exportUI.busy = false;
  renderOverlay();
}

// 루프 여러 개(각각 events·bars·bpm)를 이어서 오프라인으로 그린다. 끝에 2초 여운
async function renderLoops(loops) {
  const rate = 48000;
  let total = 0;
  for (const L of loops) total += totalSteps(L) * stepDur(L.bpm);
  const off = new OfflineAudioContext(2, Math.ceil((total + 2) * rate), rate);
  const saved = getGraph();
  initAudio(off);
  try {
    let t0 = 0.05;
    for (const L of loops) {
      const sd = stepDur(L.bpm);
      delayNode.delayTime.setValueAtTime(Math.min(2, 0.75 * 60 / L.bpm), t0);
      for (const ev of L.events) playEvent(ev, t0 + ev.step * sd, L.bpm);
      t0 += totalSteps(L) * sd;
    }
    return await off.startRendering();
  } finally {
    setGraph(saved);
  }
}

// WAV: 16비트 스테레오. 머리말(44바이트) + 소리 숫자들
function encodeWav(buf) {
  const ch = [buf.getChannelData(0), buf.getChannelData(1)], n = buf.length, rate = buf.sampleRate;
  const view = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + n * 4, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 2; c++) { view.setInt16(o, Math.max(-1, Math.min(1, ch[c][i])) * 32767, true); o += 2; }
  return new Blob([view], { type: "audio/wav" });
}

// MP3: lamejs(js/lib/lame.min.js)로 192kbps
function encodeMp3(buf) {
  const enc = new lamejs.Mp3Encoder(2, buf.sampleRate, 192);
  const toI16 = a => { const o = new Int16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.max(-1, Math.min(1, a[i])) * 32767; return o; };
  const L = toI16(buf.getChannelData(0)), R = toI16(buf.getChannelData(1)), parts = [];
  for (let i = 0; i < L.length; i += 1152) {
    const d = enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152));
    if (d.length) parts.push(d);
  }
  const end = enc.flush();
  if (end.length) parts.push(end);
  return new Blob(parts, { type: "audio/mpeg" });
}

// 파일 건네기: 공유 창(카톡·파일에 저장 등)이 되면 그걸로, 안 되면 내려받기
async function deliver(file) {
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) {
    if (e.name === "AbortError") return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
