/* ========================================================================
   Zen Time · 冥想日记
   反思输入页 · 日记列表页 · AI回响
   用户创造资产，AI照亮资产
   ======================================================================== */

window.ZenJournal = (function () {
  const STORAGE_KEY = 'zen_journal_entries';

  // Cloudflare Worker 地址
  // 注意：workers.dev 域名在中国大陆部分网络不可达，
  // 所有请求均带超时保护，超时或失败时自动回退到本地体验，不影响使用
  var WORKER_BASE = 'https://zen-time.zentimeofficial.workers.dev';

  // LLM API 代理地址（Worker /echo 路由）
  // 不可用时使用本地回退（基于模板的回响生成，无需 API）
  const LLM_ENDPOINT = WORKER_BASE + '/echo';

  // 邮件直发代理地址（Worker /mail 路由）
  // 不可用时回退到 mailto（拉起用户本地邮件客户端）
  const MAIL_ENDPOINT = WORKER_BASE + '/mail';

  // 带超时的 fetch：网络不可达时快速失败，触发回退
  function fetchWithTimeout(url, options, timeoutMs) {
    timeoutMs = timeoutMs || 9000;
    if (typeof AbortController === 'function') {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      options = options || {};
      options.signal = ctrl.signal;
      return fetch(url, options).then(function (res) {
        clearTimeout(timer);
        return res;
      }, function (err) {
        clearTimeout(timer);
        throw err;
      });
    }
    return fetch(url, options);
  }

  // ---- 场景名称映射（用于日记显示和回响生成）----
  const SCENE_NAMES = {
    sea:    '冲绳海',
    forest: '屋久島森林',
    snow:   '特罗姆瑟',
    sand:   '纳米布沙漠'
  };

  // ---- 危机关键词 ----
  const CRISIS_KEYWORDS = [
    '自杀', '不想活', '想死', '活不下去',
    '了结自己', '不想活着', '寻短', '解脱算了'
  ];
  const CRISIS_HOTLINE = '如果你正在经历困难，可以拨打心理援助热线 400-161-9995';

  // ---- 兜底文案 ----
  const FALLBACK_ECHO = '你的记录已保存。每次停下来，都是对自己的善意。';

  // ---- LLM 系统提示词 ----
  const SYSTEM_PROMPT =
    '你是一位安静的倾听者。用户是一位冥想练习者，你会看到他们最近的冥想记录，' +
    '其中"文字"字段是他们冥想后亲笔写下的感受。\n\n' +
    '你的任务：像一位老朋友翻完这些日记后，轻声说出的观察。\n\n' +
    '最重要的规则：\n' +
    '- 必须直接回应他们写下的文字本身：引用或转述他们的用词（如：你写到"很累"），' +
    '并留意感受之间的呼应与变化（如："累"出现过两次，而这次你写了"松了口气"）\n' +
    '- 严禁只做时间、场景、次数的流水账式总结。' +
    '像"你在深夜冥想了5分钟并留下了感受"这样不触及文字内容的回答是不合格的\n' +
    '- 只做观察和映照，不给建议、诊断、评判\n' +
    '- 不使用"你应该""你需要""试试"等指导性语言\n' +
    '- 语气温柔、克制，像在轻声自语\n' +
    '- 100字以内，2到3句\n' +
    '- 如果所有记录都没有文字，才从冥想时间、场景选择、频率等隐式信号做观察';

  const $ = id => document.getElementById(id);

  // ===================== 记录管理 =====================
  function getRecords() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function getRecentRecords(n) {
    n = n || 5;
    return getRecords().slice(0, n);
  }

  function saveRecord(scene, duration, text) {
    var records = getRecords();
    var entry = {
      timestamp: Date.now(),
      sceneId:   scene.id,
      sceneName: scene.name,
      duration:  duration.minutes,
      text:      text || null
    };
    records.unshift(entry);
    if (records.length > 200) records.length = 200;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch (e) {
      // localStorage 满或不可用，静默失败
    }
    return entry;
  }

  // ===================== 隐式信号采集 =====================
  function collectImplicitContext(scene, duration) {
    var now = new Date();
    var hour = now.getHours();
    var timeOfDay;
    if (hour < 6)       timeOfDay = '深夜';
    else if (hour < 12) timeOfDay = '清晨';
    else if (hour < 18) timeOfDay = '白天';
    else                timeOfDay = '夜晚';

    var isDark  = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isMobile = window.innerWidth < 768;

    var records = getRecords();
    var sessionCount  = records.length + 1;
    var daysSinceLast = records.length > 0
      ? Math.floor((Date.now() - records[0].timestamp) / 86400000)
      : null;

    // 场景偏好统计
    var sceneCount = {};
    records.forEach(function (r) {
      sceneCount[r.sceneId] = (sceneCount[r.sceneId] || 0) + 1;
    });
    sceneCount[scene.id] = (sceneCount[scene.id] || 0) + 1;
    var topScene = Object.keys(sceneCount)
      .sort(function (a, b) { return sceneCount[b] - sceneCount[a]; })[0];

    return {
      timeOfDay:    timeOfDay,
      hour:         hour,
      weekday:      ['日','一','二','三','四','五','六'][now.getDay()],
      isDark:       isDark,
      isMobile:     isMobile,
      sessionCount: sessionCount,
      daysSinceLast: daysSinceLast,
      sceneName:    SCENE_NAMES[scene.id] || scene.name,
      topScene:     topScene ? SCENE_NAMES[topScene] : null,
      duration:     duration.minutes
    };
  }

  // ===================== 危机关键词扫描 =====================
  function scanCrisis(text) {
    if (!text) return false;
    return CRISIS_KEYWORDS.some(function (kw) {
      return text.indexOf(kw) >= 0;
    });
  }

  // ===================== LLM 回响生成 =====================
  async function generateEcho(records) {
    if (!records || records.length === 0) return FALLBACK_ECHO;

    // 构建发送给 LLM 的数据
    var llmData = records.map(function (r) {
      return {
        time: new Date(r.timestamp).toLocaleString('zh-CN', {
          month: 'numeric', day: 'numeric',
          hour: '2-digit', minute: '2-digit'
        }),
        scene:    SCENE_NAMES[r.sceneId] || r.sceneName,
        duration: r.duration,
        text:     r.text || null
      };
    });

    var hasText = records.some(function (r) { return r.text; });

    var userPrompt =
      '以下是用户最近的' + records.length + '条冥想记录（JSON格式，"text"是他们写下的感受原文）：\n' +
      JSON.stringify(llmData, null, 2) + '\n\n' +
      (hasText
        ? '请围绕他们文字里的具体感受来回应：引用他们的用词，指出感受之间的呼应、重复或变化。' +
          '不要停留在时间、场景、次数这些表层信息上。'
        : '用户没有留下文字，请从冥想时间、场景选择、频率等隐式信号做观察。') +
      '\n\n请生成一段100字以内的观察。';

    // 尝试调用 LLM API
    if (LLM_ENDPOINT) {
      // 先探测可达性（5秒）：网络不可达时立即走本地回退，不让用户干等
      var reachable = await probeWorker();
      if (reachable) {
        try {
          var response = await fetchWithTimeout(LLM_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user',   content: userPrompt }
              ],
              max_tokens:  300,
              temperature: 0.7
            })
          }, 45000);

          if (!response.ok) throw new Error('LLM request failed');
          var data = await response.json();
          var echo = (data.choices && data.choices[0] && data.choices[0].message &&
                       data.choices[0].message.content && data.choices[0].message.content.trim())
                     || FALLBACK_ECHO;

          // 危机关键词后处理（客户端硬编码，不依赖 LLM 判断）
          var hasCrisis = records.some(function (r) { return scanCrisis(r.text); });
          if (hasCrisis) echo += '\n\n' + CRISIS_HOTLINE;

          return echo;
        } catch (e) {
          // 回退到本地生成
          return generateLocalEcho(records);
        }
      }
    }
    // 无 API 配置或网络不可达，使用本地回退
    return generateLocalEcho(records);
  }

  // 探测 Worker 是否可达：GET /echo 会立刻返回 405（Worker 只接受 POST），
  // 能收到任何 HTTP 响应（包括405）就说明网络通；超时/网络错误则不可达
  async function probeWorker() {
    try {
      await fetchWithTimeout(LLM_ENDPOINT, { method: 'GET' }, 5000);
      return true;  // 收到了响应（可能是405/500，但网络是通的）
    } catch (e) {
      return false; // 超时或网络不可达
    }
  }

  // ===================== 本地回退回响（无 API 时使用）=====================
  function generateLocalEcho(records) {
    if (!records || records.length === 0) return FALLBACK_ECHO;

    var latest    = records[0];
    var latestDate = new Date(latest.timestamp);
    var hour      = latestDate.getHours();
    var timeOfDay = hour < 6 ? '深夜' : hour < 12 ? '清晨' : hour < 18 ? '白天' : '夜晚';

    // 场景偏好统计
    var sceneCount = {};
    records.forEach(function (r) {
      sceneCount[r.sceneId] = (sceneCount[r.sceneId] || 0) + 1;
    });
    var topSceneKey = Object.keys(sceneCount)
      .sort(function (a, b) { return sceneCount[b] - sceneCount[a]; })[0];
    var topSceneName = SCENE_NAMES[topSceneKey] || '冥想';

    // 文字分析
    var texts    = records.filter(function (r) { return r.text; }).map(function (r) { return r.text; });
    var hasText  = texts.length > 0;
    var hasCrisis = records.some(function (r) { return scanCrisis(r.text); });

    var echo;

    // 情感词库（本地回退用）
    // 全部 2 字及以上，避免“好”之类的单字在复合词里被误命中
    var POS_WORDS = ['平静','放松','安心','温暖','柔软','释然','舒服','踏实','欢喜','感激','舒展','宁静','松弛'];
    var NEG_WORDS = ['焦虑','紧张','疲惫','疲倦','失眠','害怕','恐惧','压力','崩溃','哭泣','难过','低落','委屈','烦闷','孤单','孤独','无力','沉重','难受','心烦','慌张','慌乱','烦恼','委屈','愤怒','痛苦','苦涩','迷茫'];
    // 否定前缀：若情感词前面有这些字，表示被否定（如"不害怕""没压力"），跳过
    var NEG_BEFORE = new Set(['不','没','别','莫','无','非','勿','毋','否']);

    function findEmotion(text, wordList) {
      var hit = null;
      for (var i = 0; i < wordList.length; i++) {
        var w = wordList[i];
        var idx = -1;
        while ((idx = text.indexOf(w, idx + 1)) >= 0) {
          var prev = idx > 0 ? text[idx - 1] : '';
          if (NEG_BEFORE.has(prev)) continue; // 被否定，跳过
          return w; // 找到第一个未被否定的
        }
      }
      return hit;
    }
    function fragment(text, max) {
      var t = (text || '').trim();
      max = max || 18;
      return t.length > max ? t.slice(0, max) + '…' : t;
    }

    if (records.length === 1) {
      // 只有一条记录
      if (hasText) {
        var t1   = (latest.text || '').trim();
        var wPos = findEmotion(t1, POS_WORDS);
        var wNeg = findEmotion(t1, NEG_WORDS);
        var w1   = wPos || wNeg;
        echo = w1
          ? timeOfDay + '，你写下了“' + w1 + '”。这是第一条记录，从这里开始，慢慢来。'
          : timeOfDay + '，你写下「' + fragment(t1, 14) + '」。这是第一条记录，从这里开始，慢慢来。';
      } else {
        echo = timeOfDay + '，你给了自己' + latest.duration + '分钟的安静。';
      }
    } else {
      // 多条记录
      if (!hasText) {
        // 无文字 — 从隐式信号生成
        var allLateNight = records.every(function (r) {
          var h = new Date(r.timestamp).getHours();
          return h < 6 || h >= 23;
        });
        if (allLateNight && records.length > 1) {
          echo = '这' + records.length + '次冥想都在深夜——也许夜晚是你最需要停下来的时刻。' +
                 '你最常选择' + topSceneName + '。';
        } else {
          echo = '你已经冥想了' + records.length + '次，最常选择' + topSceneName +
                 '。每次停下来，都是对自己的善意。';
        }
      } else {
        // 有文字 — 围绕文字本身：引用用词，感受之间的呼应与变化
        var latestText = (latest.text || '').trim();
        var prevTexts  = texts.slice(1).join('');

        var curNeg = findEmotion(latestText, NEG_WORDS);
        var curPos = findEmotion(latestText, POS_WORDS);
        var prevNeg = prevTexts ? findEmotion(prevTexts, NEG_WORDS) : null;
        var prevPos = prevTexts ? findEmotion(prevTexts, POS_WORDS) : null;

        if (curNeg && prevNeg === curNeg) {
          echo = '“' + curNeg + '”又一次出现在你的字里——它也许值得被多看一眼。';
        } else if (curNeg && prevPos && !prevNeg) {
          echo = '之前你写过“' + prevPos + '”，这次写下了“' + curNeg + '”。感受有起有落，都是被允许的。';
        } else if (curPos && prevNeg) {
          echo = '之前你写过“' + prevNeg + '”，而这次是“' + curPos + '”。有什么正在慢慢变化。';
        } else if (curPos || curNeg) {
          var w = curPos || curNeg;
          echo = '你写下了“' + w + '”。这' + records.length + '次冥想里，你一直诚实地看着自己。';
        } else {
          echo = '你最近写下「' + fragment(latestText, 18) + '」——这些字被好好收着了。';
        }
      }
    }

    // 危机后处理
    if (hasCrisis) {
      echo += '\n\n' + CRISIS_HOTLINE;
    }

    return echo;
  }

  // ===================== 反思输入页 =====================
  var reflectIdleTimer = null;
  var reflectActive    = false;
  var reflectFinished  = false;
  var reflectCallbacks  = null;

  function showReflectPage(scene, duration, onComplete) {
    var screen  = $('screen-reflect');
    var input   = $('reflect-input');
    var doneBtn = $('reflect-done');
    var cursor  = screen ? screen.querySelector('.reflect-cursor') : null;
    var wrap    = screen ? screen.querySelector('.reflect-input-wrap') : null;

    // 重置状态
    reflectActive = false;
    reflectFinished = false;
    reflectCallbacks = { scene: scene, duration: duration, onComplete: onComplete };

    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }
    if (doneBtn) doneBtn.classList.remove('is-visible');
    if (cursor) cursor.classList.add('is-blinking');

    // 7秒空闲计时（含 UI 淡入时间 ~2s，用户有约 5s 决定）
    if (reflectIdleTimer) clearTimeout(reflectIdleTimer);
    reflectIdleTimer = setTimeout(function () {
      if (!reflectActive) {
        finishReflect(null);
      }
    }, 7000);

    // 绑定输入区域点击 → 聚焦 textarea
    if (wrap) {
      wrap.addEventListener('click', onWrapClick);
    }
    if (input) {
      input.addEventListener('focus', onReflectFocus);
      input.addEventListener('input', onReflectInput);
    }
    if (doneBtn) {
      doneBtn.addEventListener('click', onDoneClick);
    }
  }

  function onWrapClick() {
    var input = $('reflect-input');
    if (input && !reflectActive) input.focus();
  }

  function onReflectFocus() {
    if (reflectActive) return;
    reflectActive = true;

    // 取消空闲计时
    if (reflectIdleTimer) {
      clearTimeout(reflectIdleTimer);
      reflectIdleTimer = null;
    }

    // 显示完成按钮
    var doneBtn = $('reflect-done');
    if (doneBtn) doneBtn.classList.add('is-visible');

    // 隐藏模拟光标（textarea 有自己的光标）
    var cursor = document.querySelector('.reflect-cursor');
    if (cursor) cursor.classList.remove('is-blinking');
  }

  function onReflectInput() {
    if (!reflectActive) onReflectFocus();

    // textarea 自适应高度
    var input = $('reflect-input');
    if (input) {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }
  }

  function onDoneClick() {
    var input = $('reflect-input');
    var text = input ? input.value.trim() : '';
    finishReflect(text || null);
  }

  function finishReflect(text) {
    // 防止竞态：空闲计时器和完成按钮可能同时触发
    if (reflectFinished) return;
    reflectFinished = true;

    // 清理
    if (reflectIdleTimer) {
      clearTimeout(reflectIdleTimer);
      reflectIdleTimer = null;
    }

    var input = $('reflect-input');
    var wrap  = document.querySelector('.reflect-input-wrap');
    var doneBtn = $('reflect-done');
    if (input) {
      input.removeEventListener('focus', onReflectFocus);
      input.removeEventListener('input', onReflectInput);
      input.blur();
    }
    if (wrap) wrap.removeEventListener('click', onWrapClick);
    if (doneBtn) doneBtn.removeEventListener('click', onDoneClick);

    // 保存记录
    if (reflectCallbacks) {
      saveRecord(reflectCallbacks.scene, reflectCallbacks.duration, text);
    }

    // 淡出反思页
    var screen = $('screen-reflect');
    if (screen) {
      screen.classList.add('is-leaving');
      var cb = reflectCallbacks ? reflectCallbacks.onComplete : null;
      reflectCallbacks = null;
      setTimeout(function () {
        screen.classList.remove('is-active', 'is-leaving');
        if (cb) cb();
      }, 1500);
    } else {
      var cb2 = reflectCallbacks ? reflectCallbacks.onComplete : null;
      reflectCallbacks = null;
      if (cb2) cb2();
    }
  }

  // ===================== 日记列表页 =====================
  async function showJournal() {
    var screen    = $('screen-journal');
    var listEl    = $('journal-list');
    var echoEl    = $('journal-echo');
    var loadingEl = $('journal-echo-loading');

    if (screen) screen.classList.add('is-active');

    // 渲染最近5条记录
    var records = getRecentRecords(5);
    renderJournalList(listEl, records);

    // 显示加载态，调用 LLM
    if (echoEl)    echoEl.style.display = 'none';
    if (loadingEl) loadingEl.style.display = 'flex';

    var echo = await generateEcho(records);

    // 显示回响
    if (loadingEl) loadingEl.style.display = 'none';
    if (echoEl) {
      // 支持 \n 换行
      echoEl.innerHTML = echo.split('\n').map(function (line) {
        return line.trim() ? '<span class="echo-line">' + escapeHtml(line) + '</span>' : '<br>';
      }).join('');
      echoEl.style.display = 'block';
      // 触发淡入
      echoEl.style.opacity = '0';
      requestAnimationFrame(function () {
        echoEl.style.opacity = '';
      });
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderJournalList(container, records) {
    if (!container) return;
    container.innerHTML = '';

    if (records.length === 0) {
      container.innerHTML =
        '<p class="journal-empty">还没有冥想记录。<br>完成一次冥想后，这里会留下你的痕迹。</p>';
      return;
    }

    records.forEach(function (r) {
      var item = document.createElement('div');
      item.className = 'journal-item';

      var date = new Date(r.timestamp);
      var dateStr = (date.getMonth() + 1) + '月' + date.getDate() + '日 ' +
                    String(date.getHours()).padStart(2, '0') + ':' +
                    String(date.getMinutes()).padStart(2, '0');
      var sceneName = SCENE_NAMES[r.sceneId] || r.sceneName || '冥想';

      item.innerHTML =
        '<div class="journal-item-meta">' +
          '<span class="journal-item-date">' + dateStr + '</span>' +
          '<span class="journal-item-scene">' + escapeHtml(sceneName) + ' · ' + r.duration + '分钟</span>' +
        '</div>' +
        '<p class="journal-item-text">' + (r.text ? escapeHtml(r.text) : '—') + '</p>';

      container.appendChild(item);
    });
  }

  function closeJournal() {
    var screen = $('screen-journal');
    if (screen) screen.classList.remove('is-active');
  }

  // ===================== 寄给自己（邮箱带走） =====================

  // 轻提示：短暂显示一行小字后淡去（不用 alert，避免打断感）
  var opStatusTimer = null;
  function showOpStatus(msg, sticky) {
    var el = $('journal-op-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-visible');
    if (opStatusTimer) clearTimeout(opStatusTimer);
    if (!sticky) {
      opStatusTimer = setTimeout(function () {
        el.classList.remove('is-visible');
      }, 4000);
    }
  }

  // 组装邮件正文（人类可读的日记文本）
  function buildMailContent() {
    var records = getRecords();
    var lines = ['你的冥想日记', ''];
    records.forEach(function (r) {
      var d = new Date(r.timestamp);
      var dateStr = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
                    String(d.getHours()).padStart(2, '0') + ':' +
                    String(d.getMinutes()).padStart(2, '0');
      lines.push(dateStr + ' · ' + (SCENE_NAMES[r.sceneId] || r.sceneName || '冥想') +
                 ' · ' + r.duration + '分钟');
      lines.push(r.text || '—');
      lines.push('');
    });
    lines.push('—— Zen Time');
    lines.push('这些感受只属于你。');
    return {
      subject: 'Zen Time · 冥想日记 · ' + new Date().toLocaleDateString('zh-CN'),
      body: lines.join('\n')
    };
  }

  // 点击"寄给自己"：展开邮箱输入行
  function onExportClick() {
    var records = getRecords();
    if (records.length === 0) {
      showOpStatus('日记还是空的，先留下一些字吧');
      return;
    }
    var row = $('journal-mail-row');
    var input = $('journal-mail-input');
    if (row) row.classList.add('is-open');
    if (input) {
      input.value = localStorage.getItem('zen_journal_mail') || '';
      setTimeout(function () { input.focus(); }, 350);
    }
  }

  // 点击"寄出"：经 Worker 直发（QQ邮箱 SMTP），无 Worker 则回退 mailto
  async function onMailSend() {
    var input = $('journal-mail-input');
    var to = input ? input.value.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      showOpStatus('邮箱好像没填对，再看一眼吧');
      return;
    }

    // 记住邮箱，下次免填
    try { localStorage.setItem('zen_journal_mail', to); } catch (e) {}

    var mail = buildMailContent();

    if (MAIL_ENDPOINT) {
      showOpStatus('正在寄出…', true);
      try {
        var res = await fetchWithTimeout(MAIL_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: to, subject: mail.subject, body: mail.body })
        }, 12000);
        if (!res.ok) throw new Error('mail failed');
        showOpStatus('已寄出，去邮箱看看吧（也许它躺在垃圾箱里）');
        closeMailRow();
      } catch (e) {
        // 直发通道不可达（网络阻断/超时），回退：拉起本地邮件客户端
        openMailto(to, mail);
        showOpStatus('直发通道没走通，已为你打开本地邮箱，把这封信寄给自己吧');
        closeMailRow();
      }
    } else {
      // 无直发配置：拉起本地邮件客户端
      openMailto(to, mail);
      showOpStatus('正在打开邮箱，把它寄给自己吧');
      closeMailRow();
    }
  }

  function openMailto(to, mail) {
    var mailto = 'mailto:' + encodeURIComponent(to) +
                 '?subject=' + encodeURIComponent(mail.subject) +
                 '&body=' + encodeURIComponent(mail.body);
    window.location.href = mailto;
  }

  function closeMailRow() {
    var row = $('journal-mail-row');
    if (row) row.classList.remove('is-open');
    var input = $('journal-mail-input');
    if (input) input.blur();
  }

  // ===================== 初始化 =====================
  function init() {
    var closeBtn = $('journal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', closeJournal);
    }

    var exportBtn = $('journal-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', onExportClick);

    var sendBtn = $('journal-mail-send');
    if (sendBtn) sendBtn.addEventListener('click', onMailSend);

    var mailInput = $('journal-mail-input');
    if (mailInput) {
      mailInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          onMailSend();
        }
      });
    }
  }

  return {
    init:            init,
    showReflectPage: showReflectPage,
    showJournal:     showJournal,
    closeJournal:    closeJournal,
    saveRecord:      saveRecord,
    getRecords:      getRecords,
    getRecentRecords: getRecentRecords
  };
})();
