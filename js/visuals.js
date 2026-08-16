/* ========================================================================
   Zen Time · 画面兜底
   真实视频加载失败时，用 Canvas 程序化生成各场景动态画面。
   海：层层波浪 · 林：光束与孢子飘浮 · 雪：飘雪 · 沙：流沙与沙脊
   ======================================================================== */

window.ZenVisuals = (function () {
  const canvas = document.getElementById('bg-canvas');
  const ctx = canvas ? canvas.getContext('2d') : null;
  let raf = null;
  let current = null;       // 当前场景对象
  let running = false;
  let t = 0;                // 全局时间帧
  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // ---- 粒子池 ----
  let particles = [];
  function initParticles(kind) {
    particles = [];
    const n = kind === 'snow' ? 90 : kind === 'forest' ? 60 : kind === 'sand' ? 80 : 40;
    for (let i = 0; i < n; i++) {
      particles.push({
        x: Math.random(), y: Math.random(),
        r: 0.6 + Math.random() * 2.2,
        s: 0.2 + Math.random() * 0.8,   // 速度系数
        a: 0.3 + Math.random() * 0.6,   // 透明度
        drift: (Math.random() - 0.5) * 0.4
      });
    }
  }

  // ===================== 各场景绘制 =====================

  // 海：多层正弦波浪 + 远处水光
  function drawSea() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1d4654');
    g.addColorStop(0.5, '#2d6577');
    g.addColorStop(1, '#0f3340');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // 远处水光
    const sun = ctx.createRadialGradient(W * 0.5, H * 0.32, 0, W * 0.5, H * 0.32, H * 0.5);
    sun.addColorStop(0, 'rgba(230,240,245,0.35)');
    sun.addColorStop(1, 'rgba(230,240,245,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, W, H);

    // 波浪层
    const waves = [
      { y: 0.55, amp: 14, len: 0.012, sp: 0.6, c: 'rgba(180,210,220,0.35)' },
      { y: 0.64, amp: 20, len: 0.009, sp: 0.4, c: 'rgba(140,180,195,0.4)' },
      { y: 0.74, amp: 28, len: 0.007, sp: 0.3, c: 'rgba(90,140,160,0.5)' },
      { y: 0.86, amp: 36, len: 0.005, sp: 0.2, c: 'rgba(40,90,110,0.7)' }
    ];
    waves.forEach(w => {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 6) {
        const y = H * w.y + Math.sin(x * w.len + t * w.sp * 0.03) * w.amp;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.closePath();
      ctx.fillStyle = w.c; ctx.fill();
    });
  }

  // 林：竖向光束 + 孢子飘浮
  function drawForest() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#16280f');
    g.addColorStop(0.6, '#213d1c');
    g.addColorStop(1, '#0d1a09');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // 光束
    for (let i = 0; i < 5; i++) {
      const cx = W * (0.18 + i * 0.16) + Math.sin(t * 0.002 + i) * 20;
      const beam = ctx.createLinearGradient(cx, 0, cx + 30, H);
      beam.addColorStop(0, 'rgba(220,235,180,0.18)');
      beam.addColorStop(1, 'rgba(220,235,180,0)');
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(cx - 14, 0); ctx.lineTo(cx + 14, 0);
      ctx.lineTo(cx + 60, H); ctx.lineTo(cx - 60, H);
      ctx.closePath(); ctx.fill();
    }

    // 孢子
    particles.forEach(p => {
      const px = p.x * W + Math.sin(t * 0.01 + p.x * 20) * p.drift * W * 0.05;
      const py = ((p.y - t * 0.0004 * p.s) % 1 + 1) % 1 * H;
      ctx.beginPath();
      ctx.arc(px, py, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200,230,170,${p.a * 0.5})`;
      ctx.fill();
    });
  }

  // 极光：绿色光帘起伏 + 星点 + 墨夜
  function drawSnow() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#04120c');
    g.addColorStop(0.45, '#07201a');
    g.addColorStop(1, '#0a2a26');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // 星点（用粒子静态闪烁）
    particles.forEach(p => {
      const px = p.x * W;
      const py = p.y * H * 0.6;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 0.02 + p.x * 40));
      ctx.beginPath();
      ctx.arc(px, py, p.r * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220,235,245,${p.a * tw * 0.7})`;
      ctx.fill();
    });

    // 地平线微光
    const horizon = ctx.createRadialGradient(W * 0.5, H * 0.7, 0, W * 0.5, H * 0.7, W * 0.7);
    horizon.addColorStop(0, 'rgba(20,90,70,0.28)');
    horizon.addColorStop(1, 'rgba(20,90,70,0)');
    ctx.fillStyle = horizon; ctx.fillRect(0, 0, W, H);

    // 极光光帘：几道竖向波浪光带
    const curtains = [
      { cx: 0.30, w: 0.34, hue: [40, 230, 160], amp: 60, sp: 0.6, op: 0.22 },
      { cx: 0.52, w: 0.40, hue: [60, 210, 150], amp: 80, sp: 0.45, op: 0.28 },
      { cx: 0.72, w: 0.30, hue: [80, 200, 140], amp: 50, sp: 0.7, op: 0.20 }
    ];
    curtains.forEach((c, i) => {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const x0 = W * (c.cx - c.w / 2);
      const x1 = W * (c.cx + c.w / 2);
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, `rgba(${c.hue[0]},${c.hue[1]},${c.hue[2]},${c.op})`);
      grad.addColorStop(0.55, `rgba(${c.hue[0]},${c.hue[1]-20},${c.hue[2]-20},${c.op*0.5})`);
      grad.addColorStop(1, `rgba(${c.hue[0]},${c.hue[1]-40},${c.hue[2]-40},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      const seg = 16;
      for (let s = 0; s <= seg; s++) {
        const yy = (s / seg) * H;
        const wave = Math.sin(t * 0.01 * c.sp + s * 0.6 + i) * c.amp;
        ctx.lineTo(x0 + wave, yy);
      }
      for (let s = seg; s >= 0; s--) {
        const yy = (s / seg) * H;
        const wave = Math.sin(t * 0.01 * c.sp + s * 0.6 + i + 1.4) * c.amp;
        ctx.lineTo(x1 + wave, yy);
      }
      ctx.closePath();
      ctx.filter = 'blur(14px)';
      ctx.fill();
      ctx.restore();
    });
  }

  // 沙：流沙 + 沙脊 + 暖色
  function drawSand() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#caa063');
    g.addColorStop(0.45, '#9c6b3a');
    g.addColorStop(1, '#5e3a1e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // 天光
    const sky = ctx.createRadialGradient(W * 0.7, H * 0.18, 0, W * 0.7, H * 0.18, W * 0.7);
    sky.addColorStop(0, 'rgba(255,240,210,0.4)');
    sky.addColorStop(1, 'rgba(255,240,210,0)');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    // 沙脊（远到近）
    const dunes = [
      { y: 0.62, amp: 22, len: 0.004, c: 'rgba(190,150,95,0.55)' },
      { y: 0.74, amp: 30, len: 0.0035, c: 'rgba(160,120,70,0.7)' },
      { y: 0.88, amp: 40, len: 0.003, c: 'rgba(120,85,45,0.9)' }
    ];
    dunes.forEach(d => {
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 8) {
        const y = H * d.y + Math.sin(x * d.len + t * 0.01) * d.amp;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.closePath();
      ctx.fillStyle = d.c; ctx.fill();
    });

    // 流沙颗粒
    particles.forEach(p => {
      const px = (p.x * W + t * 0.4 * p.s) % W;
      const py = p.y * H + Math.sin(t * 0.01 + p.x * 40) * 6;
      ctx.beginPath();
      ctx.arc(px, py, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,235,200,${p.a * 0.4})`;
      ctx.fill();
    });
  }

  const drawers = { sea: drawSea, forest: drawForest, snow: drawSnow, sand: drawSand };

  function loop() {
    if (!running) return;
    t += 1;
    if (current && drawers[current.id]) drawers[current.id]();
    raf = requestAnimationFrame(loop);
  }

  // ---- 启动某场景的兜底画面 ----
  function start(scene) {
    if (!ctx) return;
    current = scene;
    resize();
    initParticles(scene.id);
    canvas.classList.add('is-active');
    if (!running) { running = true; loop(); }
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (canvas) canvas.classList.remove('is-active');
  }

  window.addEventListener('resize', () => { if (running) resize(); });

  return { start, stop, canvas };
})();
