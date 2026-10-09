// ================= 랜덤 =================
// Mutable Instruments Grids에서 착안: 완전 무작위가 아니라 '이 자리에 칠 확률' 표를 두고 굴린다.
// 모든 파트가 같은 조(proj.key)·음계(proj.scale)·코드 진행(proj.prog)을 써서 섞어도 어울린다.
const rand = () => Math.random();
const pick = arr => arr[Math.floor(rand() * arr.length)];
const ALL = [...Array(16).keys()];
const EVEN = ALL.filter(i => i % 2 === 0), ODD = ALL.filter(i => i % 2 === 1);

// 밀도 1~5 → 확률에 곱하는 값 (3이 기본)
const densityFactor = () => [0.45, 0.7, 1, 1.3, 1.6][proj.density - 1];
const chance = p => p >= 1 || rand() < p * densityFactor();

// ---------- 드럼: 장르별 확률 지도 (한 마디 기준). [자리, 스텝들, 확률] ----------
// 자리: 0킥 1스네어 2클랩 3닫힌HH 4열린HH 5로우탐 6하이탐 7림 8퍼커션 9크래시
const STYLES = {
  house:   { bass: [2, 6, 10, 14], drums: [[0, [0, 4, 8, 12], 1], [2, [4, 12], 0.95], [3, ALL, 0.4], [4, [2, 6, 10, 14], 0.9],
            [7, [3, 7, 11, 15], 0.25], [8, ALL, 0.08], [5, [13, 15], 0.15]] },
  techno:  { bass: [2, 6, 10, 14, 3, 11], drums: [[0, [0, 4, 8, 12], 1], [1, [4, 12], 0.5], [2, [4, 12], 0.4], [3, ALL, 0.6],
            [4, [2, 6, 10, 14], 0.8], [5, [2, 3, 6, 7, 10, 11, 14, 15], 0.35], [7, ALL, 0.15], [8, ALL, 0.1]] },
  trap:    { bass: "kick", drums: [[0, [0], 1], [0, [3, 6, 7, 10, 11, 14], 0.3], [1, [8], 1], [2, [8], 0.6], [3, EVEN, 1],
            [3, ODD, 0.35], [4, [14], 0.3], [7, [4, 12], 0.3], [8, ALL, 0.06], [5, [13, 15], 0.2]] },
  hiphop:  { bass: "kick", drums: [[0, [0, 10], 0.95], [0, [3, 7, 13], 0.3], [1, [4, 12], 1], [3, EVEN, 0.9], [4, [14], 0.3],
            [7, ODD, 0.1], [8, ALL, 0.05]] },
  boombap: { bass: [0, 3, 6, 8, 10, 13], drums: [[0, [0, 10], 0.95], [0, [7, 13], 0.35], [1, [4, 12], 1], [3, EVEN, 0.85],
            [3, ODD, 0.15], [8, ALL, 0.3], [9, EVEN, 0.15]] },
  pop:     { bass: [0, 2, 4, 6, 8, 10, 12, 14], drums: [[0, [0, 8], 1], [0, [6, 10], 0.3], [1, [4, 12], 1], [3, EVEN, 0.95],
            [4, [14], 0.3], [8, [4, 12], 0.6], [5, [14, 15], 0.35], [6, [12, 13], 0.35]] },
  chip:    { bass: [0, 2, 4, 6, 8, 10, 12, 14], drums: [[0, [0, 8], 1], [0, [6, 11], 0.3], [1, [4, 12], 1], [3, EVEN, 0.8],
            [7, ALL, 0.1], [8, [15], 0.15], [5, [13, 14, 15], 0.2]] },
};
// 장르별 '전체 랜덤'에 들어갈 악기 묶음
const STYLE_PARTS = {
  house: ["i0", "i5", "i6"], techno: ["i2", "i8"], trap: ["i1", "i6", "i4"], hiphop: ["i1", "i9"],
  boombap: ["i0", "i9", "i8"], pop: ["i0", "i9", "i4"], chip: ["i7", "i0"],
};
const EXTRA_PARTS = ["i4", "i5", "i6", "i8", "i9"];

// 한 마디 패턴을 만들고, 여러 마디면 반복하면서 마지막 마디에 필인(탐·스네어)을 살짝 넣는다
function genDrums(kit) {
  const st = STYLES[KITS[kit].style];
  const bar = [];
  for (const [idx, steps, p] of st.drums)
    for (const step of steps)
      if (chance(p) && !bar.some(e => e.idx === idx && e.step === step)) bar.push({ idx, step });
  const evs = [];
  for (let b = 0; b < proj.bars; b++) {
    const last = proj.bars > 1 && b === proj.bars - 1;
    for (const e of bar) if (!(last && e.step >= 12 && e.idx !== 0 && rand() < 0.5)) evs.push({ ...e, step: e.step + b * 16 });
    if (last) for (let s = 12; s < 16; s++) if (rand() < 0.5) evs.push({ idx: pick([1, 5, 6]), step: s + b * 16 });
    if (b === 0 && proj.bars > 1 && rand() < 0.5) evs.push({ idx: 9, step: 0 });
  }
  return evs.map(e => ({ kind: "drum", kit, idx: e.idx, step: e.step }));
}

// ---------- 화성: 조·음계·코드 진행 ----------
const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], penta: [0, 3, 5, 7, 10] };
const SCALE_ORDER = ["minor", "major", "penta"];
// 코드 진행: 음계 안에서 몇 번째 음을 바닥으로 쓰는지 (0 = 1도)
const PROGS = {
  minor: [[0, 5, 2, 6], [0, 3, 4, 0], [0, 6, 5, 6], [0, 5, 3, 4], [0, 0, 5, 6]],
  major: [[0, 4, 5, 3], [0, 3, 4, 4], [0, 5, 3, 4], [5, 3, 0, 4], [0, 0, 3, 4]],
};
const diatonic = () => (proj.scale === "major" ? SCALES.major : SCALES.minor);
// 1마디 루프면 반 마디마다, 아니면 마디마다 코드가 바뀐다
const chordLen = () => (proj.bars === 1 ? 8 : 16);
function chordAt(step) {
  const deg = proj.prog[Math.floor(step / chordLen()) % proj.prog.length];
  const sc = diatonic();
  const tone = i => sc[(deg + i) % 7] + 12 * Math.floor((deg + i) / 7);
  return { root: tone(0), tones: [tone(0), tone(2), tone(4)], seventh: tone(6) };
}
// 높이 base 근처로 옮긴 midi 번호 (조 반영)
const at = (base, semi) => base + proj.key + semi;
// 멜로디용 음 목록: base부터 2옥타브, 지금 음계 안의 음만
function melodyPool(base) {
  const sc = SCALES[proj.scale], pool = [];
  for (let o = 0; o < 2; o++) for (const s of sc) pool.push(at(base, s + o * 12));
  return pool;
}

// ---------- 악기별 파트 만들기 ----------
// 결과: [{step, midi, len}]  (트랙 id는 부르는 쪽에서 붙인다)
const ROLE = { i0: "bass", i1: "sub", i2: "acid", i3: "reese", i4: "lead", i5: "stab", i6: "arp", i7: "chip", i8: "pad", i9: "comp" };
const roleOf = id => ROLE[id] || (id[0] === "r" ? "lead" : isChop(+id.slice(1)) ? "chop" : "arp");

function kickSteps(bar) {
  const ks = proj.events.filter(e => e.kind === "drum" && e.idx === 0 && Math.floor(e.step / 16) === bar).map(e => e.step % 16);
  return ks.length ? [...new Set(ks)].sort((a, b) => a - b) : [0, 10];
}

const GEN = {
  // 베이스: 장르가 정한 자리(트랩·힙합은 킥 자리)에 코드 근음 위주
  bass(base) {
    const st = STYLES[KITS[proj.kit].style], out = [];
    for (let b = 0; b < proj.bars; b++) {
      const slots = (st.bass === "kick" ? kickSteps(b) : st.bass).filter(() => chance(0.8)).sort((x, y) => x - y);
      slots.forEach((s, i) => {
        const step = s + b * 16, ch = chordAt(step), r = rand();
        const semi = r < 0.6 ? ch.root : r < 0.75 ? ch.tones[2] : r < 0.9 ? ch.root + 12 : ch.tones[1];
        const next = slots[i + 1] !== undefined ? slots[i + 1] : 16;
        const len = st.bass === "kick" ? Math.max(1, Math.min(8, next - s)) : 1 + (rand() < 0.3 ? 1 : 0);
        out.push({ step, midi: at(base, semi % 12 + (semi >= 12 ? 12 : 0)), len });
      });
    }
    return out;
  },
  // 서브: 킥 자리에서 다음 킥까지 길게, 근음만
  sub(base) {
    const out = [];
    for (let b = 0; b < proj.bars; b++) {
      const ks = kickSteps(b);
      ks.forEach((s, i) => {
        if (!chance(0.85)) return;
        const step = s + b * 16, next = ks[i + 1] !== undefined ? ks[i + 1] : 16;
        out.push({ step, midi: at(base, chordAt(step).root % 12), len: Math.max(2, next - s) });
      });
    }
    return out;
  },
  // 애시드: 16분음표로 꿈틀대는 라인. 가끔 한 옥타브 튀고, 가끔 길게
  acid(base) {
    const out = [], sc = SCALES[proj.scale];
    for (let step = 0; step < totalSteps(); step++) {
      if (!chance(step % 4 === 0 ? 0.8 : 0.45)) continue;
      const ch = chordAt(step);
      const semi = rand() < 0.5 ? ch.root % 12 : pick(sc);
      out.push({ step, midi: at(base, semi + (rand() < 0.2 ? 12 : 0)), len: rand() < 0.25 ? 2 : 1 });
    }
    return out;
  },
  // 리스: 코드가 바뀔 때마다 긴 음 하나
  reese(base) {
    const out = [], L = chordLen();
    for (let step = 0; step < totalSteps(); step += L) out.push({ step, midi: at(base, chordAt(step).root % 12), len: L });
    return out;
  },
  // 리드 멜로디: 2마디 동기를 만들고 반복하며 조금씩 바꾼다. 센 박에서는 코드 음으로
  lead(base) {
    const pool = melodyPool(base);
    const motifLen = Math.min(32, totalSteps());
    const motif = [];
    let idx = Math.floor(pool.length / 3) + Math.floor(rand() * 3);
    for (let s = 0; s < motifLen; s++) {
      if (!chance(s % 4 === 0 ? 0.6 : s % 2 === 0 ? 0.4 : 0.15)) continue;
      idx = Math.max(0, Math.min(pool.length - 1, idx + pick([-2, -1, -1, 0, 1, 1, 2])));
      let midi = pool[idx];
      if (s % 4 === 0) {  // 센 박: 가장 가까운 코드 음으로 붙인다
        const tones = chordAt(s).tones.flatMap(x => [at(base, x % 12), at(base, x % 12 + 12)]);
        midi = tones.reduce((a, b) => (Math.abs(b - midi) < Math.abs(a - midi) ? b : a));
      }
      motif.push({ step: s, midi });
    }
    motif.forEach((n, i) => { n.len = Math.max(1, Math.min(4, (motif[i + 1] ? motif[i + 1].step : motifLen) - n.step)); });
    const out = [];
    for (let off = 0; off < totalSteps(); off += motifLen)
      for (const n of motif) {
        const varied = off > 0 && rand() < 0.25;
        out.push({ step: n.step + off, len: n.len, midi: varied ? pick(pool) : n.midi });
      }
    return out;
  },
  // 슈퍼쏘 코드 스탭: 하우스 오프비트 / 트랜스 / 엇박 중 하나의 리듬으로 3화음
  stab(base) {
    const rhythm = pick([[2, 6, 10, 14], [0, 3, 6, 10, 12], [0, 3, 6, 8, 11, 14]]), out = [];
    for (let b = 0; b < proj.bars; b++)
      for (const s of rhythm) {
        if (!chance(0.9)) continue;
        const step = s + b * 16, len = rand() < 0.4 ? 2 : 1;
        for (const x of chordAt(step).tones) out.push({ step, midi: at(base, x % 12), len });
      }
    return out;
  },
  // 플럭 아르페지오: 코드 음을 위·아래·왕복으로 굴린다
  arp(base) {
    const dir = pick(["up", "down", "updown"]), every = proj.density >= 3 ? 1 : 2, out = [];
    let i = 0;
    for (let step = 0; step < totalSteps(); step += every) {
      const ch = chordAt(step);
      const notes = [...ch.tones, ch.tones[0] + 12, ch.tones[1] + 12].map(x => at(base, x % 12 + (x >= 12 ? 12 : 0)));
      const seq = dir === "up" ? notes : dir === "down" ? [...notes].reverse() : [...notes, ...notes.slice(1, -1).reverse()];
      if (chance(0.85)) out.push({ step, midi: seq[i % seq.length], len: every });
      i++;
    }
    return out;
  },
  // 칩튠: 16분음표로 빠르게 도는 코드 아르페지오 (옛날 게임 음악 방식)
  chip(base) {
    const out = [];
    for (let step = 0; step < totalSteps(); step++) {
      const ch = chordAt(step), notes = [ch.tones[0], ch.tones[1], ch.tones[2], ch.tones[0] + 12];
      out.push({ step, midi: at(base, notes[step % 4] % 12 + (notes[step % 4] >= 12 ? 12 : 0)), len: 1 });
    }
    return out;
  },
  // 패드: 코드마다 길게 (가끔 7음 추가)
  pad(base) {
    const out = [], L = chordLen();
    for (let step = 0; step < totalSteps(); step += L) {
      const ch = chordAt(step), notes = [...ch.tones, ...(rand() < 0.4 ? [ch.seventh] : [])];
      for (const x of notes) out.push({ step, midi: at(base, x % 12), len: L });
    }
    return out;
  },
  // 조각 모드(불러온 노래): 원곡 순서대로의 조각을 기본으로, 가끔 다른 조각으로 바꿔 친다 (MPC식 재배치)
  chop(base) {
    const out = [];
    for (let step = 0; step < totalSteps(); step++) {
      if (!chance(step % 4 === 0 ? 0.7 : step % 2 === 0 ? 0.35 : 0.12)) continue;
      const slice = rand() < 0.5 ? Math.floor(step / 4) % CHOP_SLICES : Math.floor(rand() * CHOP_SLICES);
      out.push({ step, midi: base + slice, len: pick([1, 2, 2, 4]) });
    }
    return out;
  },
  // 일렉 피아노 반주: 7화음을 정해진 리듬으로 친다
  comp(base) {
    const rhythm = pick([[0, 6, 12], [0, 3, 8, 11], [2, 6, 10, 14], [0, 10]]), out = [];
    for (let b = 0; b < proj.bars; b++)
      for (const s of rhythm) {
        if (!chance(0.9)) continue;
        const step = s + b * 16, ch = chordAt(step), len = 2 + Math.floor(rand() * 2);
        for (const x of [...ch.tones, ch.seventh]) out.push({ step, midi: at(base, x % 12), len });
      }
    return out;
  },
};

function genTrack(id) {
  const base = trackBase(id);
  return GEN[roleOf(id)](base).map(n => ({ kind: "note", track: id, midi: n.midi, len: n.len, step: n.step % totalSteps() }));
}

// Q: 지금 악기 트랙만 새로 (다른 트랙은 그대로)
function randomTrack() {
  const id = proj.track;
  if (id[0] === "u" && !SAMPLES[+id.slice(1)]) { toast(t("userEmpty")(trackShort(id))); return; }
  change(() => { proj.events = proj.events.filter(e => e.track !== id).concat(genTrack(id)); });
  focus = id;
  toast(t("randomTrack")(trackName(id)));
  if (!playing) startPlay();
}

// R: 드럼만 새로 (지금 킷)
function randomDrums() {
  change(() => { proj.events = proj.events.filter(e => e.kind !== "drum").concat(genDrums(proj.kit)); });
  focus = "drums";
  toast(t("randomDrums"));
  if (!playing) startPlay();
}

// Shift+R: 전부 새로 — 새 코드 진행 + 드럼 + 장르에 맞는 악기 2~4개
function randomAll() {
  change(() => {
    proj.prog = pick(PROGS[proj.scale === "major" ? "major" : "minor"]);
    proj.events = genDrums(proj.kit);  // 베이스·서브가 킥 자리를 보려면 드럼이 먼저 있어야 한다
    const parts = [...STYLE_PARTS[KITS[proj.kit].style]];
    if (rand() < 0.4) parts.push(pick(EXTRA_PARTS.filter(p => !parts.includes(p))));
    for (const id of parts) proj.events.push(...genTrack(id));
  });
  focus = "drums";
  toast(t("randomAll"));
  if (!playing) startPlay();
}

// Shift+Q: 매번 새로운 합성 음색을 만들어 지금 악기로 바꾸고 한 번 들려준다
function randomTone() {
  const rnd = (lo, hi) => lo + rand() * (hi - lo);
  const n = 1 + Math.floor(rand() * 3);
  const oscs = [];
  for (let i = 0; i < n; i++)
    oscs.push([pick(["sawtooth", "square", "triangle", "sine"]), pick([0.5, 1, 1, 1, 2]), rnd(-25, 25), 1, rnd(-0.6, 0.6)]);
  const def = { base: pick([36, 48, 60, 60]), oscs, amp: { a: pick([0.002, 0.01, 0.05, 0.3]), r: rnd(0.05, 0.8) },
                peak: 0.25 / Math.sqrt(n) };
  if (rand() < 0.8) def.filter = { freq: rnd(300, 5000), Q: rnd(0.5, 12) };
  if (def.filter && rand() < 0.6) def.filter.env = [rnd(2000, 9000), rnd(0.05, 0.5)];
  if (def.filter && rand() < 0.3) def.filter.lfo = [rnd(0.2, 6), rnd(100, 800)];
  if (rand() < 0.4) { def.amp.d = rnd(0.1, 1); def.amp.s = rnd(0, 0.6); }
  if (rand() < 0.25) def.vibrato = [rnd(3, 7), rnd(5, 30)];
  if (rand() < 0.25) def.fm = [pick([0.5, 1, 2, 3.5]), rnd(0.5, 4), rnd(0.2, 1.5)];
  if (rand() < 0.3) def.drive = pick([2, 4, 8]);
  if (rand() < 0.2) def.pitchEnv = [rnd(1.5, 4), rnd(0.02, 0.15)];
  if (rand() < 0.6) def.verb = rnd(0.1, 0.5);
  if (rand() < 0.4) def.delay = rnd(0.1, 0.35);
  const id = "r" + (++proj.randomCount);
  proj.randoms[id] = def;
  proj.track = id;
  focus = id;
  scheduleSave();
  const now = ctx.currentTime;
  stopVoice(startVoice(def, def.base + proj.octave * 12, now), now + 0.35);
}

// Alt+←→ 조, Alt+↑↓ 밀도, Alt+Q 음계
function setKey(dir) { proj.key = (proj.key + dir + 12) % 12; scheduleSave(); toast(t("keySet")(keyText())); }
function setDensity(dir) { proj.density = Math.max(1, Math.min(5, proj.density + dir)); scheduleSave(); toast(t("densitySet")(proj.density)); }
function cycleScale() {
  proj.scale = SCALE_ORDER[(SCALE_ORDER.indexOf(proj.scale) + 1) % SCALE_ORDER.length];
  scheduleSave();
  toast(t("keySet")(keyText()));
}
const keyText = () => I18N.en.notes[proj.key] + " " + t("scales")[proj.scale];
