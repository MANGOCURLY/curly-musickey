// ================= 프로젝트 (저장되는 작업 한 개) =================
// events: 녹음·랜덤·편집으로 만든 소리들
//   {kind: "drum", kit, idx, step} | {kind: "fx", bank, idx, step} | {kind: "note", track, midi, len, step}
// evo: 진화 기록 (루프가 바뀔 때마다 찍어 둔 사진들)
function newProject() {
  return { v: 2, bpm: 128, bars: 1, key: 0, scale: "minor", density: 3, prog: [0, 5, 2, 6],
           kit: 0, track: "i4", octave: 0, bank: 0, events: [], randoms: {}, randomCount: 0, evo: [] };
}
let proj = newProject();
let slot = 1;                 // 지금 슬롯 (1~8)

const STEPS_PER_BAR = 16;
const BPM_MIN = 40, BPM_MAX = 300;
const totalSteps = (p = proj) => p.bars * STEPS_PER_BAR;
const stepDur = (bpm = proj.bpm) => 60 / bpm / 4;
// 귀에 들리는 소리는 출력 지연만큼 늦다. 녹음할 때 이만큼 빼서 기록한다
const latency = () => (ctx.outputLatency || 0) + (ctx.baseLatency || 0);

// ================= 되돌리기 (Ctrl+Z / Ctrl+Shift+Z) =================
// 바꾸기 직전의 events·bars를 글자로 찍어 두고, 되돌릴 때 그걸로 바꿔 끼운다
const undoStack = [], redoStack = [];
const UNDO_MAX = 50;
const snap = () => JSON.stringify({ events: proj.events, bars: proj.bars });

// 루프를 바꾸는 모든 동작은 change()로 감싼다 → 되돌리기 기록 + 화면 + 자동 저장
function change(fn) {
  undoStack.push(snap());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  fn();
  changed();
}
function changed() {
  renderGrid();
  scheduleSave();
}
function undo() {
  if (!undoStack.length) { toast(t("nothingUndo")); return; }
  redoStack.push(snap());
  Object.assign(proj, JSON.parse(undoStack.pop()));
  recNotes.clear();
  changed();
  toast(t("undone"));
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snap());
  Object.assign(proj, JSON.parse(redoStack.pop()));
  changed();
  toast(t("redone"));
}

// ================= 재생 =================
// 소리는 Web Audio 시계로 0.12초 앞까지 미리 예약한다 (setTimeout만으로는 박자가 흔들린다)
let playing = false, recording = false, metronome = true;
let nextStep = 0, nextStepTime = 0, timer = null;
let playStep = -1;            // 화면에 표시 중인 재생 위치
const stepQueue = [];         // 예약한 스텝과 시각 (화면 재생 위치를 소리에 맞추려고)
const recNotes = new Map();   // 녹음 중 누르고 있는 건반 code → 이벤트 (뗄 때 길이 기록)
let evoPlay = null;           // 진화 재생 중이면 {i: 지금 단계}
let lastEvo = "";             // 마지막으로 찍은 진화 사진 (같으면 안 찍는다)
let evoEnabled = true;        // 시작 화면에서 고른다

// 지금 재생할 루프: 평소에는 proj, 진화 재생 중에는 그 단계의 사진
const loopData = () => (evoPlay ? proj.evo[evoPlay.i] : proj);

function startPlay() {
  if (!ctx || ctx.state !== "running" || playing) return;
  playing = true;
  nextStep = 0;
  nextStepTime = ctx.currentTime + 0.05;
  timer = setInterval(schedule, 25);
  schedule();
}

function stopPlay() {
  playing = false;
  recording = false;
  evoPlay = null;
  beatbox.state = null;
  clearInterval(timer);
  stepQueue.length = 0;
  playStep = -1;
  recNotes.clear();
  renderGrid();
}

function schedule() {
  // 화면이 꺼졌다 돌아오면 밀린 박자를 한꺼번에 치지 않고 지금부터 다시 시작
  if (nextStepTime < ctx.currentTime - 0.2) nextStepTime = ctx.currentTime + 0.05;
  while (playing && nextStepTime < ctx.currentTime + 0.12) {
    if (nextStep === 0) onLoopStart(nextStepTime);
    if (!playing) break;
    const L = loopData();
    playStepAt(L, nextStep, nextStepTime);
    stepQueue.push({ step: nextStep, time: nextStepTime });
    nextStepTime += stepDur(L.bpm);
    nextStep = (nextStep + 1) % totalSteps(L);
  }
}

// 루프 첫 칸을 예약하기 직전: 진화 사진 찍기 / 진화 재생 다음 단계 / 비트박스 녹음 시작
function onLoopStart(time) {
  if (evoPlay) {
    if (evoPlay.started) evoPlay.i++;
    evoPlay.started = true;
    if (evoPlay.i >= proj.evo.length) { stopPlay(); render(); return; }
    render();
  } else {
    captureEvo();
  }
  beatboxLoopStart(time);
}

function playStepAt(L, step, t) {
  if ((metronome || beatbox.state) && step % 4 === 0) click(t, step === 0);
  if (beatboxMuting(t)) return;  // 비트박스 녹음 중에는 메트로놈만
  for (const ev of L.events) {
    if (ev.step !== step) continue;
    // 방금 손으로 친 소리가 같은 바퀴에서 또 울리지 않게
    if (ev.recAt !== undefined && Math.abs(ev.recAt - t) < stepDur() / 2) continue;
    playEvent(ev, t, L.bpm);
  }
}

function playEvent(ev, t, bpm = proj.bpm) {
  if (ev.kind === "drum") { out = kitBuses[ev.kit]; KITS[ev.kit].hits[ev.idx](t); }
  else if (ev.kind === "fx") { out = fxBus; FX_BANKS[ev.bank][ev.idx](t); }
  else stopVoice(startNote(ev.track, ev.midi, t), t + ev.len * stepDur(bpm));
}

// 메트로놈: 한 박마다 '틱', 마디 첫 박은 높게
function click(t, accent) {
  out = master;
  tone(t, { type: "square", f0: accent ? 1800 : 1200, dur: 0.03, vol: 0.12 });
}

// ================= 녹음 =================
// 지금 들리는 위치를 가장 가까운 16분음표로 맞춘다 → {step, at(그 스텝의 시각)}
function quantize(time = ctx.currentTime - latency()) {
  const k = Math.round((time - nextStepTime) / stepDur());
  const n = totalSteps();
  return { step: (((nextStep + k) % n) + n) % n, at: nextStepTime + k * stepDur() };
}

function record(ev) {
  if (!recording || !playing || evoPlay) return null;
  const q = quantize();
  ev.step = q.step;
  ev.recAt = q.at;
  change(() => proj.events.push(ev));
  return ev;
}

// ================= 진화 기록 =================
// 루프가 한 바퀴 돌 때마다, 직전과 달라졌으면 그 순간의 루프를 한 장 찍어 둔다
const EVO_MAX = 300;
function captureEvo() {
  if (!evoEnabled || !proj.events.length) return;
  const s = JSON.stringify({ events: proj.events.map(stripRec), bars: proj.bars, bpm: proj.bpm });
  if (s === lastEvo) return;
  lastEvo = s;
  proj.evo.push(JSON.parse(s));
  if (proj.evo.length > EVO_MAX) proj.evo.shift();
  scheduleSave();
}
// 녹음 순간 정보(recAt)는 그 자리에서만 쓰는 값이라 저장하지 않는다
function stripRec(ev) { const c = { ...ev }; delete c.recAt; return c; }

function startEvo() {
  if (!evoEnabled && !proj.evo.length) { toast(t("evoOff")); return; }
  if (!proj.evo.length) { toast(t("evoNone")); return; }
  stopPlay();
  evoPlay = { i: 0, started: false };
  startPlay();
  toast(t("evoStart")(proj.evo.length));
}

// ================= 설정 =================
function setBpm(v) {
  proj.bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, v));
  if (delayNode) delayNode.delayTime.setTargetAtTime(delayTimeForBpm(), ctx.currentTime, 0.05);
  scheduleSave();
}

// 루프 길이 1·2·4·8마디. 늘리면 지금 내용을 뒤에 복사해 이어 붙이고, 줄이면 뒤쪽을 잘라 낸다
const BAR_CHOICES = [1, 2, 4, 8];
function setBars(dir) {
  const i = BAR_CHOICES.indexOf(proj.bars) + dir;
  if (i < 0 || i >= BAR_CHOICES.length) return;
  const nb = BAR_CHOICES[i], old = totalSteps();
  change(() => {
    if (nb > proj.bars) {
      const copies = [];
      for (let k = 1; k < nb / proj.bars; k++)
        for (const ev of proj.events) copies.push({ ...stripRec(ev), step: ev.step + k * old });
      proj.events = proj.events.map(stripRec).concat(copies);
    } else {
      proj.events = proj.events.filter(ev => ev.step < nb * STEPS_PER_BAR).map(stripRec);
    }
    proj.bars = nb;
  });
  if (nextStep >= totalSteps()) nextStep = 0;
  toast(t("barsSet")(nb));
}

// ================= 지우기 =================
function deleteLast() { if (proj.events.length) change(() => proj.events.pop()); }
function clearAll() { change(() => { proj.events = []; }); toast(t("cleared")); }
// 지금 트랙만: 마지막으로 만진 것이 드럼이면 드럼 전체, 악기면 그 악기 트랙
function clearFocus() {
  if (focus === "drums") { change(() => { proj.events = proj.events.filter(e => e.kind !== "drum"); }); toast(t("clearedDrums")); }
  else { change(() => { proj.events = proj.events.filter(e => e.track !== focus); }); toast(t("clearedTrack")); }
}
let focus = "drums";          // 마지막으로 만진 트랙 ("drums" 또는 트랙 id)
