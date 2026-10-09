// ================= 오디오 기본 =================
// 소리 → master(음량) → 컴프레서(리미터처럼 강하게) → 분석기(시각화) → 스피커
// 리버브·딜레이는 '보내기(send)'로 master에 섞는다
let ctx = null, master = null, analyser = null, noiseBuf = null, verbBuf = null;
let verbIn = null, delayIn = null, delayNode = null, wet = null, fxBus = null, kitBuses = [];
let active = new Set();   // 지금 울리는 모든 소리 (Esc용)
let out = null;           // 드럼·효과음 재료가 연결될 곳 (킷마다 다름)

function initAudio(c) {
  ctx = c;
  active = new Set();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 0;
  comp.ratio.value = 20;
  comp.attack.value = 0.002;
  comp.release.value = 0.15;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(comp).connect(analyser).connect(ctx.destination);

  // 화이트 노이즈 2초 (스네어, 하이햇, 클랩, 효과음 재료)
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  verbBuf = impulse(2.5, 3);
  verbIn = ctx.createGain();
  delayIn = ctx.createGain();
  wet = null;
  buildWet();

  // 효과음 버스: 리버브를 조금 섞는다
  fxBus = ctx.createGain();
  fxBus.connect(master);
  fxBus.connect(gainNode(0.35)).connect(verbIn);

  // 킷별 버스: 로파이는 고음 깎기+찌그러짐, 80s는 게이트 리버브
  kitBuses = KITS.map(k => {
    const b = k.bus || {};
    const input = ctx.createGain();
    let node = input;
    if (b.lp) node = node.connect(filterNode("lowpass", b.lp));
    if (b.drive) node = node.connect(shaper(b.drive));
    node.connect(master);
    if (b.gated) {
      const conv = ctx.createConvolver();
      conv.buffer = impulse(0.35, 0.3);
      input.connect(conv).connect(gainNode(0.6)).connect(master);
    }
    return input;
  });
}

// 내보내기(오프라인 렌더링) 때 잠깐 다른 오디오 그래프로 바꿔 끼우려고 묶어서 꺼내고 넣는다
function getGraph() { return { ctx, master, analyser, noiseBuf, verbBuf, verbIn, delayIn, delayNode, wet, fxBus, kitBuses, active }; }
function setGraph(g) { ({ ctx, master, analyser, noiseBuf, verbBuf, verbIn, delayIn, delayNode, wet, fxBus, kitBuses, active } = g); }

function gainNode(v) { const g = ctx.createGain(); g.gain.value = v; return g; }
function filterNode(type, freq, Q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = Q;
  return f;
}

// 리버브용 '공간 울림' 데이터: 노이즈가 점점 작아지는 모양. pow가 클수록 빨리 줄어든다
// 만드는 데 시간이 걸려서, 같은 값이면 한 번 만든 것을 다시 쓴다 (내보내기 때 빨라짐)
const impulses = {};
function impulse(sec, pow) {
  const k = `${sec}/${pow}/${ctx.sampleRate}`;
  if (!impulses[k]) impulses[k] = makeImpulse(sec, pow);
  return impulses[k];
}
function makeImpulse(sec, pow) {
  const len = Math.floor(ctx.sampleRate * sec);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, pow);
  }
  return buf;
}

// 찌그러뜨리기(디스토션). k가 클수록 세게
const curves = {};
function shaper(k) {
  if (!curves[k]) {
    const c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) {
      const x = i / 511.5 - 1;
      c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    curves[k] = c;
  }
  const s = ctx.createWaveShaper();
  s.curve = curves[k];
  return s;
}

// 리버브·딜레이 본체. Esc를 누르면 새로 만들어서 남은 울림까지 끊는다
function buildWet() {
  if (wet) { verbIn.disconnect(); delayIn.disconnect(); wet.forEach(n => n.disconnect()); }
  const conv = ctx.createConvolver();
  conv.buffer = verbBuf;
  const verbOut = gainNode(0.5);
  verbIn.connect(conv).connect(verbOut).connect(master);
  delayNode = ctx.createDelay(2);
  delayNode.delayTime.value = delayTimeForBpm();
  const fb = gainNode(0.35);          // 메아리가 얼마나 반복될지
  const dlf = filterNode("lowpass", 2500);
  delayIn.connect(delayNode);
  delayNode.connect(dlf).connect(fb).connect(delayNode);
  dlf.connect(master);
  wet = [conv, verbOut, delayNode, fb, dlf];
}

// 딜레이 간격 = 점8분음표 (16분음표 3개). BPM이 바뀌면 같이 바뀐다
function delayTimeForBpm() { return Math.min(2, 0.75 * 60 / proj.bpm); }

// 울리는 소리를 기록해 두고, 끝나면 지운다
function track(g, srcs) {
  const v = { g, srcs };
  const set = active;
  set.add(v);
  srcs[0].onended = () => set.delete(v);
  return v;
}

function stopAll() {
  const t = ctx.currentTime;
  for (const v of active) {
    v.g.gain.cancelScheduledValues(t);
    v.g.gain.setValueAtTime(v.g.gain.value, t);
    v.g.gain.linearRampToValueAtTime(0, t + 0.02);  // 0으로 바로 떨어뜨리면 '틱' 소리가 나서 20ms
    v.srcs.forEach(s => { try { s.stop(t + 0.03); } catch (e) {} });
  }
  held.clear();
  buildWet();
}

// ================= 드럼·효과음 재료 =================
// 음량 모양: decay = 바로 크게 → 줄어듦, rise = 작게 → 커지다 끊김, hold = 유지하다 끊김
function env(g, t, vol, dur, shape = "decay") {
  if (shape === "rise") {
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur);
  } else if (shape === "hold") {
    g.gain.setValueAtTime(vol, t);
    g.gain.setValueAtTime(vol, t + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, t + dur);
  } else {
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  }
}

// 1) 음높이가 f0 → f1로 변하는 오실레이터 (킥, 탐, 림, 벨, 라이저 등)
function tone(t, { type = "sine", f0, f1 = f0, drop = 0.05, dur, vol, filter, drive, shape }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + drop);
  env(g, t, vol, dur, shape);
  let node = o;
  if (filter) node = node.connect(filterNode(filter[0], filter[1]));
  if (drive) node = node.connect(shaper(drive));
  node.connect(g).connect(out);
  o.start(t); o.stop(t + dur);
  track(g, [o]);
}

// 2) 필터를 거친 노이즈 (스네어 '촤', 하이햇, 크래시, 스윕)
function noise(t, { type = "highpass", freq, sweepTo, Q = 1, dur, vol, shape }) {
  const s = ctx.createBufferSource(), f = filterNode(type, freq, Q), g = ctx.createGain();
  s.buffer = noiseBuf; s.loop = true;
  if (sweepTo) {
    f.frequency.setValueAtTime(freq, t);  // 시작점을 박아 두지 않으면 변화가 엉뚱한 시각부터 계산된다
    f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  }
  env(g, t, vol, dur, shape);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random());  // 시작 위치를 섞어서 겹쳐도 같은 노이즈가 되지 않게
  s.stop(t + dur);
  track(g, [s]);
}

// 3) 사각파 6개를 겹친 쇳소리 (808 하이햇·심벌 방식)
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
function metal(t, { hp, dur, vol, shape }) {
  const f = filterNode("highpass", hp), g = ctx.createGain();
  env(g, t, vol, dur, shape);
  f.connect(g).connect(out);
  const oscs = METAL.map(fr => {
    const o = ctx.createOscillator();
    o.type = "square"; o.frequency.value = fr;
    o.connect(f); o.start(t); o.stop(t + dur);
    return o;
  });
  track(g, oscs);
}

// 4) 클랩: 노이즈를 짧게 3번 끊어 친 뒤 꼬리를 남긴다
function clap(t, freq, tail, vol) {
  const s = ctx.createBufferSource(), f = filterNode("bandpass", freq, 1.5), g = ctx.createGain();
  s.buffer = noiseBuf; s.loop = true;
  g.gain.setValueAtTime(0, t);
  for (const d of [0, 0.012, 0.024]) {
    g.gain.setValueAtTime(vol, t + d);
    g.gain.exponentialRampToValueAtTime(0.05, t + d + 0.01);
  }
  g.gain.setValueAtTime(vol, t + 0.036);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.036 + tail);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random()); s.stop(t + 0.04 + tail);
  track(g, [s]);
}

// 5) 짧은 음 여러 개를 차례로 (코인, 파워업, 게임오버 같은 게임 소리)
function notesSeq(t, freqs, each, { type = "square", vol = 0.15, last = each } = {}) {
  freqs.forEach((f, i) => {
    const isLast = i === freqs.length - 1;
    tone(t + i * each, { type, f0: f, dur: isLast ? last : each, vol, shape: isLast ? "decay" : "hold" });
  });
}

// ================= 드럼 킷 8개 (자리 순서: 킥 스네어 클랩 닫힌HH 열린HH 로우탐 하이탐 림 퍼커션 크래시) =================
// style = 랜덤 비트를 만들 때 쓰는 장르 규칙 (random.js의 STYLES). 이름은 i18n.js
const KITS = [
  { style: "hiphop", hits: [
    t => tone(t, { f0: 150, f1: 45, drop: 0.08, dur: 0.9, vol: 1 }),
    t => { tone(t, { type: "triangle", f0: 185, dur: 0.15, vol: 0.5 });
           tone(t, { f0: 330, dur: 0.1, vol: 0.3 });
           noise(t, { freq: 1500, dur: 0.18, vol: 0.4 }); },
    t => clap(t, 1000, 0.25, 0.8),
    t => metal(t, { hp: 7000, dur: 0.05, vol: 0.4 }),
    t => metal(t, { hp: 7000, dur: 0.4, vol: 0.35 }),
    t => tone(t, { f0: 110, f1: 80, drop: 0.3, dur: 0.5, vol: 0.8 }),
    t => tone(t, { f0: 200, f1: 150, drop: 0.3, dur: 0.4, vol: 0.7 }),
    t => { tone(t, { type: "triangle", f0: 1700, dur: 0.03, vol: 0.5 });
           tone(t, { f0: 480, dur: 0.03, vol: 0.3 }); },
    t => { tone(t, { type: "square", f0: 540, dur: 0.3, vol: 0.25, filter: ["bandpass", 800] });
           tone(t, { type: "square", f0: 800, dur: 0.3, vol: 0.25, filter: ["bandpass", 800] }); },
    t => { metal(t, { hp: 5000, dur: 1.5, vol: 0.25 });
           noise(t, { freq: 6000, dur: 1.2, vol: 0.2 }); },
  ]},
  { style: "house", hits: [
    t => { tone(t, { f0: 230, f1: 55, drop: 0.04, dur: 0.45, vol: 1 });
           noise(t, { freq: 3000, dur: 0.015, vol: 0.3 }); },  // 909 킥의 '딱' 하는 어택
    t => { tone(t, { type: "triangle", f0: 200, f1: 185, drop: 0.05, dur: 0.12, vol: 0.4 });
           noise(t, { freq: 2500, dur: 0.25, vol: 0.6 }); },
    t => clap(t, 1300, 0.35, 0.8),
    t => noise(t, { freq: 9000, dur: 0.06, vol: 0.5 }),
    t => noise(t, { freq: 8500, dur: 0.45, vol: 0.4 }),
    t => { tone(t, { f0: 140, f1: 95, drop: 0.15, dur: 0.35, vol: 0.8 });
           noise(t, { type: "bandpass", freq: 400, dur: 0.05, vol: 0.2 }); },
    t => { tone(t, { f0: 260, f1: 180, drop: 0.15, dur: 0.3, vol: 0.7 });
           noise(t, { type: "bandpass", freq: 700, dur: 0.05, vol: 0.2 }); },
    t => { noise(t, { type: "bandpass", freq: 2500, Q: 8, dur: 0.025, vol: 2.5 });
           tone(t, { type: "triangle", f0: 1000, dur: 0.02, vol: 0.3 }); },
    t => { tone(t, { type: "square", f0: 587, dur: 0.15, vol: 0.25, filter: ["bandpass", 900] });
           tone(t, { type: "square", f0: 845, dur: 0.15, vol: 0.25, filter: ["bandpass", 900] }); },
    t => { noise(t, { freq: 4000, dur: 1.8, vol: 0.35 });
           metal(t, { hp: 6000, dur: 1.2, vol: 0.15 }); },
  ]},
  // 트랩: 길게 끌리며 내려가는 808 붐 킥, 날카로운 스네어, 롤용 짧은 하이햇
  { style: "trap", hits: [
    t => tone(t, { f0: 160, f1: 42, drop: 0.06, dur: 1.6, vol: 0.9, drive: 3 }),
    t => { tone(t, { type: "triangle", f0: 240, f1: 200, drop: 0.03, dur: 0.1, vol: 0.5 });
           noise(t, { freq: 2000, dur: 0.2, vol: 0.6 }); },
    t => clap(t, 1200, 0.22, 0.9),
    t => noise(t, { freq: 9500, dur: 0.035, vol: 0.5 }),
    t => noise(t, { freq: 8000, dur: 0.32, vol: 0.4 }),
    t => tone(t, { f0: 95, f1: 62, drop: 0.4, dur: 0.7, vol: 0.8, drive: 1.5 }),
    t => tone(t, { f0: 170, f1: 115, drop: 0.3, dur: 0.5, vol: 0.7, drive: 1.5 }),
    t => { noise(t, { type: "bandpass", freq: 2600, Q: 2, dur: 0.07, vol: 2 });
           tone(t, { type: "triangle", f0: 1800, dur: 0.02, vol: 0.2 }); },
    t => { tone(t, { f0: 1318, dur: 0.6, vol: 0.25 });
           tone(t, { f0: 2643, dur: 0.3, vol: 0.1 });
           tone(t, { type: "triangle", f0: 659, dur: 0.5, vol: 0.15 }); },
    t => { metal(t, { hp: 5000, dur: 1.5, vol: 0.2 });
           noise(t, { freq: 5000, dur: 1.4, vol: 0.25 }); },
  ]},
  // 빅룸: 페스티벌 EDM. 크고 찌그러진 킥, 두 겹 클랩, 노이즈 스네어
  { style: "house", hits: [
    t => { tone(t, { f0: 220, f1: 48, drop: 0.07, dur: 0.65, vol: 1, drive: 4 });
           noise(t, { freq: 2500, dur: 0.02, vol: 0.5 }); },
    t => { tone(t, { type: "triangle", f0: 190, f1: 170, drop: 0.05, dur: 0.15, vol: 0.5 });
           noise(t, { freq: 1000, dur: 0.3, vol: 0.7 }); },
    t => { clap(t, 1100, 0.4, 0.8); clap(t, 1800, 0.3, 0.5); },
    t => noise(t, { freq: 9000, dur: 0.05, vol: 0.45 }),
    t => noise(t, { freq: 7000, dur: 0.5, vol: 0.4 }),
    t => { tone(t, { f0: 130, f1: 80, drop: 0.2, dur: 0.45, vol: 0.8, drive: 2 });
           noise(t, { type: "bandpass", freq: 500, dur: 0.05, vol: 0.2 }); },
    t => { tone(t, { f0: 230, f1: 150, drop: 0.2, dur: 0.38, vol: 0.7, drive: 2 });
           noise(t, { type: "bandpass", freq: 900, dur: 0.05, vol: 0.2 }); },
    t => { noise(t, { type: "bandpass", freq: 3000, Q: 6, dur: 0.03, vol: 2.5 });
           tone(t, { type: "triangle", f0: 900, dur: 0.025, vol: 0.3 }); },
    t => { for (const d of [0, 0.02, 0.045]) noise(t + d, { freq: 7000, Q: 2, dur: 0.09, vol: 0.35 }); },
    t => noise(t, { freq: 3000, dur: 2.4, vol: 0.45 }),
  ]},
  // 테크노: 세게 찌그러진 킥, 낮게 우르릉거리는 럼블, 쇳소리 퍼커션
  { style: "techno", hits: [
    t => { tone(t, { f0: 180, f1: 45, drop: 0.05, dur: 0.55, vol: 1, drive: 8 });
           noise(t, { freq: 4000, dur: 0.012, vol: 0.4 }); },
    t => { noise(t, { type: "bandpass", freq: 1800, Q: 0.8, dur: 0.22, vol: 0.9 });
           tone(t, { type: "square", f0: 240, f1: 180, drop: 0.04, dur: 0.08, vol: 0.2, drive: 3 }); },
    t => clap(t, 900, 0.3, 0.9),
    t => metal(t, { hp: 9000, dur: 0.03, vol: 0.45 }),
    t => metal(t, { hp: 8000, dur: 0.25, vol: 0.4 }),
    t => tone(t, { f0: 55, f1: 45, drop: 0.6, dur: 0.9, vol: 0.7, drive: 6, filter: ["lowpass", 180] }),
    t => tone(t, { f0: 300, f1: 200, drop: 0.08, dur: 0.2, vol: 0.6, drive: 3 }),
    t => { metal(t, { hp: 2000, dur: 0.15, vol: 0.35 });
           tone(t, { type: "square", f0: 1200, dur: 0.05, vol: 0.15 }); },
    t => { tone(t, { type: "square", f0: 330, dur: 0.18, vol: 0.18, filter: ["bandpass", 1200] });
           tone(t, { type: "square", f0: 507, dur: 0.18, vol: 0.18, filter: ["bandpass", 1200] }); },
    t => { noise(t, { freq: 4000, dur: 1.5, vol: 0.35 });
           metal(t, { hp: 3000, dur: 1.2, vol: 0.2 }); },
  ]},
  // 80s 신스팝: 모든 소리에 짧게 끊기는 '게이트 리버브', 시몬스 스타일 전자 탐
  { style: "pop", bus: { gated: true }, hits: [
    t => tone(t, { f0: 130, f1: 50, drop: 0.06, dur: 0.4, vol: 0.9 }),
    t => { tone(t, { type: "triangle", f0: 180, f1: 160, drop: 0.05, dur: 0.12, vol: 0.5 });
           noise(t, { freq: 800, dur: 0.2, vol: 0.7 }); },
    t => clap(t, 1100, 0.25, 0.8),
    t => noise(t, { freq: 8000, dur: 0.05, vol: 0.35 }),
    t => noise(t, { freq: 7000, dur: 0.4, vol: 0.3 }),
    t => { tone(t, { f0: 220, f1: 90, drop: 0.3, dur: 0.5, vol: 0.7 });
           noise(t, { type: "lowpass", freq: 1500, dur: 0.06, vol: 0.25 }); },
    t => { tone(t, { f0: 330, f1: 150, drop: 0.3, dur: 0.45, vol: 0.6 });
           noise(t, { type: "lowpass", freq: 2000, dur: 0.06, vol: 0.25 }); },
    t => { tone(t, { type: "triangle", f0: 1500, dur: 0.03, vol: 0.4 });
           noise(t, { type: "bandpass", freq: 3000, Q: 3, dur: 0.03, vol: 0.5 }); },
    t => { for (const d of [0, 0.025]) noise(t + d, { freq: 6500, Q: 2, dur: 0.12, vol: 0.3 }); },
    t => noise(t, { freq: 5000, dur: 1.6, vol: 0.35 }),
  ]},
  // 로파이: 킷 전체의 고음을 깎고 살짝 찌그러뜨려 먹먹하고 따뜻하게
  { style: "boombap", bus: { lp: 3200, drive: 1.5 }, hits: [
    t => tone(t, { f0: 110, f1: 50, drop: 0.07, dur: 0.5, vol: 0.9 }),
    t => { tone(t, { type: "triangle", f0: 190, dur: 0.1, vol: 0.4 });
           noise(t, { type: "bandpass", freq: 1800, Q: 0.7, dur: 0.22, vol: 0.8 }); },
    t => clap(t, 1000, 0.2, 0.7),
    t => noise(t, { freq: 2500, dur: 0.05, vol: 0.6 }),
    t => noise(t, { freq: 2500, dur: 0.3, vol: 0.5 }),
    t => tone(t, { f0: 100, f1: 80, drop: 0.2, dur: 0.4, vol: 0.7 }),
    t => tone(t, { f0: 170, f1: 140, drop: 0.2, dur: 0.35, vol: 0.6 }),
    t => tone(t, { type: "triangle", f0: 1200, dur: 0.03, vol: 0.45 }),
    t => { noise(t, { freq: 5000, dur: 0.04, vol: 0.3, shape: "rise" });
           noise(t + 0.04, { freq: 5000, dur: 0.07, vol: 0.3 }); },
    t => { metal(t, { hp: 4000, dur: 0.9, vol: 0.2 });
           noise(t, { freq: 6000, dur: 0.6, vol: 0.15 }); },
  ]},
  // 칩튠: 옛날 게임기처럼 사각파·삼각파·노이즈만 쓴다
  { style: "chip", hits: [
    t => tone(t, { type: "square", f0: 180, f1: 40, drop: 0.08, dur: 0.15, vol: 1 }),
    t => { noise(t, { freq: 1000, dur: 0.15, vol: 0.5 });
           tone(t, { type: "square", f0: 220, f1: 110, drop: 0.05, dur: 0.08, vol: 0.2 }); },
    t => { for (const d of [0, 0.03, 0.06]) noise(t + d, { type: "bandpass", freq: 1500, dur: 0.03, vol: 0.5 }); },
    t => noise(t, { freq: 7000, dur: 0.03, vol: 0.4 }),
    t => noise(t, { freq: 6000, dur: 0.2, vol: 0.35 }),
    t => tone(t, { type: "triangle", f0: 200, f1: 90, drop: 0.15, dur: 0.2, vol: 0.6 }),
    t => tone(t, { type: "triangle", f0: 350, f1: 170, drop: 0.15, dur: 0.18, vol: 0.6 }),
    t => tone(t, { type: "square", f0: 1760, dur: 0.05, vol: 0.5 }),
    t => notesSeq(t, [988, 1319], 0.08, { vol: 0.18, last: 0.35 }),
    t => noise(t, { type: "lowpass", freq: 3000, sweepTo: 200, dur: 0.7, vol: 0.6 }),
  ]},
];

// ================= 효과음 뱅크 4개 × 10 (Shift + Z줄, Shift+←→로 뱅크) =================
const FX_BANKS = [
  // ① 빌드업·드롭
  [
    t => { noise(t, { type: "bandpass", freq: 300, sweepTo: 9000, Q: 2, dur: 2.5, vol: 0.5, shape: "rise" });
           tone(t, { type: "sawtooth", f0: 150, f1: 1500, drop: 2.5, dur: 2.5, vol: 0.12, shape: "rise" }); },
    t => { noise(t, { type: "bandpass", freq: 9000, sweepTo: 200, Q: 2, dur: 2, vol: 0.5 });
           tone(t, { type: "sawtooth", f0: 1500, f1: 100, drop: 2, dur: 2, vol: 0.12 }); },
    t => { tone(t, { f0: 90, f1: 30, drop: 1, dur: 2, vol: 1, drive: 2 });
           noise(t, { type: "lowpass", freq: 2000, sweepTo: 200, dur: 1.5, vol: 0.6 }); },
    t => tone(t, { f0: 70, f1: 28, drop: 1.5, dur: 2, vol: 1 }),
    t => { noise(t, { freq: 3000, dur: 1.6, vol: 0.5, shape: "rise" });
           metal(t, { hp: 6000, dur: 1.6, vol: 0.15, shape: "rise" }); },
    t => noise(t, { type: "lowpass", freq: 200, sweepTo: 14000, Q: 6, dur: 3, vol: 0.35, shape: "rise" }),
    t => { tone(t, { type: "square", f0: 2500, f1: 80, drop: 0.3, dur: 0.35, vol: 0.25 });
           tone(t, { type: "sawtooth", f0: 3000, f1: 150, drop: 0.25, dur: 0.3, vol: 0.15 }); },
    t => { for (const [s, len] of [[0, 0.12], [0.17, 0.12], [0.34, 0.7]])   // 에어혼: 빰-빰-빠암
             for (const det of [0.99, 1, 1.01])
               tone(t + s, { type: "sawtooth", f0: 470 * det, f1: 440 * det, drop: len, dur: len,
                             vol: 0.12, filter: ["lowpass", 2500], shape: "hold" }); },
    t => { const o = ctx.createOscillator(), lfo = ctx.createOscillator(), g = ctx.createGain();  // 덥 사이렌
           o.type = "square"; o.frequency.value = 700;
           lfo.frequency.value = 4;
           lfo.connect(gainNode(250)).connect(o.frequency);
           env(g, t, 0.15, 2, "hold");
           o.connect(filterNode("lowpass", 2000)).connect(g).connect(out);
           o.start(t); lfo.start(t); o.stop(t + 2); lfo.stop(t + 2);
           track(g, [o, lfo]); },
    t => { out = kitBuses[proj.kit];   // 스네어 롤: 지금 킷의 스네어가 점점 빨라진다
           let tt = t, gap = 0.2;
           for (let i = 0; i < 24; i++) { KITS[proj.kit].hits[1](tt); tt += gap; gap = Math.max(0.03, gap * 0.88); } },
  ],
  // ② 전환
  [
    t => noise(t, { type: "lowpass", freq: 300, sweepTo: 8000, Q: 8, dur: 1, vol: 0.35, shape: "hold" }),
    t => noise(t, { type: "lowpass", freq: 8000, sweepTo: 300, Q: 8, dur: 1, vol: 0.35, shape: "hold" }),
    t => { tone(t, { type: "sawtooth", f0: 220, f1: 30, drop: 0.8, dur: 0.8, vol: 0.2, filter: ["lowpass", 2000], shape: "hold" });
           tone(t, { type: "square", f0: 110, f1: 15, drop: 0.8, dur: 0.8, vol: 0.1, shape: "hold" }); },
    t => { noise(t, { type: "bandpass", freq: 1500, Q: 0.5, dur: 0.25, vol: 0.9 });
           tone(t, { f0: 100, f1: 50, drop: 0.1, dur: 0.3, vol: 0.6 }); },
    t => { noise(t, { type: "bandpass", freq: 500, sweepTo: 5000, Q: 3, dur: 0.35, vol: 0.5, shape: "rise" });
           noise(t + 0.35, { type: "bandpass", freq: 5000, sweepTo: 800, Q: 3, dur: 0.4, vol: 0.5 }); },
    t => { tone(t, { f0: 60, f1: 35, drop: 0.6, dur: 1.4, vol: 1, drive: 3 });
           noise(t, { type: "lowpass", freq: 400, dur: 0.3, vol: 0.5 }); },
    t => { for (let i = 0; i < 8; i++) {
             noise(t + i * 0.06, { type: "bandpass", freq: 1200, dur: 0.04, vol: 0.6 });
             tone(t + i * 0.06, { type: "sawtooth", f0: 220, dur: 0.04, vol: 0.1, filter: ["lowpass", 1500] }); } },
    t => { noise(t, { freq: 2500, dur: 2.2, vol: 0.5, shape: "rise" });
           metal(t, { hp: 5000, dur: 2.2, vol: 0.15, shape: "rise" }); },
    t => noise(t, { type: "lowpass", freq: 12000, dur: 2.5, vol: 0.5 }),
    t => { noise(t, { type: "bandpass", freq: 600, sweepTo: 9000, Q: 3, dur: 1, vol: 0.45, shape: "rise" });
           tone(t, { type: "sawtooth", f0: 300, f1: 1200, drop: 1, dur: 1, vol: 0.08, shape: "rise" }); },
  ],
  // ③ 퍼커션
  [
    t => { for (let i = 0; i < 12; i++) noise(t + i * 0.06, { freq: 6000, dur: 0.05, vol: i % 2 ? 0.12 : 0.22 }); },
    t => { tone(t, { f0: 400, f1: 340, drop: 0.05, dur: 0.25, vol: 0.8 });
           noise(t, { type: "bandpass", freq: 2000, dur: 0.01, vol: 0.3 }); },
    t => { tone(t, { f0: 280, f1: 220, drop: 0.05, dur: 0.35, vol: 0.8 });
           noise(t, { type: "bandpass", freq: 1500, dur: 0.01, vol: 0.3 }); },
    t => { tone(t, { f0: 520, f1: 460, drop: 0.03, dur: 0.15, vol: 0.7 });
           noise(t, { type: "bandpass", freq: 3000, dur: 0.008, vol: 0.3 }); },
    t => { noise(t, { type: "bandpass", freq: 2800, Q: 3, dur: 0.05, vol: 2 });
           tone(t, { type: "triangle", f0: 2200, dur: 0.015, vol: 0.3 }); },
    t => { tone(t, { f0: 1000, dur: 0.08, vol: 0.7 });
           tone(t, { type: "triangle", f0: 1720, dur: 0.04, vol: 0.3 }); },
    t => tone(t, { f0: 2500, dur: 0.06, vol: 0.6 }),
    t => { tone(t, { f0: 2637, dur: 1.5, vol: 0.2 });
           tone(t, { f0: 4186, dur: 1, vol: 0.08 });
           tone(t, { f0: 6600, dur: 0.6, vol: 0.05 }); },
    t => { for (let i = 0; i < 10; i++) noise(t + i * 0.05, { freq: 7000, Q: 2, dur: 0.08, vol: 0.3 }); },
    t => { for (const d of [0, 0.05, 0.08]) noise(t + d, { type: "bandpass", freq: 3500, Q: 4, dur: 0.02, vol: 1.5 }); },
  ],
  // ④ 게임·SF
  [
    t => notesSeq(t, [988, 1319], 0.08, { vol: 0.18, last: 0.35 }),
    t => notesSeq(t, [523, 659, 784, 1047, 1319, 1568], 0.05, { vol: 0.15, last: 0.2 }),
    t => tone(t, { type: "square", f0: 300, f1: 900, drop: 0.15, dur: 0.18, vol: 0.2 }),
    t => { tone(t, { type: "square", f0: 1800, f1: 300, drop: 0.2, dur: 0.22, vol: 0.2 });
           tone(t, { f0: 900, f1: 150, drop: 0.2, dur: 0.22, vol: 0.2 }); },
    t => { for (let i = 0; i < 10; i++) {
             const f = 200 + Math.random() * 2800;
             if (Math.random() < 0.6) tone(t + i * 0.03, { type: "square", f0: f, dur: 0.02 + Math.random() * 0.03, vol: 0.15 });
             else noise(t + i * 0.03, { type: "bandpass", freq: f, Q: 4, dur: 0.03, vol: 0.6 }); } },
    t => notesSeq(t, [659, 784, 988, 1319, 659, 784, 988, 1319, 659, 784, 988, 1319], 0.06, { type: "triangle", vol: 0.2 }),
    t => { const o = ctx.createOscillator(), o2 = ctx.createOscillator(), lfo = ctx.createOscillator(), g = ctx.createGain();  // 로봇
           const f = filterNode("bandpass", 1000, 6);
           o.type = "sawtooth"; o.frequency.value = 110; o2.type = "square"; o2.frequency.value = 112;
           lfo.type = "square"; lfo.frequency.value = 6;
           lfo.connect(gainNode(500)).connect(f.frequency);
           env(g, t, 0.5, 1, "hold");
           o.connect(f); o2.connect(f); f.connect(g).connect(out);
           for (const s of [o, o2, lfo]) { s.start(t); s.stop(t + 1); }
           track(g, [o, o2, lfo]); },
    t => { for (let i = 0; i < 6; i++) tone(t + i * 0.15, { type: "square", f0: i % 2 ? 660 : 880, dur: 0.15, vol: 0.15, shape: "hold" }); },
    t => { tone(t, { f0: 200, f1: 3000, drop: 0.8, dur: 0.8, vol: 0.25 });
           tone(t, { type: "triangle", f0: 400, f1: 6000, drop: 0.8, dur: 0.8, vol: 0.1 }); },
    t => { notesSeq(t, [784, 740, 698, 659], 0.25, { vol: 0.15, last: 0.6 });
           tone(t, { type: "triangle", f0: 196, f1: 98, drop: 1.2, dur: 1.3, vol: 0.3 }); },
  ],
];

// ================= 멜로디 악기 10개 (숫자 1~0). 이름은 i18n.js =================
// oscs: [파형, 주파수 배수, 어긋남(cent), 음량, 좌우 위치(-1~1)]
// filter.env: [시작 주파수, 걸리는 시간] → 시작 주파수에서 freq로 닫힌다
// filter.lfo / vibrato: [속도(Hz), 깊이]  amp: a=어택, d=줄어드는 시간, s=유지 비율, r=뗀 뒤 꼬리
const INSTS = [
  { base: 36, oscs: [["sawtooth", 1, -8, 1], ["sawtooth", 1, 8, 1], ["square", 0.5, 0, 1]],
    filter: { freq: 400, Q: 6, env: [3000, 0.25] }, amp: { a: 0.005, r: 0.08 }, peak: 0.3 },
  { base: 36, oscs: [["sine", 1, 0, 1], ["triangle", 1, 0, 0.15]], pitchEnv: [2, 0.04], drive: 2,
    amp: { a: 0.005, r: 0.15 }, peak: 0.5 },
  { base: 36, oscs: [["sawtooth", 1, 0, 1]], filter: { freq: 300, Q: 18, env: [5000, 0.18] }, drive: 3,
    amp: { a: 0.003, r: 0.05 }, peak: 0.25 },
  { base: 36, oscs: [["sawtooth", 1, -18, 1, -0.5], ["sawtooth", 1, 18, 1, 0.5], ["sine", 0.5, 0, 1]],
    filter: { freq: 700, Q: 3, lfo: [0.4, 450] }, drive: 2, amp: { a: 0.01, r: 0.12 }, peak: 0.22 },
  { base: 60, oscs: [["sawtooth", 1, -10, 1, -0.3], ["sawtooth", 1, 0, 1], ["sawtooth", 1, 10, 1, 0.3]],
    filter: { freq: 5000, Q: 1 }, vibrato: [5.5, 10], amp: { a: 0.01, r: 0.2 }, peak: 0.15, delay: 0.25, verb: 0.15 },
  { base: 60, oscs: [-30, -18, -8, 0, 8, 18, 30].map((d, i) => ["sawtooth", 1, d, 1, (i - 3) / 3]),
    filter: { freq: 9000, Q: 0.5 }, amp: { a: 0.01, r: 0.4 }, peak: 0.08, verb: 0.35, delay: 0.15 },
  { base: 60, oscs: [["sawtooth", 1, -12, 1, -0.4], ["sawtooth", 1, 12, 1, 0.4], ["square", 2, 0, 0.3]],
    filter: { freq: 350, Q: 4, env: [7000, 0.15] }, amp: { a: 0.002, d: 0.35, s: 0, r: 0.2 }, peak: 0.5, verb: 0.3, delay: 0.3 },
  { base: 60, oscs: [["square", 1, 0, 1]], vibrato: [6, 15], amp: { a: 0.001, r: 0.03 }, peak: 0.2, delay: 0.1 },
  { base: 48, oscs: [["sawtooth", 1, -12, 1, -0.6], ["sawtooth", 1, 12, 1, 0.6], ["sawtooth", 1, -5, 1, -0.2],
                     ["sawtooth", 1, 5, 1, 0.2], ["triangle", 2, 0, 1]],
    filter: { freq: 1500, Q: 1, lfo: [0.2, 600] }, amp: { a: 0.6, r: 1.2 }, peak: 0.07, verb: 0.6 },
  { base: 60, oscs: [["sine", 1, 0, 1]], fm: [1, 2.5, 1.2], amp: { a: 0.003, d: 2.5, s: 0.15, r: 0.4 }, peak: 0.3, verb: 0.3 },
];

// 악기(def) 하나로 음 하나를 t 시각에 시작한다. 끌 때는 stopVoice
function startVoice(def, midi, t) {
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const amp = ctx.createGain();
  const srcs = [];

  // 오실레이터 → (필터) → (찌그러짐) → 음량 모양(amp)
  let head = ctx.createGain(), tail = head;
  let flt = null;
  if (def.filter) {
    flt = filterNode("lowpass", def.filter.freq, def.filter.Q);
    tail = tail.connect(flt);
    if (def.filter.env) {
      flt.frequency.setValueAtTime(def.filter.env[0], t);
      flt.frequency.exponentialRampToValueAtTime(def.filter.freq, t + def.filter.env[1]);
    }
  }
  if (def.drive) tail = tail.connect(shaper(def.drive));
  tail.connect(amp);

  // 떨림(LFO): 필터를 흔들거나(lfo) 음높이를 흔든다(vibrato)
  const lfo = (rate, depth) => {
    const o = ctx.createOscillator();
    o.frequency.value = rate; o.start(t); srcs.push(o);
    return o.connect(gainNode(depth));
  };
  if (def.filter && def.filter.lfo) lfo(...def.filter.lfo).connect(flt.frequency);
  const vib = def.vibrato ? lfo(...def.vibrato) : null;
  // FM: 다른 오실레이터로 음높이를 아주 빠르게 흔들어 종·피아노 같은 소리를 만든다
  let fmOut = null;
  if (def.fm) {
    const [ratio, index, decay] = def.fm;
    const m = ctx.createOscillator(), mg = ctx.createGain();
    m.frequency.value = f * ratio;
    mg.gain.setValueAtTime(f * index, t);
    mg.gain.exponentialRampToValueAtTime(f * index * 0.1, t + decay);
    m.connect(mg); m.start(t); srcs.push(m);
    fmOut = mg;
  }

  for (const [type, ratio, detune, vol, pan] of def.oscs) {
    const o = ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    if (def.pitchEnv) {
      o.frequency.setValueAtTime(f * ratio * def.pitchEnv[0], t);
      o.frequency.exponentialRampToValueAtTime(f * ratio, t + def.pitchEnv[1]);
    } else {
      o.frequency.value = f * ratio;
    }
    if (vib) vib.connect(o.detune);
    if (fmOut) fmOut.connect(o.frequency);
    let node = o.connect(gainNode(vol));
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node = node.connect(p);
    }
    node.connect(head);
    o.start(t);
    srcs.unshift(o);  // srcs[0]이 소리 나는 오실레이터가 되도록 (끝났는지 확인용)
  }

  // 음량 모양: 어택까지 올라갔다가, d가 있으면 s만큼으로 줄어든다
  const { a, d, s = 1, r } = def.amp;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(def.peak, t + a);
  if (d) amp.gain.setTargetAtTime(def.peak * s, t + a, d / 4);

  amp.connect(master);
  if (def.verb) amp.connect(gainNode(def.verb)).connect(verbIn);
  if (def.delay) amp.connect(gainNode(def.delay)).connect(delayIn);

  const v = track(amp, srcs);
  Object.assign(v, { start: t, attack: a, release: r });
  return v;
}

// t 시각부터 꼬리(release)를 남기며 줄어든다. 어택이 끝나기 전에는 끄지 않는다
function stopVoice(v, t) {
  if (!v) return;
  t = Math.max(t, v.start + v.attack);
  v.g.gain.cancelScheduledValues(t);
  v.g.gain.setTargetAtTime(0, t, v.release / 4);
  v.srcs.forEach(s => { try { s.stop(t + v.release * 1.5); } catch (e) {} });
}

// ================= 내 소리 3칸 (I [ \ 키): 마이크 녹음 또는 불러온 파일 =================
// kind "pitch" = 짧은 소리. A키(옥타브 0)가 원래 높이, 다른 건반은 재생 속도로 음높이를 바꾼다
// kind "chop"  = 긴 소리·노래. 구간(16박) 안을 1박씩 16조각으로 잘라 A~P 키에 둔다
//   midi 60~75 = 조각 1~16, 76 = 구간 전체
const SAMPLES = [null, null, null];
const SAMPLE_META = [null, null, null];   // {kind, name, bpm(원곡), start(구간 시작 초), match(속도 맞추기)}
const CHOP_SLICES = 16, CHOP_WHOLE = 76;
const isChop = slot => !!SAMPLES[slot] && (SAMPLE_META[slot] || {}).kind === "chop";
// 속도 맞추기: 원곡 BPM → 지금 BPM 비율로 재생 속도를 바꾼다 (음높이도 같이 바뀐다)
const chopRate = m => (m.match && m.bpm ? proj.bpm / m.bpm : 1);

function startSample(slot, midi, t) {
  const buf = SAMPLES[slot];
  if (!buf) return null;
  const m = SAMPLE_META[slot] || { kind: "pitch" };
  const s = ctx.createBufferSource(), g = ctx.createGain();
  s.buffer = buf;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.9, t + 0.003);
  if (m.kind === "chop") {
    const beat = 60 / m.bpm, idx = midi - 60;
    const offset = m.start + (idx >= CHOP_SLICES ? 0 : idx * beat);
    if (offset >= buf.duration) return null;
    const dur = Math.min(idx >= CHOP_SLICES ? beat * CHOP_SLICES : beat, buf.duration - offset);
    const rate = chopRate(m), end = t + dur / rate;
    s.playbackRate.value = rate;
    s.start(t, offset, dur);
    g.gain.setValueAtTime(0.9, Math.max(t + 0.004, end - 0.006));  // 조각 끝에서 '틱' 소리가 나지 않게 살짝 줄인다
    g.gain.linearRampToValueAtTime(0, end);
  } else {
    s.playbackRate.value = Math.pow(2, (midi - 60) / 12);
    s.start(t);
  }
  s.connect(g);
  g.connect(master);
  g.connect(gainNode(0.15)).connect(verbIn);
  const v = track(g, [s]);
  Object.assign(v, { start: t, attack: 0.003, release: 0.08 });
  return v;
}

// ================= 트랙 =================
// 트랙 id: "i0"~"i9" = 악기 1~0, "r1" "r2"… = 랜덤 음색(proj.randoms), "u0"~"u2" = 내 소리
function trackDef(id) {
  if (id[0] === "i") return INSTS[+id.slice(1)];
  if (id[0] === "r") return proj.randoms[id];
  return null;
}
function trackBase(id) { return id[0] === "u" ? 60 : trackDef(id).base; }
function startNote(id, midi, t) {
  if (id[0] === "u") return startSample(+id.slice(1), midi, t);
  const def = trackDef(id);
  return def ? startVoice(def, midi, t) : null;
}
function trackName(id) {
  if (id[0] === "i") return t("insts")[+id.slice(1)];
  if (id[0] === "r") return t("randomTone") + " " + id.slice(1);
  const m = SAMPLE_META[+id.slice(1)];
  return m && m.name ? m.name : t("user") + " " + (+id.slice(1) + 1);   // 불러온 노래는 파일 이름
}
function trackShort(id) {
  if (id[0] === "i") return t("instShort")[+id.slice(1)];
  if (id[0] === "r") return "R" + id.slice(1);
  return "U" + (+id.slice(1) + 1);
}
// 화면 색 묶음: 베이스(1~4) / 멜로디(5~0) / 랜덤 / 내 소리
function trackGroup(id) {
  if (id[0] === "i") return +id.slice(1) <= 3 ? "bass" : "mel";
  return id[0] === "r" ? "rnd" : "usr";
}
