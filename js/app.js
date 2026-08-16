/* ========================================================================
   Zen Time · 应用控制
   全屏视频背景 · 点击任意位置开始 · crossfade 过渡
   全量预加载（5视频 + 4音频）· 进度轴 + 冥想语录轮播
   飞行界面风声 · 冥想界面场景音
   视频元素池：4个独立 scene-video，预加载后直接 play()，无需换 src
   ======================================================================== */

window.ZenApp = (function () {
  const Z = window.ZenData;
  const $ = id => document.getElementById(id);

  let curScene = Z.getScene('snow');
  let curDur = Z.getDuration('m3');
  let isTransitioning = false;
  let activeStage = 'entry';
  let activeSceneVideo = null;   // 当前播放中的 .scene-video 元素

  // ===================== 初始化 =====================
  function init() {
    buildSelectors();
    bind();
    applyDefaults();
    setupSceneVideoHandlers();
    setupIntro();
  }

  // ===================== 场景视频事件处理 =====================
  // 视频已全量预加载（canplaythrough），loop 回绕是浏览器内部 seek，
  // 数据已在内存中，不需要任何兜底。仅在视频真正 error 时才切 canvas。
  function setupSceneVideoHandlers() {
    document.querySelectorAll('.scene-video').forEach(v => {
      v.addEventListener('error', () => {
        if (v !== activeSceneVideo) return;
        v.classList.add('is-stalled');
        if (curScene) window.ZenVisuals.start(curScene);
      });
    });
  }

  // ===================== 入场黑屏：全量预加载 =====================
  function setupIntro() {
    const intro     = $('screen-intro');
    const fill      = $('intro-progress-fill');
    const quoteEl   = $('intro-quote');
    if (!intro) return;

    // ---- 冥想语录轮播（穿越时空旅行家主题）----
    const quotes = [
      '你是一位穿越时空的旅人 · 此刻正飞往某个久违的静谧',
      '云层之下是喧嚣 · 云层之上只有你与天空',
      '每一次呼吸 · 都是一次抵达',
      '放下行囊 · 此刻不需要去往任何地方',
      '让时间慢下来 · 让世界变小',
      '在万米高空 · 听见内心最深处的回声',
    ];
    let qIdx = 0;
    if (quoteEl) quoteEl.textContent = quotes[0];
    const quoteTimer = setInterval(() => {
      if (!quoteEl) return;
      qIdx = (qIdx + 1) % quotes.length;
      quoteEl.style.opacity = '0';
      setTimeout(() => {
        quoteEl.textContent = quotes[qIdx];
        quoteEl.style.opacity = '';
      }, 600);
    }, 4000);

    // ---- 预加载视频 ----
    // 追踪：plane-video + end-plane-video + 4 个 .scene-video = 6 个
    const videoLoaded = {};
    const videoBufPct = {};   // 每个视频的缓冲百分比（0~1）
    const totalVideos = 6;

    function trackVideoBuffer(v, key) {
      const onProgress = () => {
        if (v.buffered.length && v.duration) {
          const end = v.buffered.end(v.buffered.length - 1);
          videoBufPct[key] = Math.min(1, end / v.duration);
        }
        checkProgress();
      };
      v.addEventListener('progress', onProgress);
      v.addEventListener('canplaythrough', () => {
        videoLoaded[key] = true;
        videoBufPct[key] = 1;
        checkProgress();
      });
      if (v.readyState >= 3) { videoLoaded[key] = true; videoBufPct[key] = 1; checkProgress(); }
      v.addEventListener('error', () => { videoLoaded[key] = true; videoBufPct[key] = 1; checkProgress(); });
    }

    // plane-video / end-plane-video（在 DOM 中，共享 plane.mp4 缓存）
    ['plane-video', 'end-plane-video'].forEach(id => {
      const pv = $(id);
      if (pv) trackVideoBuffer(pv, id);
    });

    // 场景视频 — 直接追踪冥想屏中的 .scene-video 元素（它们就是播放元素）
    document.querySelectorAll('.scene-video').forEach(v => {
      trackVideoBuffer(v, v.dataset.scene);
    });

    // ---- 预加载音频 ----
    let audioProgress = 0;
    window.ZenAudio.preloadAll(Z.SCENES, (p) => {
      audioProgress = p;
      checkProgress();
    });

    // ---- 综合进度 ----
    let allReady = false;
    let introDismissed = false;
    let displayedPct = 3;        // 初始 3%（与 CSS width:3% 一致，JS 加载前就可见）

    function getRealPct() {
      // 视频缓冲百分比取平均（每个视频权重均等）
      const videoKeys = Object.keys(videoBufPct);
      const videoAvg = videoKeys.length
        ? videoKeys.reduce((s, k) => s + (videoBufPct[k] || 0), 0) / totalVideos
        : 0;
      // 视频 55%，音频 45%
      return videoAvg * 0.55 + audioProgress * 0.45;
    }

    function checkProgress() {
      if (allReady) return;
      const realPct = getRealPct();
      const videosReady = Object.keys(videoLoaded).filter(k => videoLoaded[k]).length;

      if (videosReady >= totalVideos && audioProgress >= 1) {
        allReady = true;
        if (fill) fill.style.width = '100%';
        intro.classList.add('is-ready');
      }
    }

    // ---- 平滑进度动画 + 最小蠕动 ----
    // 进度条始终缓慢前进（即使网络卡住），让用户知道"正在加载"
    const progressTimer = setInterval(() => {
      if (allReady) { clearInterval(progressTimer); return; }
      const realPct = getRealPct();
      if (displayedPct < realPct) {
        displayedPct += (realPct - displayedPct) * 0.3;   // 快速追赶真实进度
      } else if (displayedPct < 90) {
        // 蠕动：速度随当前进度递减（开头快、接近 90% 时慢），模拟自然加载感
        const crawlSpeed = 1.5 - (displayedPct / 90) * 0.8;  // 1.5→0.7
        displayedPct += crawlSpeed;
      }
      if (fill) fill.style.width = `${Math.min(90, displayedPct)}%`;
    }, 100);

    // 45s 超时兜底（慢网络下不让用户等太久）
    setTimeout(() => {
      if (!allReady) {
        allReady = true;
        if (fill) fill.style.width = '100%';
        intro.classList.add('is-ready');
      }
    }, 45000);

    // ---- 用户点击进入（iOS 用户手势解锁）----
    intro.addEventListener('click', () => {
      if (introDismissed || !allReady) return;
      introDismissed = true;
      clearInterval(quoteTimer);
      clearInterval(progressTimer);

      intro.classList.remove('is-ready');
      intro.classList.add('is-hidden');

      // ① 用户手势内播放 plane 视频（解锁 iOS 自动播放）
      ['plane-video', 'end-plane-video'].forEach(id => {
        const pv = $(id);
        if (pv) { pv.muted = true; pv.play().catch(() => {}); }
      });

      // ② 解锁音频 + 启动风声
      window.ZenAudio.unlock();
      window.ZenAudio.startWind();

      setTimeout(() => { intro.style.display = 'none'; }, 1300);
    });
  }

  function applyDefaults() {
    curScene = Z.getScene('snow');
    curDur = Z.getDuration('m3');
    syncAllSelectors();
  }

  // ===================== 构建圆圈选择器 =====================
  function buildSelectors() {
    ['entry-scene-row', 'end-scene-row'].forEach(rowId => {
      const row = $(rowId);
      if (!row) return;
      row.innerHTML = '';
      Z.SCENES.forEach(s => {
        const btn = document.createElement('button');
        btn.className = 'scene-thumb-btn';
        btn.dataset.scene = s.id;

        // 兜底渐变层（图片加载前显示）
        const grad = document.createElement('span');
        grad.className = 'thumb-grad';
        grad.style.background = s.gradient;

        // 静态图片层（使用预设缩略图，非视频截帧）
        const img = document.createElement('span');
        img.className = 'thumb-img is-ready';
        img.dataset.scene = s.id;
        img.style.backgroundImage = `url(assets/img/${s.id}.jpg)`;

        btn.appendChild(grad);
        btn.appendChild(img);
        btn.addEventListener('click', e => { e.stopPropagation(); selectScene(s.id); });
        row.appendChild(btn);
      });
    });

    ['entry-dur-row', 'end-dur-row'].forEach(rowId => {
      const row = $(rowId);
      if (!row) return;
      row.innerHTML = '';
      Z.DURATIONS.forEach(d => {
        const pill = document.createElement('button');
        pill.className = 'dur-pill-inline';
        pill.dataset.dur = d.id;
        pill.textContent = d.label;
        pill.addEventListener('click', e => { e.stopPropagation(); selectDur(d.id); });
        row.appendChild(pill);
      });
    });
  }

  function syncAllSelectors() {
    document.querySelectorAll('.scene-thumb-btn').forEach(b => {
      b.classList.toggle('is-selected', b.dataset.scene === curScene.id);
    });
    document.querySelectorAll('.dur-pill-inline').forEach(p => {
      p.classList.toggle('is-selected', p.dataset.dur === curDur.id);
    });
  }

  function selectScene(id) { curScene = Z.getScene(id); syncAllSelectors(); }
  function selectDur(id)   { curDur = Z.getDuration(id); syncAllSelectors(); }

  // ===================== 事件绑定 =====================
  function bind() {
    $('screen-entry').addEventListener('click', e => {
      if (e.target.closest('button')) return;
      activeStage = 'entry';
      beginJourney();
    });
    $('screen-end').addEventListener('click', e => {
      if (e.target.closest('button')) return;
      activeStage = 'end';
      beginJourney();
    });
    $('exit-btn').addEventListener('click', endEarly);
  }

  // ===================== 进入旅程 =====================
  function beginJourney() {
    if (isTransitioning) return;
    isTransitioning = true;

    // ① 第一时间清空上次冥想的所有残留（台词/计时器/位置信息）
    window.ZenSession.reset();

    window.ZenAudio.unlock();
    window.ZenAudio.stopWind();   // 风声淡出

    const screenId = activeStage === 'entry' ? 'screen-entry' : 'screen-end';
    const screen = $(screenId);

    // 设置位置信息（在冥想屏激活前就准备好）
    $('loc-name').textContent = curScene.name;
    $('loc-time').textContent = curScene.fixedTime;
    $('loc-story').textContent = curScene.timeStory;

    // 激活场景视频（无需换 src/load，直接 play）
    activateSceneVideo();

    // 标记当前场景（用于场景专属样式，如森林场景底部文案可读性）
    $('screen-meditation').dataset.scene = curScene.id;

    // ① 入口/结束屏淡出 + 视频微放大
    screen.classList.add('is-leaving');

    // ② 0.3s 后冥想屏激活
    setTimeout(() => {
      $('screen-meditation').classList.add('is-active');
    }, 300);

    // ③ 2.0s 后启动冥想会话 + 加载场景音频 + 音频淡入
    setTimeout(() => {
      // 先加载场景音频（真实音频或合成兜底），再淡入音量
      window.ZenAudio.loadScene(curScene).then(() => {
        window.ZenAudio.fadeIn(3.5);
      });
      window.ZenSession.start(curScene, curDur, res => journeyComplete(res));
    }, 2000);

    // ④ 2.5s 后清理入口/结束屏状态
    setTimeout(() => {
      screen.classList.remove('is-active', 'is-leaving');
      isTransitioning = false;
    }, 2500);
  }

  // ---- 激活场景视频（视频元素池方案：无需换 src/load，直接 play）----
  function activateSceneVideo() {
    // 暂停上一个场景视频
    if (activeSceneVideo) {
      activeSceneVideo.pause();
      activeSceneVideo.classList.remove('is-active', 'is-stalled');
    }

    // 找到当前场景的视频元素
    const v = document.querySelector(`.scene-video[data-scene="${curScene.id}"]`);
    if (v) {
      v.classList.remove('is-stalled');
      v.muted = true;
      v.play().catch(() => {});
      v.classList.add('is-active');
      activeSceneVideo = v;

      // 仅当视频尚未就绪时才启动 canvas 兜底
      // 视频已预加载完毕（canplaythrough），通常 readyState >= 3，不需要 canvas
      if (v.readyState < 3) {
        window.ZenVisuals.start(curScene);
      }
    } else {
      // 无视频元素 → 纯 canvas 兜底
      window.ZenVisuals.start(curScene);
    }
  }

  // ===================== 结束旅程 =====================
  function endEarly() {
    if (isTransitioning) return;
    isTransitioning = true;
    window.ZenSession.stopEarly();
    window.ZenAudio.fadeOut(1.5);
    setTimeout(() => {
      isTransitioning = false;
      journeyComplete({ scene: curScene, duration: curDur, early: true });
    }, 1200);
  }

  function journeyComplete(res) {
    if (isTransitioning) return;
    isTransitioning = true;

    window.ZenAudio.fadeOut(2.0);

    const endScreen = $('screen-end');
    syncAllSelectors();

    // ① 结束屏出现，视频微放大状态
    endScreen.classList.add('is-active', 'is-returning');
    const epv = $('end-plane-video');
    if (epv) epv.play().catch(() => {});

    // ② 1.2s 后：冥想屏淡出 + 清理冥想媒体 + 风声渐入
    setTimeout(() => {
      $('screen-meditation').classList.remove('is-active');
      window.ZenAudio.stop();
      window.ZenVisuals.stop();
      // 暂停场景视频（保留 src 和缓冲，下次直接 play）
      if (activeSceneVideo) {
        activeSceneVideo.pause();
        activeSceneVideo.classList.remove('is-active', 'is-stalled');
      }
      endScreen.classList.remove('is-returning');
      // 风声渐入 — 飞行界面环境音
      window.ZenAudio.startWind();
    }, 1200);

    // ③ 3.0s 后：完全清理
    setTimeout(() => {
      activeStage = 'end';
      isTransitioning = false;
    }, 3000);
  }

  return { init };
})();

// bfcache 恢复时重新加载，避免显示上次残留状态（语录/进度条等）
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

document.addEventListener('DOMContentLoaded', window.ZenApp.init);
