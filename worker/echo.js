/* ========================================================================
   Zen Time · Cloudflare Worker — API 代理
   路由：
   - POST /echo : LLM 回响代理（DeepSeek / OpenAI 兼容格式）
   - POST /mail : 冥想日记邮件直发（SMTP，默认 163 邮箱，兼容 QQ 等）

   部署步骤：
   1. 注册 Cloudflare 账号 → Workers & Pages → 创建 Worker
   2. 将本文件内容粘贴到 Worker 编辑器
   3. 在 Settings → Variables and Secrets 中添加（类型选 Secret）：
      DEEPSEEK_API_KEY = sk-xxxxxxxxxxxxxxxxxxxxxxxx      （回响功能用，可选）
      SMTP_USER        = yourname@163.com                  （发件邮箱）
      SMTP_PASS        = 163邮箱SMTP授权码（不是登录密码！）
      SMTP_HOST        = smtp.163.com                      （可选，默认 163）
      SMTP_PORT        = 465                               （可选，默认 465 SSL）

   常用邮箱 SMTP 地址：
      163 / 126 邮箱 : smtp.163.com / smtp.126.com（授权码即时可得，无账号年龄限制）
      QQ 邮箱        : smtp.qq.com（需注册满14天才能开启SMTP）
      Gmail          : smtp.gmail.com（需应用专用密码）

   163 邮箱授权码获取：mail.163.com → 设置 → POP3/SMTP/IMAP →
      开启 SMTP 服务 → 新增授权密码（手机验证后立即显示）

   4. 保存后复制 Worker URL
   5. 在 js/journal.js 中设置：
      LLM_ENDPOINT = 'https://your-worker.workers.dev/echo'
      MAIL_ENDPOINT = 'https://your-worker.workers.dev/mail'
   ======================================================================== */

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL   = 'deepseek-chat';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const url = new URL(request.url);
    if (url.pathname === '/mail') return handleMail(request, env);
    return handleEcho(request, env); // 默认 /echo
  }
};

/* ============================ /echo · LLM 回响 ============================ */

async function handleEcho(request, env) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return json({ error: 'API key not configured' }, 500);

  try {
    const { messages, max_tokens, temperature } = await request.json();
    const llmResponse = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: max_tokens || 200,
        temperature: temperature || 0.7
      })
    });
    const data = await llmResponse.json();
    return new Response(JSON.stringify(data), {
      status: llmResponse.status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  } catch (e) {
    return json({ error: 'LLM request failed', message: e.message }, 500);
  }
}

/* ============================ /mail · SMTP 直发（163/QQ 通用） ============================ */

async function handleMail(request, env) {
  const smtpUser = env.SMTP_USER;
  const smtpPass = env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    return json({ error: 'SMTP not configured' }, 500);
  }

  try {
    const { to, subject, body } = await request.json();

    // 基本校验
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return json({ error: 'invalid recipient' }, 400);
    }
    if (!body || typeof body !== 'string' || body.length > 20000) {
      return json({ error: 'invalid body' }, 400);
    }

    // 收件人只允许发给自己填的地址；防注入：去掉换行
    const safeTo = to.replace(/[\r\n]/g, '');
    const safeSubject = (subject || 'Zen Time · 冥想日记').replace(/[\r\n]/g, '').slice(0, 100);

    await smtpSend({
      host: env.SMTP_HOST || 'smtp.163.com',
      port: parseInt(env.SMTP_PORT, 10) || 465,
      from: smtpUser,
      pass: smtpPass,
      to: safeTo,
      subject: safeSubject,
      body
    });

    return json({ ok: true });
  } catch (e) {
    return json({ error: 'mail failed', message: e.message }, 500);
  }
}

/* ---------- 极简 SMTP 客户端（465 隐式 TLS 直连，兼容 163/QQ 等） ---------- */

import { connect } from 'cloudflare:sockets';

function utf8b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// base64 正文按 76 字符折行（MIME 规范）
function wrap76(s) {
  return s.replace(/(.{76})/g, '$1\r\n');
}

async function smtpSend({ host, port, from, pass, to, subject, body }) {
  const socket = connect(
    { hostname: host, port: port },
    { secureTransport: 'on' } // 465 端口为隐式 TLS
  );
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = '';

  // 读取 SMTP 应答（支持多行，如 250-... 250 OK）
  async function readReply() {
    for (;;) {
      const m = buf.match(/^(\d{3})[ ]([^\r\n]*)\r\n/);
      if (m) {
        buf = buf.slice(m[0].length);
        return { code: parseInt(m[1], 10), text: m[2] };
      }
      const cont = buf.match(/^(\d{3})-([^\r\n]*)\r\n/); // 多行续行
      if (!cont) {
        const { done, value } = await reader.read();
        if (done) throw new Error('SMTP 连接中断');
        buf += decoder.decode(value, { stream: true });
      } else {
        buf = buf.slice(cont[0].length);
      }
    }
  }

  async function expect(cmdStr, okCode) {
    if (cmdStr !== null) await writer.write(encoder.encode(cmdStr + '\r\n'));
    const r = await readReply();
    if (r.code >= 400) throw new Error('SMTP ' + r.code + ' ' + r.text);
    return r;
  }

  try {
    await expect(null, 220);                          // 服务器问候
    await expect('EHLO zen-time.workers.dev', 250);   // 握手（FQDN，兼容网易系严格校验）
    await expect('AUTH LOGIN', 334);
    await expect(utf8b64(from), 334);
    await expect(utf8b64(pass), 235);
    await expect('MAIL FROM:<' + from + '>', 250);
    await expect('RCPT TO:<' + to + '>', 250);
    await expect('DATA', 354);

    const headers = [
      'From: Zen Time <' + from + '>',
      'To: <' + to + '>',
      'Subject: =?UTF-8?B?' + utf8b64(subject) + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      ''
    ].join('\r\n');

    const payload = headers + '\r\n' + wrap76(utf8b64(body)) + '\r\n.\r\n';
    await writer.write(encoder.encode(payload));
    const r = await readReply();
    if (r.code >= 400) throw new Error('SMTP DATA ' + r.code + ' ' + r.text);

    await expect('QUIT', 221);
  } finally {
    try { writer.releaseLock(); reader.releaseLock(); socket.close(); } catch (e) {}
  }
}
