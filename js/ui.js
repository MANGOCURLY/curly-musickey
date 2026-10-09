// ================= 키 배치 =================
const DRUM_KEYS = ["KeyZ","KeyX","KeyC","KeyV","KeyB","KeyN","KeyM","Comma","Period","Slash"];
// 건반: code → A키의 도(0)에서 몇 반음 위인지 (에이블톤/로직의 컴퓨터 키보드 연주 배치)
const NOTE_KEYS = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
  KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
  KeyP: 15, Semicolon: 16, Quote: 17, BracketRight: 18,
};
const INST_KEYS = ["Digit1","Digit2","Digit3","Digit4","Digit5","Digit6","Digit7","Digit8","Digit9","Digit0"];
const USER_KEYS = ["KeyI","BracketLeft","Backslash"];   // 내 소리 1·2·3
const OCT_MIN = -2, OCT_MAX = 2;

const pressed = new Set();  // 지금 눌린 키(code)
const held = new Map();     // 누르고 있는 건반 code → 울리는 소리
const edit = { on: false, row: 0, step: 0 };
let vizOn = false;

const $ = id => document.getElementById(id);
const shiftHeld = () => pressed.has("ShiftLeft") || pressed.has("ShiftRight");

// ================= 키보드 종류 =================
// "k380" = 아이폰 + K380 (Ctrl 조합) / "mac" = 맥북 (⌘도 Ctrl처럼 받는다)
// 처음에는 기기를 보고 정한다: 터치가 없는 Mac이면 맥북
let kbProfile = /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2 ? "mac" : "k380";
try { kbProfile = localStorage.getItem("cmk-kb") || kbProfile; } catch (e) {}
function toggleKb() {
  kbProfile = kbProfile === "mac" ? "k380" : "mac";
  try { localStorage.setItem("cmk-kb", kbProfile); } catch (e) {}
  render(); renderOverlay();
}
// 맥에서 ⌘를 Ctrl처럼 받을 키. ⌘+숫자(탭 이동)·⌘+화살표(뒤로 가기)·⌘+M(최소화)처럼
// 브라우저나 macOS가 먼저 쓰는 조합은 넣지 않는다
const CMD_AS_CTRL = new Set(["KeyZ", "KeyS", "KeyE", "KeyP", "KeyB"]);

// ================= 키 입력 =================
function onKeyDown(e) {
  let ctrl = e.ctrlKey;
  if (e.metaKey) {
    if (kbProfile === "mac" && CMD_AS_CTRL.has(e.code)) ctrl = true;
    else return;          // 그 밖의 ⌘ 조합은 iOS·macOS 몫으로 남겨 둔다
  }
  e.preventDefault();     // 스크롤, 포커스 이동 등 기본 동작 막기
  if (e.repeat) return;   // 꾹 누를 때 생기는 반복 입력 무시 (BPM은 따로 반복)
  const code = e.code;
  pressed.add(code);
  if (exportUI.open) { exportKey(code); return; }
  if (helpOpen) { if (code === "Escape" || code === "Backquote") toggleHelp(); return; }

  const ready = ctx && ctx.state === "running";
  if (ctrl) ctrlKey(code, e.shiftKey, ready);
  else if (e.altKey) altKey(code);
  else if (!(edit.on && editKey(code, e.shiftKey, ready))) plainKey(code, e.shiftKey, ready);
  render();
}

function ctrlKey(code, shift, ready) {
  const n = +code.replace("Digit", ""), cs = chopSlot();
  // control+화살표는 macOS가 가로채서(Mission Control), 어디서나 되는 대체 키를 같이 둔다:
  //   Ctrl+9 / Ctrl+0 = 루프 길이,  Ctrl+, / Ctrl+. = 원곡 BPM ÷2 / ×2
  if (cs >= 0 && (code === "ArrowUp" || code === "Period")) scaleSongBpm(cs, 2);
  else if (cs >= 0 && (code === "ArrowDown" || code === "Comma")) scaleSongBpm(cs, 0.5);
  else if (cs >= 0 && code === "KeyM") toggleMatch(cs);
  else if (code === "KeyZ") shift ? redo() : undo();
  else if (code === "KeyS") { saveNow(); toast(t("saved")); }
  else if (/^Digit[1-8]$/.test(code)) loadSlot(n).then(had => toast((had ? t("slotLoaded") : t("slotNew"))(n)));
  else if (code === "ArrowLeft" || code === "Digit9") setBars(-1);
  else if (code === "ArrowRight" || code === "Digit0") setBars(1);
  else if (code === "Minus") holdBpm(code, -20);
  else if (code === "Equal") holdBpm(code, 20);
  else if (code === "Backspace") clearFocus();
  else if (code === "KeyE") openExport();
  else if (!ready) return;
  else if (code === "KeyP") evoPlay ? stopPlay() : startEvo();
  else if (code === "KeyB") startBeatbox();
  else if (USER_KEYS.includes(code)) toggleSampleRec(USER_KEYS.indexOf(code));
}

function altKey(code) {
  if (code === "ArrowLeft") setKey(-1);
  else if (code === "ArrowRight") setKey(1);
  else if (code === "ArrowUp") setDensity(1);
  else if (code === "ArrowDown") setDensity(-1);
  else if (code === "KeyQ") cycleScale();
}

function plainKey(code, shift, ready) {
  const d = DRUM_KEYS.indexOf(code), inst = INST_KEYS.indexOf(code), user = USER_KEYS.indexOf(code);
  if (inst >= 0) { proj.track = "i" + inst; focus = proj.track; scheduleSave(); }
  else if (code === "ArrowRight" || code === "ArrowLeft") {
    const dir = code === "ArrowRight" ? 1 : -1;
    if (shift) proj.bank = (proj.bank + dir + FX_BANKS.length) % FX_BANKS.length;
    else proj.kit = (proj.kit + dir + KITS.length) % KITS.length;
    scheduleSave();
  }
  // 조각 모드에서는 ↑↓가 옥타브 대신 구간 이동 (Shift = 1박, 아니면 1마디)
  else if ((code === "ArrowUp" || code === "ArrowDown") && chopSlot() >= 0)
    moveRegion(chopSlot(), (code === "ArrowUp" ? 1 : -1) * (shift ? 1 : 4));
  else if (code === "ArrowUp") { proj.octave = Math.min(OCT_MAX, proj.octave + 1); scheduleSave(); }
  else if (code === "ArrowDown") { proj.octave = Math.max(OCT_MIN, proj.octave - 1); scheduleSave(); }
  else if (code === "Backquote") shift ? toggleHelp() : toggleViz();
  else if (code === "Minus") holdBpm(code, shift ? -5 : -1);
  else if (code === "Equal") holdBpm(code, shift ? 5 : 1);
  else if (code === "Tab") metronome = !metronome;
  else if (code === "Backspace") shift ? clearAll() : deleteLast();
  else if (code === "Enter" && shift) toggleEdit();
  else if (!ready) return;
  else if (d >= 0) hitPad(d, shift);
  else if (code in NOTE_KEYS) noteDown(code);
  else if (user >= 0) userPad(user);
  else if (code === "KeyQ") shift ? randomTone() : randomTrack();
  else if (code === "KeyR") shift ? randomAll() : randomDrums();
  else if (code === "Space") playing ? stopPlay() : startPlay();
  else if (code === "Enter") { if (evoPlay) stopPlay(); if (!playing) { startPlay(); recording = true; } else recording = !recording; }
  else if (code === "Escape") { stopAll(); stopPlay(); preview.v = null; if (mic.mode) micStop(); }
}

// 드럼 또는 (Shift) 효과음을 치고, 녹음 중이면 기록
function hitPad(d, shift) {
  const now = ctx.currentTime;
  if (shift) { out = fxBus; FX_BANKS[proj.bank][d](now); record({ kind: "fx", bank: proj.bank, idx: d }); }
  else { hitDrum(proj.kit, d, now); record({ kind: "drum", kit: proj.kit, idx: d }); focus = "drums"; }
}

// 지금 악기가 조각 모드 내 소리면 그 칸 번호, 아니면 -1
const chopSlot = () => (proj.track[0] === "u" && isChop(+proj.track.slice(1)) ? +proj.track.slice(1) : -1);

// 건반 키. 조각 모드에서는 A~P = 조각 1~16, ; = 구간 전체, ' = 구간 루프, ] = 원곡 미리 듣기
// 돌려주는 값: 기록할 midi (기록할 것이 없으면 null)
function noteDown(code) {
  const id = proj.track, cs = chopSlot();
  if (cs >= 0 && code === "Quote") { toggleRegionLoop(cs); return null; }
  if (cs >= 0 && code === "BracketRight") { togglePreview(cs); return null; }
  const midi = cs >= 0 ? 60 + NOTE_KEYS[code] : trackBase(id) + proj.octave * 12 + NOTE_KEYS[code];
  const v = startNote(id, midi, ctx.currentTime);
  if (v) held.set(code, v);
  focus = id;
  lastPitch[id] = midi;   // 마우스·터치로 칸을 칠할 때 이 음을 쓴다
  const ev = record({ kind: "note", track: id, midi, len: 1 });
  if (ev) recNotes.set(code, ev);
  return midi;
}

// 내 소리 키(I [ \): 탭하면 원래 높이로 한 번 울리고, 지금 악기가 된다 (A·Q줄로 음높이 연주)
function userPad(n) {
  proj.track = "u" + n;
  focus = proj.track;
  if (!SAMPLES[n]) { toast(t("userEmpty")(trackShort(proj.track))); return; }
  startSample(n, 60, ctx.currentTime);
  // 녹음할 때 길이: 조각 모드는 1박(4칸), 짧은 소리는 소리 길이만큼 (루프 길이를 넘지 않게)
  const len = isChop(n) ? 4 : Math.round(SAMPLES[n].duration / stepDur());
  record({ kind: "note", track: proj.track, midi: 60, len: Math.max(1, Math.min(totalSteps(), len)) });
}

function onKeyUp(e) {
  // 맥은 ⌘를 누르고 있는 동안 다른 키를 떼도 keyup을 보내지 않는다 → ⌘를 뗄 때 눌림 표시를 정리
  if (e.code === "MetaLeft" || e.code === "MetaRight") {
    for (const c of [...pressed]) if (!held.has(c) && !/Shift|Alt|Control/.test(c)) pressed.delete(c);
    render();
    return;
  }
  if (e.metaKey) return;
  e.preventDefault();
  pressed.delete(e.code);
  if (e.code === hold.code) stopHold();
  // 녹음 중이던 건반이면 누른 길이를 16분음표 단위로 기록
  const ev = recNotes.get(e.code);
  if (ev) {
    recNotes.delete(e.code);
    ev.len = Math.max(1, Math.min(totalSteps(), Math.round((ctx.currentTime - latency() - ev.recAt) / stepDur())));
    renderGrid();
  }
  const v = held.get(e.code);
  if (v) { held.delete(e.code); stopVoice(v, ctx.currentTime); }
  render();
}

// 다른 앱으로 넘어가면 keyup이 안 올 수 있어서, 눌린 상태를 정리한다
window.addEventListener("blur", () => {
  pressed.clear(); stopHold();
  if (ctx) for (const v of held.values()) stopVoice(v, ctx.currentTime);
  held.clear(); recNotes.clear();
  render();
});
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);

// ---------- BPM: 꾹 누르면 계속 바뀌고, 오래 누를수록 빨라진다 ----------
const hold = { code: null, timer: null, n: 0 };
function holdBpm(code, step) {
  stopHold();
  setBpm(proj.bpm + step);
  hold.code = code; hold.n = 0;
  const tick = () => {
    hold.n++;
    setBpm(proj.bpm + step * (hold.n > 20 ? 5 : hold.n > 8 ? 2 : 1));
    render();
    hold.timer = setTimeout(tick, 60);
  };
  hold.timer = setTimeout(tick, 350);
}
function stopHold() { clearTimeout(hold.timer); hold.code = null; }

// ================= 편집 모드 (Shift+Enter) =================
// 화살표로 격자 칸을 옮겨 다니고, Space로 켜고 끄고, 건반·드럼 키로 그 칸에 직접 찍는다
function toggleEdit() {
  edit.on = !edit.on;
  if (edit.on) {
    const rows = gridRows();
    const r = rows.findIndex(x => (focus === "drums" ? x.drum === 0 : x.track === focus));
    edit.row = Math.max(0, r);
    edit.step = Math.max(0, gridPage()) * 16;
  }
  toast(edit.on ? t("editOn") : t("editOff"), edit.on ? 4000 : 1500);
  renderGrid();
}

function editKey(code, shift, ready) {
  const rows = gridRows(), n = totalSteps();
  const row = rows[Math.min(edit.row, rows.length - 1)];
  if (code === "ArrowLeft") edit.step = (edit.step - 1 + n) % n;
  else if (code === "ArrowRight") edit.step = (edit.step + 1) % n;
  else if (code === "ArrowUp") edit.row = Math.max(0, edit.row - 1);
  else if (code === "ArrowDown") edit.row = Math.min(rows.length - 1, edit.row + 1);
  else if (code === "Escape") toggleEdit();
  else if (code === "Space") toggleCell(row, edit.step);
  else if (code === "Backspace" && !shift) change(() => { proj.events = proj.events.filter(ev => !inCell(ev, row, edit.step)); });
  else if (!ready) return false;
  else if (DRUM_KEYS.includes(code)) {
    const d = DRUM_KEYS.indexOf(code);
    hitPad(d, shift);
    const ev = shift ? { kind: "fx", bank: proj.bank, idx: d } : { kind: "drum", kit: proj.kit, idx: d };
    change(() => { proj.events.push({ ...ev, step: edit.step }); });
    edit.step = (edit.step + 1) % n;
  }
  else if (code in NOTE_KEYS) {
    const midi = noteDown(code), id = proj.track;
    if (midi === null) return true;   // 조각 모드의 루프·미리 듣기 키는 칸에 찍지 않는다
    change(() => {
      proj.events = proj.events.filter(ev => !(ev.track === id && ev.step === edit.step));
      proj.events.push({ kind: "note", track: id, midi, len: chopSlot() >= 0 ? 4 : 1, step: edit.step });
    });
    edit.row = gridRows().findIndex(x => x.track === id);
    edit.step = (edit.step + 1) % n;
  }
  else return false;
  renderGrid();
  return true;
}

const inCell = (ev, row, step) => ev.step === step &&
  (row.drum !== undefined ? (ev.kind === "drum" || ev.kind === "fx") && ev.idx === row.drum : ev.track === row.track);

function toggleCell(row, step) {
  if (proj.events.some(ev => inCell(ev, row, step))) {
    change(() => { proj.events = proj.events.filter(ev => !inCell(ev, row, step)); });
  } else if (row.drum !== undefined) {
    change(() => proj.events.push({ kind: "drum", kit: proj.kit, idx: row.drum, step }));
  } else if (row.track[0] === "u" && isChop(+row.track.slice(1))) {
    // 조각 모드: 그 박에 해당하는 원곡 조각을 1박 길이로
    change(() => proj.events.push({ kind: "note", track: row.track, midi: 60 + Math.floor(step / 4) % CHOP_SLICES, len: 4, step }));
  } else {
    const midi = at(trackBase(row.track), chordAt(step).root % 12);
    change(() => proj.events.push({ kind: "note", track: row.track, midi, len: 1, step }));
  }
}

// ================= 격자 =================
// 위 10줄 = 드럼 자리(Z줄 순서). 그 아래 = 음이 들어 있는 악기 트랙 + 지금 고른 악기
function gridRows() {
  const rows = [...Array(10).keys()].map(i => ({ drum: i }));
  const ids = new Set(proj.events.filter(e => e.kind === "note").map(e => e.track));
  ids.add(proj.track);   // 지금 고른 악기 줄은 비어 있어도 보여 준다 (마우스·터치로 칠할 수 있게)
  const order = id => (id[0] === "i" ? 0 : id[0] === "r" ? 100 : 200) + +id.slice(1);
  [...ids].sort((a, b) => order(a) - order(b)).forEach(id => rows.push({ track: id }));
  return rows;
}
// 화면에 보이는 마디: 편집 중이면 커서가 있는 마디, 재생 중이면 재생 위치의 마디
function gridPage() {
  if (edit.on) return Math.floor(edit.step / 16);
  if (pinnedPage !== null && pinnedPage < loopData().bars) return pinnedPage;
  if (playStep >= 0) return Math.floor(playStep / 16);
  return 0;
}
// "마디 n/m" 글자를 탭하면 보는 마디를 넘기고 고정한다. 마지막 마디 다음은 다시 '재생 위치 따라가기'
let pinnedPage = null;
$("barInfo").addEventListener("click", () => {
  const bars = loopData().bars;
  pinnedPage = pinnedPage === null ? (bars > 1 ? (gridPage() + 1) % bars : null) : pinnedPage + 1 < bars ? pinnedPage + 1 : null;
  renderGrid();
});

let gridCells = [], gridRowCount = -1;
function renderGrid() {
  const L = loopData(), rows = gridRows(), page = gridPage(), base = page * 16;
  const grid = $("grid");
  if (rows.length !== gridRowCount) {
    grid.innerHTML = "";
    gridCells = rows.map(() => {
      const label = document.createElement("div");
      label.className = "rl";
      grid.appendChild(label);
      return [label, ...ALL.map(c => { const el = document.createElement("div"); el.dataset.c = c; grid.appendChild(el); return el; })];
    });
    gridRowCount = rows.length;
  }
  // 각 칸에 무엇이 있는지 표를 만든다
  const m = rows.map(() => new Array(16).fill(""));
  const rowOf = new Map(rows.map((r, i) => [r.drum !== undefined ? "d" + r.drum : r.track, i]));
  for (const ev of L.events) {
    if (ev.kind === "note") {
      const r = rowOf.get(ev.track);
      if (r === undefined) continue;
      for (let i = ev.len - 1; i >= 0; i--) {
        const s = ev.step + i - base;
        if (s >= 0 && s < 16) m[r][s] = "n " + trackGroup(ev.track) + (i ? " tail" : "");
      }
    } else {
      const r = rowOf.get("d" + ev.idx), s = ev.step - base;
      if (r !== undefined && s >= 0 && s < 16 && m[r][s] !== "fx") m[r][s] = ev.kind === "fx" ? "fx" : "hit";
    }
  }
  rows.forEach((row, r) => {
    const [label, ...cells] = gridCells[r];
    const isTrack = row.track !== undefined;
    label.className = "rl" + (isTrack ? " tr " + trackGroup(row.track) : "") + (r === 10 ? " first" : "");
    label.textContent = isTrack ? trackShort(row.track).replace("\n", "") : "";
    cells.forEach((el, c) => {
      let cls = "c" + (isTrack ? " tr" : "");
      if (c % 4 === 0) cls += " down";
      if (c % 4 === 3 && c < 15) cls += " gap";
      if (r === 10) cls += " first";
      if (base + c === playStep) cls += " ph";
      if (m[r][c]) cls += " " + m[r][c];
      if (edit.on && r === edit.row && base + c === edit.step) cls += " cur";
      el.className = cls;
    });
  });
  gridCells.forEach((cells, r) => cells.forEach(el => { el.dataset.r = r; }));
  $("barInfo").textContent = `${t("bar")} ${page + 1}/${L.bars}${pinnedPage !== null ? " 📌" : ""}`;
}

// ================= 마우스·터치로 격자 편집 =================
// 칸을 누르면 넣거나 빼고, 누른 채로 끌면 지나가는 칸마다 같은 동작(넣기 또는 빼기)을 이어서 한다.
// 한 번 끈 동작 전체가 되돌리기 한 번으로 돌아간다.
const lastPitch = {};   // 트랙 → 마지막으로 키보드로 친 음
const drag = { on: false, mode: null, done: new Set() };

function cellFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !el.classList.contains("c") || el.dataset.r === undefined) return null;
  const row = gridRows()[+el.dataset.r];
  return row ? { row, step: gridPage() * 16 + +el.dataset.c, r: +el.dataset.r } : null;
}

function paintCell(cell) {
  const key = cell.r + ":" + cell.step;
  if (drag.done.has(key)) return;
  drag.done.add(key);
  const { row, step } = cell, has = proj.events.some(ev => inCell(ev, row, step));
  edit.row = cell.r; edit.step = step;          // 키보드 편집 커서도 같은 칸으로
  if (drag.mode === "erase") {
    if (has) proj.events = proj.events.filter(ev => !inCell(ev, row, step));
    return;
  }
  if (has) return;
  const ready = ctx && ctx.state === "running", now = ready ? ctx.currentTime : 0;
  if (row.drum !== undefined) {
    proj.events.push({ kind: "drum", kit: proj.kit, idx: row.drum, step });
    if (ready) hitDrum(proj.kit, row.drum, now);
  } else {
    const id = row.track, chop = id[0] === "u" && isChop(+id.slice(1));
    const midi = chop ? 60 + Math.floor(step / 4) % CHOP_SLICES
               : lastPitch[id] !== undefined ? lastPitch[id] : at(trackBase(id), chordAt(step).root % 12);
    proj.events.push({ kind: "note", track: id, midi, len: chop ? 4 : 1, step });
    if (ready) stopVoice(startNote(id, midi, now), now + stepDur());
  }
}

$("grid").addEventListener("pointerdown", e => {
  if (evoPlay) return;   // 진화 재생 중에는 지난 사진을 보여 주는 중이라 고치지 않는다
  const cell = cellFromPoint(e.clientX, e.clientY);
  if (!cell) return;
  e.preventDefault();
  undoStack.push(snap());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  drag.on = true;
  drag.done.clear();
  drag.mode = proj.events.some(ev => inCell(ev, cell.row, cell.step)) ? "erase" : "add";
  paintCell(cell);
  renderGrid();
});
window.addEventListener("pointermove", e => {
  if (!drag.on) return;
  const cell = cellFromPoint(e.clientX, e.clientY);
  if (cell) { paintCell(cell); renderGrid(); }
});
const endDrag = () => { if (drag.on) { drag.on = false; changed(); } };
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

// 화면의 재생 위치: 예약해 둔 스텝이 실제로 들릴 때 옮긴다
function tickPlayhead() {
  if (playing && ctx) {
    let moved = false;
    while (stepQueue.length && stepQueue[0].time + (ctx.outputLatency || 0) <= ctx.currentTime) {
      playStep = stepQueue.shift().step;
      moved = true;
    }
    if (moved) renderGrid();
  }
}

// ================= 키보드 안내도 =================
const ROWS = [
  [["Backquote","`"],["Digit1","1"],["Digit2","2"],["Digit3","3"],["Digit4","4"],["Digit5","5"],
   ["Digit6","6"],["Digit7","7"],["Digit8","8"],["Digit9","9"],["Digit0","0"],["Minus","-"],["Equal","="]],
  [["KeyQ","Q"],["KeyW","W"],["KeyE","E"],["KeyR","R"],["KeyT","T"],["KeyY","Y"],["KeyU","U"],
   ["KeyI","I"],["KeyO","O"],["KeyP","P"],["BracketLeft","["],["BracketRight","]"],["Backslash","\\"]],
  [["KeyA","A"],["KeyS","S"],["KeyD","D"],["KeyF","F"],["KeyG","G"],["KeyH","H"],["KeyJ","J"],
   ["KeyK","K"],["KeyL","L"],["Semicolon",";"],["Quote","'"]],
  [["KeyZ","Z"],["KeyX","X"],["KeyC","C"],["KeyV","V"],["KeyB","B"],["KeyN","N"],["KeyM","M"],
   ["Comma",","],["Period","."],["Slash","/"]],
];
const keyEls = {};
ROWS.forEach((row, ri) => {
  const r = document.createElement("div");
  r.className = "kr r" + ri;
  for (const [code, ch] of row) {
    const k = document.createElement("div");
    k.innerHTML = "<b></b><span></span>";
    k.firstChild.textContent = ch;
    r.appendChild(k);
    keyEls[code] = k;
  }
  $("kb").appendChild(r);
});

// 키 하나의 [글자, 역할 클래스]
function keyLook(code, sh) {
  const d = DRUM_KEYS.indexOf(code), inst = INST_KEYS.indexOf(code), user = USER_KEYS.indexOf(code);
  if (sh) return d >= 0 ? [t("fx")[proj.bank][d], "fx"] : ["", ""];   // Shift: 효과음만 보여 준다
  if (d >= 0) return [(t("kitDrums")[proj.kit] || {})[d] || t("drums")[d], "drum"];
  if (code in NOTE_KEYS && chopSlot() >= 0) {
    const i = NOTE_KEYS[code], cs = chopSlot();
    if (i < CHOP_SLICES) return [String(i + 1), "chop"];
    if (code === "Semicolon") return [t("chopWhole"), "chop all"];
    if (code === "Quote") return [t("chopLoop"), "func" + (proj.events.some(e => e.track === "u" + cs && e.midi === CHOP_WHOLE) ? " sel" : "")];
    return [t("chopListen"), "func" + (preview.v ? " sel" : "")];
  }
  if (code in NOTE_KEYS) {
    const n = NOTE_KEYS[code] % 12, name = t("notes")[n];
    return [name, name.includes("#") ? "black" : "white"];
  }
  if (inst >= 0) return [t("instShort")[inst], "inst" + (inst <= 3 ? " bass" : "") + (proj.track === "i" + inst ? " sel" : "")];
  if (user >= 0) return ["U" + (user + 1), "usr" + (SAMPLES[user] ? " has" : "") + (proj.track === "u" + user ? " sel" : "")
                         + (mic.mode === "sample" && mic.slot === user ? " recing" : "")];
  if (code === "Backquote") return [t("keyViz"), "func" + (vizOn ? " sel" : "")];
  if (code === "KeyQ") return [t("keyRandom"), "func" + (proj.track[0] === "r" ? " sel" : "")];
  if (code === "KeyR") return [t("keyDrumRandom"), "func"];
  if (code === "Minus") return [t("bpmDown"), "func"];
  if (code === "Equal") return [t("bpmUp"), "func"];
  return ["", ""];
}

// ================= 화면 갱신 =================
function render() {
  const sh = shiftHeld();
  for (const code in keyEls) {
    const [label, role] = keyLook(code, sh);
    const k = keyEls[code];
    k.className = "k" + (role ? " " + role : "") + (pressed.has(code) ? " on" : "");
    k.lastChild.textContent = label;
  }

  const id = proj.track, grp = trackGroup(id);
  const num = id[0] === "i" ? String((+id.slice(1) + 1) % 10) : id[0] === "r" ? "R" : "U" + (+id.slice(1) + 1);
  for (const [n, nm] of [["instNum", "instName"], ["vNum", "vName"]]) {
    $(n).textContent = num;
    $(n).className = "num " + grp;
    $(nm).textContent = id[0] === "u" ? trackName(id) : id[0] === "r" ? t("randomTone") + " " + id.slice(1) : trackName(id);
  }
  const sign = proj.octave > 0 ? "+" : "";
  const note = "C" + (Math.floor((trackBase(id) + proj.octave * 12) / 12) - 1);
  $("kit").textContent = `${t("kits")[proj.kit]} ${proj.kit + 1}/${KITS.length}`;
  $("oct").textContent = `${sign}${proj.octave} · ${note}`;
  const cs = chopSlot();
  if (cs >= 0) {
    // 조각 모드: 원곡 BPM · 구간이 몇 마디째인지 · 속도 맞추기
    const m = SAMPLE_META[cs];
    $("oct").textContent = `${t("bar")} ${Math.floor(m.start / (240 / m.bpm)) + 1}`;
    $("keyInfo").textContent = `${t("song")} ${m.bpm} · ${m.match ? t("matchOn") : t("matchOff")}`;
  } else {
    $("keyInfo").textContent = `${keyText()} · ${t("density")}${proj.density}`;
  }
  $("vKit").textContent = t("kits")[proj.kit];
  $("vOct").textContent = `${sign}${proj.octave} · ${note}`;
  $("slotInfo").textContent = `${t("slot")} ${slot}`;
  $("vClose").textContent = t("vizClose");
  $("load").textContent = t("load");
  $("lang").textContent = lang === "ko" ? "EN" : "한";
  $("kbLabelK").textContent = t("kit");
  $("kbLabelO").textContent = chopSlot() >= 0 ? t("region") : t("octave");

  const on = !!ctx && ctx.state === "running";
  $("dot").classList.toggle("on", on);
  $("stateTxt").textContent = on ? t("on") : t("off");   // 자리가 좁아서 점 + 켜짐/꺼짐만
  $("startWrap").style.display = on ? "none" : "flex";
  $("seq").style.display = on ? "flex" : "none";
  $("startMain").textContent = t("start");
  $("startSub").textContent = ctx ? t("startAgain") : t("startSub");
  $("optEvo").className = "opt" + (evoEnabled ? " on" : "");
  $("optSession").className = "opt" + (sessionWanted ? " on" : "");
  $("optEvo").innerHTML = `<b>${t("optEvo")} · ${evoEnabled ? t("on") : t("off")}</b><span>${t("optEvoSub")}</span>`;
  $("optSession").innerHTML = `<b>${t("optSession")} · ${sessionWanted ? t("on") : t("off")}</b><span>${t("optSessionSub")}</span>`;
  $("optKb").innerHTML = `<b>${t("optKb")} · ${t(kbProfile === "mac" ? "kbMac" : "kbK380")}</b><span>${t(kbProfile === "mac" ? "kbMacSub" : "kbK380Sub")}</span>`;
  for (const id of ["optSession", "optEvo", "optKb"]) $(id).style.display = ctx ? "none" : "";

  $("bpm").textContent = proj.bpm;
  $("chipPlay").textContent = playing ? t("play") : t("stop");
  $("chipPlay").classList.toggle("on", playing);
  $("chipRec").textContent = t("rec");
  $("chipRec").classList.toggle("on", recording);
  $("chipMet").textContent = t("met");
  $("chipMet").classList.toggle("on", metronome);
  const mode = evoPlay ? `${t("evo")} ${evoPlay.i + 1}/${proj.evo.length}` : edit.on ? t("edit")
             : beatbox.state ? "BEATBOX" : mic.mode === "sample" ? "MIC" : "";
  $("chipMode").textContent = mode;
  $("chipMode").style.display = mode ? "" : "none";
  $("shiftChip").textContent = `${t("shiftFx")} ${proj.bank + 1}/${FX_BANKS.length} ${t("banks")[proj.bank]}`;
  $("shiftChip").classList.toggle("on", sh);
}

// ---------- 알림 한 줄 ----------
let toastTimer = null;
function toast(msg, ms = 1800) {
  $("msg").textContent = msg;
  $("msg").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("msg").classList.remove("show"), ms);
}

// ---------- 도움말 / 내보내기 창 ----------
let helpOpen = false;
function toggleHelp() { helpOpen = !helpOpen; renderOverlay(); }
// 키 안내 내용: 폰에서는 Shift+` 창, 데스크톱에서는 오른쪽 패널에 항상
function helpHTML() {
  return `<h2>${t("helpTitle")}</h2>` +
    `<button class="kbsel">⌨ ${t(kbProfile === "mac" ? "kbMac" : "kbK380")} ⇄</button>` +
    (kbProfile === "mac" ? `<p class="note">${t("macNote")}</p>` : "") + `<div class="hl">` +
    t("help").map(([k, v]) => (v ? `<div><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>` : `<h3>${esc(k)}</h3>`)).join("") +
    `</div>`;
}
function renderOverlay() {
  $("side").innerHTML = helpHTML();
  const o = $("overlay");
  if (helpOpen) {
    o.style.display = "flex";
    o.innerHTML = `<div class="panel help">${helpHTML()}<p class="dim">${t("helpClose")}</p></div>`;
  } else if (exportUI.open) {
    o.style.display = "flex";
    const whats = [t("exLoop"), t("exEvo"), t("exSession")];
    const fmts = EX_WHAT[exportUI.what] === "session" ? [t("exSessionFmt")] : ["WAV", "MP3"];
    o.innerHTML = `<div class="panel"><h2>${t("exTitle")}</h2>
      <small>${t("exWhat")}</small><div class="choices col">${whats.map((w, i) => `<span class="${i === exportUI.what ? "sel" : ""}">${w}</span>`).join("")}</div>
      <small>${t("exFormat")}</small><div class="choices">${fmts.map((f, i) => `<span class="${fmts.length === 1 || i === exportUI.fmt ? "sel" : ""}">${f}</span>`).join("")}</div>
      <p class="msgline">${exportUI.file ? t("exReady") + "<br>" + esc(exportUI.file.name) : esc(exportUI.msg || "")}</p>
      <p class="dim">${t("exHelp")}</p></div>`;
  } else {
    o.style.display = "none";
  }
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---------- 시작 화면 ----------
let sessionWanted = false;
try { evoEnabled = localStorage.getItem("cmk-evo") !== "0"; sessionWanted = localStorage.getItem("cmk-session") === "1"; } catch (e) {}
$("optEvo").addEventListener("click", () => { evoEnabled = !evoEnabled; try { localStorage.setItem("cmk-evo", evoEnabled ? "1" : "0"); } catch (e) {} render(); });
$("optKb").addEventListener("click", () => { $("optKb").blur(); toggleKb(); });
// 도움말 창 안의 키보드 바꾸기 버튼 (창은 다시 그려지므로 overlay에서 받는다)
$("overlay").addEventListener("click", e => { if (e.target.closest(".kbsel")) { e.target.blur(); toggleKb(); } });
$("side").addEventListener("click", e => { if (e.target.closest(".kbsel")) { e.target.blur(); toggleKb(); } });
$("optSession").addEventListener("click", () => { sessionWanted = !sessionWanted; try { localStorage.setItem("cmk-session", sessionWanted ? "1" : "0"); } catch (e) {} render(); });

$("start").addEventListener("click", async () => {
  if (navigator.audioSession) {
    try { navigator.audioSession.type = "playback"; } catch (e) {}
  }
  if (!ctx) {
    initAudio(new (window.AudioContext || window.webkitAudioContext)());
    ctx.addEventListener("statechange", render);
    if (sessionWanted) startSession();
  }
  await ctx.resume();
  $("start").blur();
  render();
  renderGrid();
});

// 불러오기: '불러오기' 글자(label)를 탭하면 파일 선택 창이 열리고, 고르면 여기로 온다
$("file").addEventListener("change", async () => {
  const f = $("file").files[0];
  $("file").value = "";   // 같은 파일을 다시 골라도 change가 오게
  $("file").blur();       // 포커스가 남으면 Space·Enter가 파일 창을 다시 연다
  await importFile(f);    // 소리를 켜기 전이어도 불러오기는 된다
});

$("lang").addEventListener("click", () => {
  lang = lang === "ko" ? "en" : "ko";
  try { localStorage.setItem("cmk-lang", lang); } catch (e) {}
  $("lang").blur();
  render(); renderGrid(); renderOverlay();
});

// 다른 앱에 갔다가 돌아왔을 때 오디오가 멈춰 있으면 다시 켠다
// 화면을 떠날 때는 1초를 기다리지 않고 바로 저장한다
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveNow();
  else if (ctx && ctx.state !== "running") ctx.resume().then(render);
});
window.addEventListener("pagehide", saveNow);

// ================= 시각화 =================
// 큰 화면(`)과 LCD 안 작은 창이 같은 그리기 함수를 쓴다
let vizData = null, energy = 0;
const bigCanvas = $("vizCanvas"), miniCanvas = $("mini");

function toggleViz() {
  vizOn = !vizOn;
  $("viz").style.display = vizOn ? "block" : "none";
  if (vizOn) sizeCanvas(bigCanvas);
}
$("viz").addEventListener("click", () => { toggleViz(); render(); });  // 키보드가 끊겼을 때를 대비해 탭해도 꺼진다

function sizeCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), r = c.getBoundingClientRect();
  c.width = r.width * dpr;
  c.height = r.height * dpr;
}

// 지금 나는 소리의 파형을 잔상이 남는 선으로 그린다. 소리가 클수록 굵고 밝아진다
function drawWave(c, now, scale) {
  const g = c.getContext("2d"), w = c.width, h = c.height;
  g.fillStyle = "rgba(0, 0, 0, 0.12)";  // 완전히 지우지 않고 살짝 덮어서 잔상을 남긴다
  g.fillRect(0, 0, w, h);
  const hue = (now / 40 + energy * 600) % 360;
  g.lineWidth = (2 + Math.min(10, energy * 15)) * scale;
  g.lineJoin = "round";
  const N = 512;  // 앞쪽 512개(약 10ms)만 그려야 물결이 너무 빽빽하지 않다
  for (const [flip, hueShift] of [[1, 0], [-1, 180]]) {
    g.strokeStyle = `hsl(${(hue + hueShift) % 360}, 100%, ${Math.min(85, 55 + energy * 120)}%)`;
    g.beginPath();
    for (let i = 0; i < N; i += 2) {
      const x = (i / (N - 2)) * w, y = h / 2 + flip * vizData[i] * h * 0.45;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
}

// 매 화면 갱신마다: 재생 위치 옮기기 + 시각화 그리기
function frame(now) {
  requestAnimationFrame(frame);
  tickPlayhead();
  if (!analyser) return;
  if (!vizData) vizData = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(vizData);
  let sum = 0;
  for (const x of vizData) sum += x * x;
  energy = Math.max(Math.sqrt(sum / vizData.length), energy * 0.92);  // 갑자기 커지고 천천히 줄어들게
  if (vizOn) drawWave(bigCanvas, now, bigCanvas.width / window.innerWidth);
  else drawWave(miniCanvas, now, 0.6);
}

// ================= 처음 열 때 =================
// 창 크기가 바뀌면(폰 ↔ 데스크톱 배치) 시각화 캔버스 크기를 다시 맞춘다
window.addEventListener("resize", () => { sizeCanvas(miniCanvas); if (vizOn) sizeCanvas(bigCanvas); });

(async () => {
  sizeCanvas(miniCanvas);
  render(); renderGrid(); renderOverlay();
  let n = 1;
  try { n = +localStorage.getItem("cmk-slot") || 1; } catch (e) {}
  await loadSamples().catch(e => console.warn(e));
  await loadSlot(n, true).catch(e => console.warn(e));
  requestAnimationFrame(frame);
})();
