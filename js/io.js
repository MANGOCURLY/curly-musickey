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

// 저장 형식: 마이크 녹음은 소리 숫자(data) 그대로, 불러온 파일은 원래 파일(file, 압축된 상태)로 저장한다
async function loadSamples() {
  for (let i = 0; i < 3; i++) {
    const s = await dbGet("samples", i).catch(() => null);
    if (!s) continue;
    try {
      SAMPLES[i] = s.file ? await decodeFile(s.file) : toBuffer(s.data, s.rate);
      SAMPLE_META[i] = s.meta || { kind: "pitch" };
    } catch (e) { console.warn(e); }
  }
}
function saveSampleMeta(n) {
  dbGet("samples", n).then(s => { if (s) { s.meta = SAMPLE_META[n]; return dbPut("samples", n, s); } }).catch(e => console.warn(e));
}
// AudioBuffer는 어느 오디오 컨텍스트에서도 쓸 수 있어서, 시작 전에도 OfflineAudioContext로 만들어 둔다
function toBuffer(data, rate) {
  const b = new OfflineAudioContext(1, data.length, rate).createBuffer(1, data.length, rate);
  b.copyToChannel(data, 0);
  return b;
}

// ================= 마이크 =================
// 마이크 → (같은 오디오 시계로) 소리 조각을 모은다. 내 소리 녹음과 비트박스가 같이 쓴다
const mic = { stream: null, node: null, chunks: [], mode: null, slot: 0, timer: null, starting: false };
// 마이크 허락 상태: unknown(아직) / granted / denied(거부) / nodevice(마이크 없음) / unsupported(브라우저가 지원 안 함) / error
let micPerm = "unknown";

const micSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
function micErrorState(e) {
  if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) return "denied";
  if (e && (e.name === "NotFoundError" || e.name === "OverconstrainedError")) return "nodevice";
  return "error";
}
// 상태별 안내 문장 (허락 거부면 다시 허용하는 방법까지)
const micProblem = () => t("micState")[micPerm] || t("micFail");

// 시작 버튼을 탭할 때 허락을 미리 받아 둔다. 허락만 받고 마이크는 바로 끈다:
// 아이폰은 마이크가 켜져 있는 동안 소리를 통화 모드로 바꿔 출력이 작아지거나 블루투스 음질이 떨어지기 때문
async function requestMicPermission() {
  if (!micSupported()) { micPerm = "unsupported"; return; }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(tr => tr.stop());
    micPerm = "granted";
  } catch (e) {
    micPerm = micErrorState(e);
  }
  restorePlayback();
}

// 마이크를 끈 뒤 아이폰이 오디오를 멈춰 두는 경우가 있어서 다시 켠다
function restorePlayback() {
  if (navigator.audioSession) { try { navigator.audioSession.type = "playback"; } catch (e) {} }
  if (ctx && ctx.state !== "running" && document.visibilityState === "visible") ctx.resume().then(render, () => {});
}

async function micStart(mode) {
  if (mic.mode || mic.starting) return false;   // 빠르게 두 번 눌러 마이크가 두 번 켜지는 것 막기
  if (!micSupported()) { micPerm = "unsupported"; notice(micProblem()); return false; }
  mic.starting = true;
  if (micPerm !== "granted") toast(t("micAsk"));
  try {
    if (navigator.audioSession) navigator.audioSession.type = "play-and-record";
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: mode === "beatbox", noiseSuppression: false, autoGainControl: false },
    });
    micPerm = "granted";
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
    // 녹음 중에 마이크가 끊기면(이어폰을 뽑는 등) 거기까지 녹음된 것을 저장한다
    mic.stream.getAudioTracks().forEach(tr => { tr.onended = () => {
      if (mic.mode === "sample") { finishSample(); toast(t("micLost") + " · " + $("msg").textContent, 5000); }
      else if (mic.mode === "beatbox") { micStop(); beatbox.state = null; toast(t("micLost")); render(); }
    }; });
  } catch (e) {
    if (mic.stream) mic.stream.getTracks().forEach(tr => tr.stop());
    mic.stream = null;
    micPerm = e && e.name ? micErrorState(e) : "error";
    mic.starting = false;
    restorePlayback();
    $("msg").classList.remove("show");   // '마이크 준비 중…' 알림은 지운다
    notice(micProblem());
    return false;
  }
  mic.mode = mode;
  mic.starting = false;
  return true;
}

function micStop() {
  if (mic.node) { mic.node.src.disconnect(); mic.node.node.disconnect(); mic.node.mute.disconnect(); }
  if (mic.stream) mic.stream.getTracks().forEach(tr => { tr.onended = null; tr.stop(); });
  mic.stream = null; mic.node = null; mic.mode = null;
  clearTimeout(mic.timer);
  clearInterval(mic.ticker);
  restorePlayback();
}

// ---------- 내 소리 녹음 (Ctrl + I / [ / \) ----------
// 누르고 있는 동안 녹음하고 키를 떼면 완료. 짧게 톡 누르면 손을 떼도 계속 녹음하고, 같은 키를 다시 누르면 완료.
// 녹음 중에는 경과 시간과 소리 크기 막대를 보여 준다.
const SAMPLE_MAX_SEC = 30;
const CHOP_MIN_SEC = 4;      // 이보다 길면 조각 모드
const HOLD_MS = 400;         // 이보다 오래 누르고 있다가 떼면 '누르는 동안 녹음'
const recKey = { down: false, at: 0, hold: false };

async function sampleKeyDown(n) {
  if (mic.mode === "sample") { finishSample(); return; }   // 톡 눌러 시작한 녹음 → 다시 누르면 완료
  if (mic.mode || mic.starting) return;   // 마이크를 켜는 중에 또 누른 것은 무시
  Object.assign(recKey, { down: true, at: performance.now(), hold: false });
  if (!(await micStart("sample"))) { recKey.down = false; return; }
  // 아이폰 첫 사용 때는 마이크 허락 창이 뜬다. 그사이 길게 눌렀던 키를 이미 뗐다면 녹음하지 않는다
  if (!recKey.down && recKey.hold) { micStop(); toast(t("micReady"), 3000); render(); return; }
  mic.slot = n;
  mic.recAt = performance.now();
  mic.timer = setTimeout(finishSample, SAMPLE_MAX_SEC * 1000);
  mic.ticker = setInterval(showRecProgress, 100);
  showRecProgress();
  render();
}

function sampleKeyUp() {
  if (!recKey.down) return;
  recKey.down = false;
  recKey.hold = performance.now() - recKey.at >= HOLD_MS;
  if (recKey.hold && mic.mode === "sample") finishSample();   // 누르고 있다가 뗌 → 완료
}

// 녹음 중 표시: "● U1 녹음 중 3.4초 / 30초 ▮▮▮▯▯▯▯▯ 키를 떼면 완료"
function showRecProgress() {
  const sec = (performance.now() - mic.recAt) / 1000;
  const last = mic.chunks[mic.chunks.length - 1];
  let rms = 0;
  if (last) { for (const x of last.data) rms += x * x; rms = Math.sqrt(rms / last.data.length); }
  const bars = Math.min(8, Math.round(Math.sqrt(rms) * 16));
  const meter = "▮".repeat(bars) + "▯".repeat(8 - bars);
  toast(t("micRec")(trackShort("u" + mic.slot), sec.toFixed(1), SAMPLE_MAX_SEC, meter, recKey.down), 1000);
  render();
}

function finishSample() {
  if (mic.mode !== "sample") return;
  const n = mic.slot, rate = ctx.sampleRate;
  const all = concat(mic.chunks.map(c => c.data));
  micStop();
  // 가장 큰 소리와 찌그러진(1.0에 닿은) 부분 세기
  let peak = 0, clipped = 0;
  for (const x of all) { const v = Math.abs(x); if (v > peak) peak = v; if (v >= 0.99) clipped++; }
  // 아이폰은 자동 음량 조절을 끄고 녹음해서 소리가 작게 들어올 수 있다.
  // 그래서 '조용함' 기준을 고정값이 아니라 가장 큰 소리의 4%로 잡는다 (너무 작은 녹음도 살린다)
  if (peak < 0.003) { toast(t("micEmpty"), 4000); render(); return; }
  const thr = Math.max(0.002, peak * 0.04);
  let a = 0, b = all.length - 1;
  while (a < all.length && Math.abs(all[a]) < thr) a++;
  while (b > a && Math.abs(all[b]) < thr) b--;
  if (b - a < rate * 0.03) { toast(t("micEmpty"), 4000); render(); return; }
  a = Math.max(0, a - Math.floor(rate * 0.01));          // 소리 시작 직전 10ms는 남겨서 첫소리가 잘리지 않게
  b = Math.min(all.length - 1, b + Math.floor(rate * 0.05));   // 끝 여운 50ms
  const data = all.slice(a, b + 1);
  const fade = Math.min(data.length, Math.floor(rate * 0.01));
  for (let i = 0; i < data.length; i++) {
    data[i] *= 0.9 / peak;
    if (i > data.length - fade) data[i] *= (data.length - i) / fade;
  }
  SAMPLES[n] = toBuffer(data, rate);
  SAMPLE_META[n] = data.length > rate * CHOP_MIN_SEC
    ? { kind: "chop", name: t("micName"), ...detectTempo(data, rate), match: true }
    : { kind: "pitch" };
  dbPut("samples", n, { data, rate, meta: SAMPLE_META[n] }).catch(e => console.warn(e));
  proj.track = "u" + n;
  focus = proj.track;
  // 완료 알림: 실제로 저장된 길이(앞뒤 무음을 자른 뒤)와 어떤 모드가 됐는지
  const msg = t("micDone")(trackShort(proj.track), (data.length / rate).toFixed(1), SAMPLE_META[n].kind === "chop");
  // 0.1% 넘게 1.0에 닿았으면 찌그러졌을 가능성이 크다 → 경고를 붙인다
  toast(clipped > all.length * 0.001 ? msg + " · " + t("micClip") : msg, 4000);
  startSample(n, 60, ctx.currentTime);
  render();
}

// ---------- 음악 파일 불러오기 (LCD의 불러오기 버튼) ----------
// 지금 고른 내 소리 칸에 넣는다. 내 소리를 고르고 있지 않으면 빈 칸, 다 차 있으면 1번 칸
const FILE_MAX_MB = 60, FILE_MAX_SEC = 360;
async function importFile(file) {
  if (!file) return;
  if (file.size > FILE_MAX_MB * 1024 * 1024) { toast(t("fileTooBig")(FILE_MAX_MB)); return; }
  const n = proj.track[0] === "u" ? +proj.track.slice(1) : Math.max(0, SAMPLES.findIndex(s => !s));
  toast(t("fileLoading"), 60000);
  try {
    const ab = await file.arrayBuffer();
    const buf = await decodeFile(ab);
    const tempo = detectTempo(buf.getChannelData(0), buf.sampleRate);
    SAMPLES[n] = buf;
    SAMPLE_META[n] = { kind: "chop", name: file.name.replace(/\.[^.]+$/, ""), ...tempo, match: true };
    await dbPut("samples", n, { file: ab, meta: SAMPLE_META[n] });
    proj.track = "u" + n;
    focus = proj.track;
    scheduleSave();
    toast(t("fileDone")(trackShort(proj.track), tempo.bpm), 4000);
  } catch (e) {
    console.warn(e);
    toast(t("fileFail"), 4000);
  }
  render();
}

// 파일 → 소리 데이터. 메모리를 아끼려고 한 채널(모노)로 합치고 최대 6분까지만 쓴다
async function decodeFile(ab) {
  const rate = ctx ? ctx.sampleRate : 48000;
  const dec = await new OfflineAudioContext(1, 1, rate).decodeAudioData(ab.slice(0));
  const len = Math.min(dec.length, Math.floor(dec.sampleRate * FILE_MAX_SEC));
  const mono = new Float32Array(len);
  for (let c = 0; c < dec.numberOfChannels; c++) {
    const d = dec.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / dec.numberOfChannels;
  }
  return toBuffer(mono, dec.sampleRate);
}

// ---------- BPM 감지 ----------
// 소리가 '확 커지는' 순간들의 간격이 가장 잘 맞는 템포를 찾는다 (앞 60초만 본다)
// 결과: {bpm, start(첫 박 위치, 초)}
function detectTempo(data, rate) {
  const hop = 512, n = Math.min(data.length, rate * 60), env = [];
  let prev = 0;
  for (let i = 0; i + hop <= n; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += data[j] * data[j];
    const e = Math.sqrt(s / hop);
    env.push(Math.max(0, e - prev));
    prev = e;
  }
  const fps = rate / hop;
  const at = x => { const i = Math.floor(x), f = x - i; return (env[i] || 0) * (1 - f) + (env[i + 1] || 0) * f; };
  const score = bpm => {
    const lag = 60 * fps / bpm;
    let s = 0;
    for (let i = 0; i + 2 * lag < env.length; i++) s += env[i] * (at(i + lag) + 0.5 * at(i + 2 * lag));
    return s / (env.length - 2 * lag);
  };
  // 먼저 0.5 간격으로 넓게, 그다음 찾은 근처를 0.05 간격으로 좁게 (조금만 틀려도 뒤 조각이 밀리기 때문)
  let best = 120, bestScore = -1;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) { const s = score(bpm); if (s > bestScore) { bestScore = s; best = bpm; } }
  // 절반·두 배 속도는 구분이 애매하다. 80보다 느리게 잡혔는데 두 배도 충분히 맞으면 두 배를 고른다
  // (틀리면 조각 모드에서 Ctrl+↑↓로 ×2 / ÷2)
  if (best < 80 && score(best * 2) > bestScore * 0.5) { best *= 2; bestScore = score(best); }
  const coarse = best;
  for (let bpm = coarse - 0.5; bpm <= coarse + 0.5; bpm += 0.05) { const s = score(bpm); if (s > bestScore) { bestScore = s; best = bpm; } }
  best = Math.round(best * 100) / 100;
  // 첫 박 위치(대략): 박 간격마다 더했을 때 가장 큰 자리
  const lag = 60 * fps / best;
  let phase = 0, phaseScore = -1;
  for (let p = 0; p < lag; p++) {
    let s = 0;
    for (let x = p; x < env.length; x += lag) s += at(x);
    if (s > phaseScore) { phaseScore = s; phase = p; }
  }
  return refineTempo(data, rate, n, best, phase / fps);
}

// 정밀하게 맞추기: 타격 순간을 3ms 단위로 찾고, 박 위에 있는 타격들의 (박 번호, 시각)을 직선으로 맞춘다.
// 직선의 기울기 = 한 박 길이, 시작점 = 첫 박 위치
function refineTempo(data, rate, n, bpm, start) {
  // 크기는 23ms(1024샘플) 길이로 재고, 그 창을 3ms(128샘플)씩 옮긴다.
  // 창이 너무 짧으면 낮은 킥 소리의 물결 자체를 새 타격으로 잘못 잡는다.
  const hop = 128, win = 1024, cs = new Float64Array(n + 1), env = [];
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + data[i] * data[i];
  let prev = 0;
  for (let i = 0; i + win <= n; i += hop) {
    const e = Math.sqrt((cs[i + win] - cs[i]) / win);
    env.push(Math.max(0, e - prev));
    prev = e;
  }
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  const onsets = [];   // [시각, 세기]
  let last = -1e9;
  for (let f = 1; f < env.length - 1; f++)
    if (env[f] > mean * 4 && env[f] >= env[f - 1] && env[f] >= env[f + 1] && (f - last) * hop > rate * 0.08) {
      onsets.push([(f * hop + win) / rate, env[f]]);   // 창 끝에 소리가 막 들어온 순간이 크기 증가가 가장 큰 때
      last = f;
    }
  if (onsets.length < 8) return { bpm, start };

  // 1) 대략 값 ±2% 안의 BPM과 첫 박 후보를 전부 대 보고, 타격이 격자에 가장 많이(세게) 맞는 조합을 고른다
  let beat = 60 / bpm, best = -1;
  for (let b = bpm * 0.98; b <= bpm * 1.02; b += bpm * 0.0005) {
    const bt = 60 / b;
    for (let s = 0; s < bt; s += 0.004) {
      let c = 0;
      for (const [t, w] of onsets) {
        const r = (t - s) / bt;
        if (Math.abs(r - Math.round(r)) * bt < 0.015) c += w;
      }
      if (c > best) { best = c; beat = bt; start = s; }
    }
  }
  // 2) 격자 위에 있는 타격들의 (박 번호, 시각)을 직선으로 맞춰 더 정밀하게
  for (let pass = 0; pass < 2; pass++) {
    const pts = [];
    for (const [t] of onsets) {
      const k = Math.round((t - start) / beat);
      if (Math.abs(t - start - k * beat) < beat * 0.05) pts.push([k, t]);
    }
    if (pts.length < 8) break;
    const m = pts.length, sk = pts.reduce((a, p) => a + p[0], 0), st = pts.reduce((a, p) => a + p[1], 0);
    const skk = pts.reduce((a, p) => a + p[0] * p[0], 0), skt = pts.reduce((a, p) => a + p[0] * p[1], 0);
    const b = (m * skt - sk * st) / (m * skk - sk * sk), a = (st - b * sk) / m;
    if (!(b > 0.25 && b < 1.2)) break;   // 엉뚱한 값이면 앞 단계 값을 그대로 쓴다
    beat = b; start = a;
  }
  start -= Math.floor(start / beat) * beat;   // 0초 이후의 첫 박
  return { bpm: Math.round((60 / beat) * 100) / 100, start };
}

// ---------- 조각 모드 조작 ----------
// 구간 옮기기 (원곡 기준 박 단위)
function moveRegion(slot, beats) {
  const m = SAMPLE_META[slot], beat = 60 / m.bpm, len = SAMPLES[slot].duration;
  m.start = Math.max(0, Math.min(len - beat, m.start + beats * beat));
  saveSampleMeta(slot);
  toast(t("regionAt")(Math.floor(m.start / (beat * 4)) + 1, m.start.toFixed(1)));
  if (preview.v) startPreview(slot);
}
// 감지가 두 배·절반으로 틀렸을 때 고친다
function scaleSongBpm(slot, f) {
  const m = SAMPLE_META[slot];
  m.bpm = Math.max(40, Math.min(300, Math.round(m.bpm * f * 2) / 2));
  saveSampleMeta(slot);
  toast(t("songBpm")(m.bpm));
}
function toggleMatch(slot) {
  const m = SAMPLE_META[slot];
  m.match = !m.match;
  saveSampleMeta(slot);
  toast(t("matchSet")(m.match));
}
// 구간 전체를 루프 처음부터 깔기 / 빼기 (구간 16박 = 64칸마다 반복)
function toggleRegionLoop(slot) {
  const id = "u" + slot, isLoop = e => e.track === id && e.midi === CHOP_WHOLE;
  if (proj.events.some(isLoop)) { change(() => { proj.events = proj.events.filter(e => !isLoop(e)); }); toast(t("loopOff")); return; }
  change(() => {
    for (let s = 0; s < totalSteps(); s += 64)
      proj.events.push({ kind: "note", track: id, midi: CHOP_WHOLE, len: Math.min(64, totalSteps() - s), step: s });
  });
  toast(t("loopOn"));
  if (!playing) startPlay();
}
// 원곡 미리 듣기: 구간 시작부터 원래 속도로 20초 (다시 누르면 멈춤)
const preview = { v: null };
function startPreview(slot) {
  if (preview.v) { stopVoice(preview.v, ctx.currentTime); preview.v = null; }
  const s = ctx.createBufferSource(), g = gainNode(0.9), now = ctx.currentTime;
  s.buffer = SAMPLES[slot];
  s.connect(g).connect(master);
  s.start(now, SAMPLE_META[slot].start, 20);
  preview.v = track(g, [s]);
  Object.assign(preview.v, { start: now, attack: 0, release: 0.05 });
  s.onended = () => { active.delete(preview.v); if (preview.v && preview.v.srcs[0] === s) preview.v = null; };
}
function togglePreview(slot) {
  if (preview.v) { stopVoice(preview.v, ctx.currentTime); preview.v = null; }
  else startPreview(slot);
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
