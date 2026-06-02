/* assistant-widget.js — SENT. site assistant
 * A self-contained floating chat widget that answers visitor questions and
 * helps them navigate vxsent.com. Talks to POST /api/assistant. No build step,
 * no dependencies — drop a single <script src="/assistant-widget.js" defer>
 * tag on any page and it mounts itself.
 */
(function () {
  'use strict';

  // Avoid double-mounting if the script is included more than once.
  if (window.__sentAssistantMounted) return;
  window.__sentAssistantMounted = true;

  var GREETING =
    "Hi! The SENT. assistant here. Ask me anything about how the app works — " +
    "proof of delivery, the Verified Bill of Sale, verifying a receipt, accounts, " +
    "pricing, or where to find something on the site.";

  var SUGGESTIONS = [
    'How does SENT work?',
    'How do I verify a receipt?',
    'What does it cost?',
    'How does a bill of sale work?',
    'How do I sign in?',
  ];

  // Known routes, longest first, so nested paths linkify before their parents.
  var ROUTES = [
    '/verified-bill-of-sale/general-goods',
    '/verified-bill-of-sale/electronics',
    '/verified-bill-of-sale/sneakers',
    '/verified-bill-of-sale/jewelry',
    '/verified-bill-of-sale',
    '/dashboard', '/transfer', '/pricing', '/receipt', '/verify', '/login', '/demo', '/',
  ];

  // Conversation history sent to the API (role/content pairs).
  var history = [];
  var sending = false;
  var els = {};

  function injectStyles() {
    var css = [
      '#sent-asst,#sent-asst *{box-sizing:border-box}',
      '#sent-asst{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:"DM Sans",system-ui,sans-serif}',
      '#sent-asst-btn{display:flex;align-items:center;gap:9px;border:none;cursor:pointer;background:#00b356;color:#fff;padding:13px 18px;border-radius:50px;box-shadow:0 6px 22px rgba(0,179,86,0.36),0 2px 6px rgba(0,0,0,0.12);font-family:"DM Sans",sans-serif;font-size:14px;font-weight:600;letter-spacing:.01em;transition:transform .18s,box-shadow .18s}',
      '#sent-asst-btn:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(0,179,86,0.44)}',
      '#sent-asst-btn .dot{width:8px;height:8px;border-radius:50%;background:#fff;flex-shrink:0;animation:sent-pulse 2.4s infinite}',
      '@keyframes sent-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.5)}60%{box-shadow:0 0 0 6px rgba(255,255,255,0)}}',
      '#sent-asst-panel{position:absolute;bottom:0;right:0;width:374px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 100px);background:#fff;border:1.5px solid #c8cdd6;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.22),0 4px 12px rgba(0,0,0,.1);display:none;flex-direction:column;overflow:hidden}',
      '#sent-asst.open #sent-asst-panel{display:flex;animation:sent-rise .22s ease both}',
      '#sent-asst.open #sent-asst-btn{display:none}',
      '@keyframes sent-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}',
      '#sent-asst-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#f0f2f5;border-bottom:1px solid #e1e4e8;flex-shrink:0}',
      '#sent-asst-hd .ttl{font-family:"Bebas Neue",sans-serif;font-size:19px;letter-spacing:.13em;color:#111318;display:flex;align-items:center;gap:8px}',
      '#sent-asst-hd .ttl .d{width:7px;height:7px;border-radius:50%;background:#00b356;animation:sent-pulse 2.4s infinite}',
      '#sent-asst-hd .sub{font-family:"JetBrains Mono",monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#6b7280;margin-top:2px}',
      '#sent-asst-close{background:none;border:none;cursor:pointer;color:#6b7280;font-size:22px;line-height:1;padding:4px 6px;border-radius:6px;transition:background .15s,color .15s}',
      '#sent-asst-close:hover{background:#e4e7ec;color:#111318}',
      '#sent-asst-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;background:#f5f6f8}',
      '.sent-msg{max-width:86%;font-size:14px;line-height:1.55;padding:10px 13px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}',
      '.sent-msg.bot{align-self:flex-start;background:#fff;border:1px solid #e1e4e8;color:#1f2430;border-bottom-left-radius:4px}',
      '.sent-msg.user{align-self:flex-end;background:#00b356;color:#fff;border-bottom-right-radius:4px}',
      '.sent-msg a{color:#009347;font-weight:600;text-decoration:underline}',
      '.sent-msg.user a{color:#fff}',
      '.sent-typing{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:#fff;border:1px solid #e1e4e8;border-radius:12px;border-bottom-left-radius:4px}',
      '.sent-typing span{width:7px;height:7px;border-radius:50%;background:#9ca3af;animation:sent-bounce 1.2s infinite}',
      '.sent-typing span:nth-child(2){animation-delay:.18s}.sent-typing span:nth-child(3){animation-delay:.36s}',
      '@keyframes sent-bounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-5px);opacity:1}}',
      '#sent-asst-sugg{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 12px;background:#f5f6f8}',
      '.sent-chip{background:#fff;border:1px solid #c8cdd6;color:#374151;font-family:"DM Sans",sans-serif;font-size:12px;padding:7px 11px;border-radius:50px;cursor:pointer;transition:all .15s}',
      '.sent-chip:hover{border-color:#00b356;color:#009347;background:#e6f7ee}',
      '#sent-asst-form{display:flex;gap:8px;padding:12px;border-top:1px solid #e1e4e8;background:#fff;flex-shrink:0}',
      '#sent-asst-input{flex:1;border:1.5px solid #c8cdd6;border-radius:8px;padding:10px 12px;font-family:"DM Sans",sans-serif;font-size:14px;color:#111318;resize:none;max-height:96px;outline:none;transition:border-color .15s}',
      '#sent-asst-input:focus{border-color:#00b356}',
      '#sent-asst-send{border:none;cursor:pointer;background:#00b356;color:#fff;width:42px;border-radius:8px;font-size:17px;flex-shrink:0;transition:background .15s}',
      '#sent-asst-send:hover{background:#009347}',
      '#sent-asst-send:disabled{background:#c8cdd6;cursor:not-allowed}',
      '@media (max-width:480px){#sent-asst{bottom:14px;right:14px}#sent-asst-panel{height:calc(100vh - 84px)}}',
    ].join('');
    var style = document.createElement('style');
    style.id = 'sent-asst-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Turn known route paths and full URLs in escaped text into clickable links.
  function linkify(text) {
    var out = escapeHtml(text);
    out = out.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
    });
    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i];
      if (r === '/') continue; // skip bare slash to avoid noise
      var re = new RegExp('(^|[\\s(])' + r.replace(/[-/]/g, '\\$&') + '(?![\\w/-])', 'g');
      out = out.replace(re, '$1<a href="' + r + '">' + r + '</a>');
    }
    return out;
  }

  function addMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'sent-msg ' + (role === 'user' ? 'user' : 'bot');
    div.innerHTML = role === 'user' ? escapeHtml(text) : linkify(text);
    els.log.appendChild(div);
    scrollDown();
    return div;
  }

  function scrollDown() {
    els.log.scrollTop = els.log.scrollHeight;
  }

  function showTyping() {
    var t = document.createElement('div');
    t.className = 'sent-typing';
    t.id = 'sent-asst-typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    els.log.appendChild(t);
    scrollDown();
  }

  function hideTyping() {
    var t = document.getElementById('sent-asst-typing');
    if (t) t.remove();
  }

  function setSuggestionsVisible(visible) {
    els.sugg.style.display = visible ? 'flex' : 'none';
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || sending) return;
    sending = true;
    els.send.disabled = true;
    setSuggestionsVisible(false);

    addMessage('user', text);
    history.push({ role: 'user', content: text });
    els.input.value = '';
    els.input.style.height = 'auto';
    showTyping();

    try {
      var res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-16) }),
      });
      var data = await res.json().catch(function () { return {}; });
      hideTyping();
      if (res.ok && data.reply) {
        addMessage('bot', data.reply);
        history.push({ role: 'assistant', content: data.reply });
      } else {
        addMessage('bot', data.error ||
          'Something went wrong reaching the assistant. Please try again.');
      }
    } catch (e) {
      hideTyping();
      addMessage('bot', 'The assistant is unreachable right now. Please try again shortly.');
    } finally {
      sending = false;
      els.send.disabled = false;
      els.input.focus();
    }
  }

  function open() {
    els.root.classList.add('open');
    els.input.focus();
    scrollDown();
  }

  function close() {
    els.root.classList.remove('open');
  }

  function build() {
    var root = document.createElement('div');
    root.id = 'sent-asst';
    root.innerHTML =
      '<button id="sent-asst-btn" aria-label="Open the SENT assistant">' +
        '<span class="dot"></span>Ask SENT.</button>' +
      '<div id="sent-asst-panel" role="dialog" aria-label="SENT assistant">' +
        '<div id="sent-asst-hd">' +
          '<div><div class="ttl"><span class="d"></span>SENT. ASSISTANT</div>' +
          '<div class="sub">Navigation &amp; answers</div></div>' +
          '<button id="sent-asst-close" aria-label="Close assistant">&times;</button>' +
        '</div>' +
        '<div id="sent-asst-log"></div>' +
        '<div id="sent-asst-sugg"></div>' +
        '<form id="sent-asst-form">' +
          '<textarea id="sent-asst-input" rows="1" placeholder="Ask a question…" ' +
            'aria-label="Message"></textarea>' +
          '<button id="sent-asst-send" type="submit" aria-label="Send">&#10148;</button>' +
        '</form>' +
      '</div>';
    document.body.appendChild(root);

    els.root = root;
    els.log = root.querySelector('#sent-asst-log');
    els.sugg = root.querySelector('#sent-asst-sugg');
    els.input = root.querySelector('#sent-asst-input');
    els.send = root.querySelector('#sent-asst-send');

    root.querySelector('#sent-asst-btn').addEventListener('click', open);
    root.querySelector('#sent-asst-close').addEventListener('click', close);

    root.querySelector('#sent-asst-form').addEventListener('submit', function (e) {
      e.preventDefault();
      send(els.input.value);
    });

    els.input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 96) + 'px';
    });
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(els.input.value);
      }
    });

    SUGGESTIONS.forEach(function (s) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sent-chip';
      chip.textContent = s;
      chip.addEventListener('click', function () { send(s); });
      els.sugg.appendChild(chip);
    });

    addMessage('bot', GREETING);
  }

  function init() {
    injectStyles();
    build();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
