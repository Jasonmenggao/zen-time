/* ========================================================================
   Zen Time · 音频系统
   真实音频：fetch → decodeAudioData → AudioBufferSourceNode 无缝循环
   失败时：Web Audio API 合成环境音（海浪/林间/风雪/沙漠低鸣）
   预加载：preloadAll() 在入场前 fetch 所有 MP3 → 缓存 ArrayBuffer
   风声：startWind()/stopWind() 飞行界面环境音
   音量淡入淡出 · 无缝循环
   ======================================================================== */

window.ZenAudio = (function () {
  // 媒体 CDN（腾讯云 COS，大陆直连高速；为空则回退相对路径）
  const ASSET_BASE = 'https://zen-time-media-1366436139.cos.ap-shanghai.myqcloud.com';

  let AC = null;            // AudioContext
  let master = null;        // 主增益（冥想音频）
  let source = null;        // 当前 buffer 源（真实音频）
  let synthNodes = [];      // 合成节点
  let synthTimer = null;    // 合成 LFO 定时
  let currentBuffer = null;
  let activeKind = null;    // 'real' | 'synth'
  let started = false;

  // ---- 预加载缓存 ----
  const audioCache = {};    // scene.id → ArrayBuffer

  // ---- 风声节点 ----
  let windNodes = [];
  let windGain = null;

  function ensureCtx() {
    if (AC) return AC;
    const ACtx = window.AudioContext || window.webkitAudioContext;
    AC = new ACtx();
    master = AC.createGain();
    master.gain.value = 0;
    master.connect(AC.destination);
    return AC;
  }

  // ===================== 预加载所有音频 =====================
  // 只 fetch 下载，不 decode（decode 需要 AudioContext，iOS 需用户手势）
  async function preloadAll(scenes, onProgress) {
    let loaded = 0;
    const total = scenes.length;
    await Promise.all(scenes.map(async (scene) => {
      try {
        const response = await fetch(`${ASSET_BASE}/assets/audio/${scene.id}.mp3`);
        if (!response.ok) throw new Error('not found');
        audioCache[scene.id] = await response.arrayBuffer();
      } catch (e) {
        // 运行时会走 fetch 兜底 → synth 兜底
      }
      loaded++;
      if (onProgress) onProgress(loaded / total);
    }));
  }

  // ---- 解码缓存的 ArrayBuffer ----
  function decodeCached(arrayBuffer) {
    return new Promise((resolve, reject) => {
      ensureCtx();
      // slice(0) 防止 ArrayBuffer 被 detach 后无法二次使用
      AC.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
    });
  }

  // ---- 加载并循环某场景音频 ----
  async function loadScene(scene) {
    ensureCtx();
    if (AC.state === 'suspended') { try { await AC.resume(); } catch (e) {} }
    stop();

    // ① 优先使用预加载缓存
    if (audioCache[scene.id]) {
      try {
        const buf = await decodeCached(audioCache[scene.id]);
        currentBuffer = buf;
        activeKind = 'real';
        playReal(buf);
        return true;
      } catch (e) {
        // decode 失败，尝试重新 fetch
      }
    }

    // ② 在线 fetch
    const url = `${ASSET_BASE}/assets/audio/${scene.id}.mp3`;
    try {
      const buf = await fetchAudio(url);
      currentBuffer = buf;
      activeKind = 'real';
      playReal(buf);
      return true;
    } catch (e) {
      // ③ 兜底合成
      activeKind = 'synth';
      startSynth(scene.id);
      return false;
    }
  }

  function fetchAudio(url) {
    return new Promise((resolve, reject) => {
      fetch(url).then(r => {
        if (!r.ok) throw new Error('not found');
        return r.arrayBuffer();
      }).then(ab => {
        AC.decodeAudioData(ab, resolve, reject);
      }).catch(reject);
    });
  }

  // ---- 真实音频：无缝循环 ----
  function playReal(buffer) {
    if (!AC) return;
    source = AC.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = buffer.duration;
    source.connect(master);
    source.start(0);
  }

  // ===================== 合成环境音 =====================
  function startSynth(kind) {
    ensureCtx();
    stopSynth();
    const bufSize = AC.sampleRate * 2;
    const noiseBuf = AC.createBuffer(1, bufSize, AC.sampleRate);
    const data = noiseBuf.getChannelData(0);
    if (kind === 'sand' || kind === 'snow') {
      let last = 0;
      for (let i = 0; i < bufSize; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = last * 3.5;
      }
    } else {
      for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    }

    const noise = AC.createBufferSource();
    noise.buffer = noiseBuf; noise.loop = true;

    const filter = AC.createBiquadFilter();
    if (kind === 'sea') {
      filter.type = 'lowpass'; filter.frequency.value = 900;
    } else if (kind === 'forest') {
      filter.type = 'bandpass'; filter.frequency.value = 1400; filter.Q.value = 0.6;
    } else if (kind === 'snow') {
      filter.type = 'lowpass'; filter.frequency.value = 600;
    } else {
      filter.type = 'lowpass'; filter.frequency.value = 400;
    }

    const gain = AC.createGain();
    gain.gain.value = 0.0;
    noise.connect(filter); filter.connect(gain); gain.connect(master);

    if (kind === 'sea') {
      synthTimer = setInterval(() => {
        const now = AC.currentTime;
        const cycle = 7 + Math.random() * 3;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0.32, now + cycle * 0.4);
        gain.gain.linearRampToValueAtTime(0.08, now + cycle);
      }, 4000);
      gain.gain.setValueAtTime(0.12, AC.currentTime);
    } else if (kind === 'forest') {
      gain.gain.setValueAtTime(0.1, AC.currentTime);
      synthTimer = setInterval(() => {
        if (Math.random() < 0.18) chirp();
        const now = AC.currentTime;
        gain.gain.linearRampToValueAtTime(0.06 + Math.random() * 0.08, now + 2);
      }, 1500);
    } else if (kind === 'snow') {
      gain.gain.setValueAtTime(0.14, AC.currentTime);
      synthTimer = setInterval(() => {
        const now = AC.currentTime;
        gain.gain.linearRampToValueAtTime(0.1 + Math.random() * 0.06, now + 3);
      }, 3000);
    } else {
      gain.gain.setValueAtTime(0.16, AC.currentTime);
      synthTimer = setInterval(() => {
        const now = AC.currentTime;
        gain.gain.linearRampToValueAtTime(0.12 + Math.random() * 0.05, now + 4);
      }, 4000);
    }

    noise.start(0);
    synthNodes = [noise, filter, gain];
  }

  function chirp() {
    const o = AC.createOscillator();
    const g = AC.createGain();
    o.type = 'sine';
    const base = 1800 + Math.random() * 1200;
    o.frequency.setValueAtTime(base, AC.currentTime);
    o.frequency.exponentialRampToValueAtTime(base * 1.4, AC.currentTime + 0.08);
    o.frequency.exponentialRampToValueAtTime(base * 0.8, AC.currentTime + 0.16);
    g.gain.setValueAtTime(0, AC.currentTime);
    g.gain.linearRampToValueAtTime(0.06, AC.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + 0.3);
    o.connect(g); g.connect(master);
    o.start();
    o.stop(AC.currentTime + 0.32);
  }

  function stopSynth() {
    if (synthTimer) { clearInterval(synthTimer); synthTimer = null; }
    synthNodes.forEach(n => { try { if (n.stop) n.stop(); } catch (e) {} });
    synthNodes = [];
  }

  // ===================== 风声（飞行界面环境音）=====================
  function startWind() {
    ensureCtx();
    stopWind();

    // 棕噪声 — 低频柔和，模拟高空风声
    const bufSize = AC.sampleRate * 2;
    const noiseBuf = AC.createBuffer(1, bufSize, AC.sampleRate);
    const data = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufSize; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 2.5;
    }

    const noise = AC.createBufferSource();
    noise.buffer = noiseBuf; noise.loop = true;

    const filter = AC.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 550;
    filter.Q.value = 0.3;

    // 独立 gain — 不走 master，避免与冥想音频互相干扰
    windGain = AC.createGain();
    windGain.gain.value = 0;
    windGain.gain.linearRampToValueAtTime(0.13, AC.currentTime + 2.0);

    // 慢 LFO — 自然的风强弱变化
    const lfo = AC.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoGain = AC.createGain();
    lfoGain.gain.value = 0.04;
    lfo.connect(lfoGain);
    lfoGain.connect(windGain.gain);

    noise.connect(filter);
    filter.connect(windGain);
    windGain.connect(AC.destination);

    noise.start(0);
    lfo.start(0);

    windNodes = [noise, filter, windGain, lfo, lfoGain];
  }

  function stopWind() {
    if (windNodes.length === 0) return;
    if (windGain && AC) {
      const now = AC.currentTime;
      windGain.gain.cancelScheduledValues(now);
      windGain.gain.setValueAtTime(windGain.gain.value, now);
      windGain.gain.linearRampToValueAtTime(0, now + 1.0);
    }
    const nodes = windNodes.slice();
    setTimeout(() => {
      nodes.forEach(n => { try { if (n.stop) n.stop(); } catch (e) {} });
    }, 1100);
    windNodes = [];
    windGain = null;
  }

  // ---- 淡入 / 淡出 ----
  function fadeIn(dur) {
    if (!AC || !master) return;
    const now = AC.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0.8, now + (dur || 2.5));
  }
  function fadeOut(dur) {
    if (!AC || !master) return;
    const now = AC.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0.0001, now + (dur || 2.5));
  }

  // ---- 停止一切 ----
  function stop() {
    stopSynth();
    if (source) { try { source.stop(); } catch (e) {} source = null; }
    activeKind = null;
  }

  function isActive(kind) { return activeKind === kind; }

  // 解锁（浏览器策略：首次需用户手势）
  function unlock() { ensureCtx(); if (AC.state === 'suspended') AC.resume(); }

  return {
    loadScene, fadeIn, fadeOut, stop, isActive, unlock,
    preloadAll, startWind, stopWind
  };
})();
