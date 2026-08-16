/* ========================================================================
   Zen Time · 冥想会话逻辑
   计时 · 盒式呼吸圆（4-4-4-4 · 16s 方波）· 叙事三行时序 · 进度线 · UI 空闲淡出
   ======================================================================== */

window.ZenSession = (function () {
  let scene = null, duration = null;
  let lines = [];
  let totalMs = 0, elapsedMs = 0;
  let startTs = 0, rafId = null;
  let narIndex = -1, narTimer = null;
  let idleTimer = null, uiDim = false;
  let onEnd = null;

  // DOM
  const $ = id => document.getElementById(id);
  const timerEl = $('med-timer');
  const fillEl = $('med-progress-fill');
  const breathEl = document.querySelector('.breath-circle');
  const labelEl = $('breath-label');
  const actionEl = document.querySelector('.breath-action');
  const countEl = document.querySelector('.breath-count');
  const uiEl = $('med-ui');
  const nPrev = document.querySelector('.nline.n-prev');
  const nNow = document.querySelector('.nline.n-now');
  const nNext = document.querySelector('.nline.n-next');

  // ===================== 重置（清空上次冥想残留）=====================
  function reset() {
    // 停止所有计时器
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (narTimer) { clearInterval(narTimer); narTimer = null; }
    if (breathClock) { clearInterval(breathClock); breathClock = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

    // 清空叙事文字
    if (nPrev) { nPrev.textContent = ''; nPrev.style.opacity = '0'; }
    if (nNow)  { nNow.textContent = ''; nNow.classList.remove('n-now'); nNow.style.opacity = '0'; }
    if (nNext) { nNext.textContent = ''; nNext.style.opacity = '0'; }

    // 清空位置信息
    if ($('loc-name')) $('loc-name').textContent = '';
    if ($('loc-time')) $('loc-time').textContent = '';
    if ($('loc-story')) $('loc-story').textContent = '';

    // 重置计时器/进度
    if (timerEl) timerEl.textContent = '0:00';
    if (fillEl) fillEl.style.width = '0%';

    // 重置呼吸圆
    if (breathEl) { breathEl.classList.remove('is-breathing', 'is-resting'); }
    if (actionEl) actionEl.textContent = '';
    if (countEl) countEl.textContent = '';

    // 重置 UI
    uiDim = false;
    if (uiEl) uiEl.classList.remove('is-dim');

    // 重置状态
    narIndex = -1;
    elapsedMs = 0;
    scene = null; duration = null; onEnd = null;
    lines = [];
  }

  // ===================== 启动 =====================
  function start(sceneObj, durObj, endCb) {
    scene = sceneObj; duration = durObj; onEnd = endCb;
    lines = window.ZenData.getNarration(scene.id, duration.id);
    totalMs = duration.minutes * 60 * 1000;
    elapsedMs = 0;

    // 位置信息（固定时间 + 场景故事句）
    $('loc-name').textContent = scene.name;
    $('loc-time').textContent = scene.fixedTime;
    $('loc-story').textContent = scene.timeStory;

    breathEl.classList.add('is-breathing');
    setBreathLabel('吸', '4');

    startTs = performance.now();
    uiDim = false; uiEl.classList.remove('is-dim');
    resetIdle();

    // 叙事首行立刻显示
    narIndex = 0;
    showLine(0);
    scheduleNext();

    // 主循环
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);

    // 呼吸相位时钟（与 CSS 动画对齐）
    startBreathClock();
  }

  // ===================== 计时主循环 =====================
  function tick() {
    elapsedMs = performance.now() - startTs;
    const p = Math.min(elapsedMs / totalMs, 1);

    fillEl.style.width = (p * 100) + '%';
    timerEl.textContent = formatTime(Math.min(elapsedMs, totalMs));

    if (elapsedMs >= totalMs) {
      finish();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  // ===================== 叙事时序 =====================
  // 三行：上一行淡出 / 当前行 / 下一行淡入
  // 每隔 interval 显示下一行，interval 随时长自适应
  function scheduleNext() {
    clearInterval(narTimer);
    if (narIndex >= lines.length - 1) {
      // 叙事结束后，呼吸继续；末行停留
      return;
    }
    // 固定4秒：与盒式呼吸4-4-4-4阶段完全对齐
    const interval = 4;
    narTimer = setInterval(() => {
      narIndex++;
      if (narIndex >= lines.length) { clearInterval(narTimer); return; }
      showLine(narIndex);
      scheduleNext();
    }, interval * 1000);
  }

  function showLine(i) {
    const prev = lines[i - 1];
    const now = lines[i];
    const next = lines[i + 1];

    nNow.classList.remove('n-now'); void nNow.offsetWidth;
    nPrev.textContent = prev || '';
    nNow.textContent = now || '';
    nNext.textContent = next || '';

    // 触发淡入：临时移除再加回
    nNow.style.opacity = '0';
    requestAnimationFrame(() => {
      nNow.style.opacity = '';
      nNow.classList.add('n-now');
    });
    nPrev.style.opacity = '0.18';
    if (prev) nPrev.style.opacity = '0.18'; else nPrev.style.opacity = '0';
    nNext.style.opacity = '0';
  }

  // ===================== 盒式呼吸引导（4-4-4-4 · 16s 循环）=====================
  // 四阶段：吸气4s → 屏息4s → 呼气4s → 屏息4s
  // 中心显示动作字 + 倒计时（4→3→2→1）
  let breathPhase = '';
  function setBreathLabel(action, count) {
    if (actionEl) actionEl.textContent = action;
    if (countEl) countEl.textContent = count;
  }
  let breathClock = null;
  function startBreathClock() {
    clearInterval(breathClock);
    // CSS 动画 16s 循环：0-4s 吸，4-8s 屏，8-12s 呼，12-16s 屏
    breathClock = setInterval(() => {
      const phaseSec = ((performance.now() - startTs) / 1000) % 16;
      let phase, label, count;

      if (phaseSec < 4) {
        phase = 'in';    label = '吸'; count = Math.ceil(4 - phaseSec);
      } else if (phaseSec < 8) {
        phase = 'hold1'; label = '屏'; count = Math.ceil(8 - phaseSec);
      } else if (phaseSec < 12) {
        phase = 'out';   label = '呼'; count = Math.ceil(12 - phaseSec);
      } else {
        phase = 'hold2'; label = '屏'; count = Math.ceil(16 - phaseSec);
      }

      breathPhase = phase;
      setBreathLabel(label, count);
    }, 500);
  }

  // ===================== UI 空闲淡出 =====================
  function resetIdle() {
    if (uiDim) { uiDim = false; uiEl.classList.remove('is-dim'); }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      uiDim = true; uiEl.classList.add('is-dim');
    }, 5000);
  }

  document.addEventListener('mousemove', () => { if (rafId) resetIdle(); });
  document.addEventListener('touchstart', () => { if (rafId) resetIdle(); }, { passive: true });

  // ===================== 结束 =====================
  function finish() {
    cancelAnimationFrame(rafId); rafId = null;
    clearInterval(narTimer); narTimer = null;
    clearInterval(breathClock); breathClock = null;
    breathEl.classList.remove('is-breathing');
    breathEl.classList.add('is-resting');
    setBreathLabel('', '');
    if (onEnd) onEnd({ scene, duration, totalMs });
  }

  function stopEarly() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    clearInterval(narTimer); narTimer = null;
    clearInterval(breathClock); breathClock = null;
    breathEl.classList.remove('is-breathing');
    setBreathLabel('', '');
  }

  return { start, stopEarly, reset, _internalStartBreathClock: startBreathClock };
})();
