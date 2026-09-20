/* Meo Meo — Chat client for Hermes dashboard /api/pty bridge.
 *
 * Luồng:
 *   1. fetch trang chủ để lấy session token (inject vào index.html).
 *   2. Mở WebSocket tới ws://localhost:9119/api/pty?token=<token>.
 *      /api/pty là PTY-over-WebSocket: nhận/gửi raw text (keystrokes + Enter='\r'),
 *      trả về raw ANSI terminal output — KHÔNG phải JSON-RPC.
 *   3. Gửi: raw text + '\r' khi người dùng nhấn Enter (giống gõ trên terminal).
 *   4. Nhận: raw ANSI text → strip escape codes → render làm tin nhắn AI.
 *
 * UI: thiết kế hiện đại tối giản, theme cam/nâu ấm của Meo Meo.
 */

// ---------- ANSI escape stripping ----------
const ANSI_RE = {
  // Escape sequences: CSI, OSC, etc.
  csi: /\x1b\[[0-9;?]*[A-Za-z]/g,
  osc: /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
  other: /\x1b[()][AB012]/g,
  // Single-char escapes (ESC, etc.)
  single: /\x1b/g,
  // Backspace / carriage return / form feed
  bs: /[\x08\x0c]/g,
};

function stripAnsi(str) {
  if (!str) return '';
  return str
    .replace(ANSI_RE.osc, '')
    .replace(ANSI_RE.csi, '')
    .replace(ANSI_RE.other, '')
    .replace(ANSI_RE.single, '')
    .replace(ANSI_RE.bs, '');
}

// ---------- marked.js (from CDN, loaded in index.html) ----------
function renderMarkdown(mdText) {
  if (typeof marked === 'undefined') return escapeHtml(mdText);
  try {
    return marked.parse(mdText || '');
  } catch (e) {
    console.error('marked parse error:', e);
    return escapeHtml(mdText);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

class ChatApp {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.isProcessing = false;
    this.pendingAIMsg = null;   // reference to the AI <message> currently streaming
    this.currentAIContentEl = null;

    this.initElements();
    this.initEventListeners();
    this.initWebSocket();
  }

  initElements() {
    this.messagesEl = document.getElementById('messages');
    this.inputEl = document.getElementById('message-input');
    this.sendBtn = document.getElementById('send-button');
    this.statusText = document.getElementById('status-text');
    this.formEl = document.getElementById('composer-form');
    this.sendIcon = this.sendBtn.querySelector('.send-icon');
  }

  initEventListeners() {
    this.formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.inputEl.value.trim();
      if (text) this.sendMessage(text);
    });

    // Auto-resize textarea
    this.inputEl.addEventListener('input', () => {
      this.resizeInput();
      this.updateSendBtn();
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = this.inputEl.value.trim();
        if (text && !this.isProcessing) this.sendMessage(text);
      }
    });
    window.addEventListener('resize', () => this.scrollBottom());
  }

  resizeInput() {
    this.inputEl.classList.remove('grow-2', 'grow-3', 'grow-4');
    const lines = (this.inputEl.value.match(/\n/g) || []).length;
    if (lines >= 3) this.inputEl.classList.add('grow-4');
    else if (lines >= 2) this.inputEl.classList.add('grow-3');
    else if (lines >= 1) this.inputEl.classList.add('grow-2');
  }

  updateSendBtn() {
    this.sendBtn.disabled = !this.inputEl.value.trim() || this.isProcessing;
  }

  async fetchSessionToken() {
    // Session token thay đổi mỗi lần khởi động dashboard.
    // Server inject vào index.html: window.__HERMES_SESSION_TOKEN__="..."
    const resp = await fetch('http://localhost:9119/');
    const html = await resp.text();
    const m = html.match(/window\.__HERMES_SESSION_TOKEN__="([^"]+)"/);
    return m ? m[1] : '';
  }

  async initWebSocket() {
    this.setStatus('Đang kết nối…');

    let sessionToken = '';
    try {
      sessionToken = await this.fetchSessionToken();
    } catch (e) {
      console.error('Failed to fetch session token:', e);
    }

    // /api/pty: PTY-over-WebSocket (terminal emulator). Gửi nhận raw text.
    const wsUrl = `ws://localhost:9119/api/pty?token=${encodeURIComponent(sessionToken)}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('PTY WebSocket connected');
      this.setStatus('Đã kết nối');
      this.sendBtn.disabled = false;
      this.updateSendBtn();
    };

    this.ws.onmessage = (event) => {
      // Server gửi raw text (ANSI) hoặc JSON nhỏ gọn {type:"resume",...}.
      const data = event.data;

      // Trường hợp JSON điều khiển (resume replay) — bỏ qua hiển thị.
      if (typeof data === 'string' && data.trim().startsWith('{')) {
        try {
          const obj = JSON.parse(data);
          if (obj.type === 'resume') {
            // Resume replay: server sẽ gửi full terminal frame right after.
            return;
          }
        } catch (e) {
          // Không phải JSON hợp lệ → coi là text thường.
        }
      }

      const text = stripAnsi(data);
      if (!text) return;
      this.appendAIFragment(text);
    };

    this.ws.onclose = () => {
      console.log('PTY WebSocket closed');
      this.setStatus('Ngắt kết nối');
      this.sendBtn.disabled = true;
      // Retry after 3s
      setTimeout(() => this.initWebSocket(), 3000);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.setStatus('Lỗi kết nối');
    };
  }

  /* ----- Gửi tin nhắn: raw text + '\r' (Enter) như gõ trên terminal ----- */
  sendMessage(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.setStatus('Chưa kết nối');
      return;
    }
    this.isProcessing = true;
    this.appendUserMessage(text);
    this.showLoading();

    // /api/pty nhận raw keystrokes. Gửi text + '\r' (Enter) để PTY/agent xử lý.
    this.ws.send(text + '\r');
    this.inputEl.value = '';
    this.resizeInput();
    this.updateSendBtn();
  }

  appendUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'message user';
    el.innerHTML = `<div class="content">${escapeHtml(text)}</div>`;
    this.messagesEl.appendChild(el);
    this.scrollBottom();
  }

  appendAIFragment(text) {
    // Nhận output từ agent (raw text đã strip ANSI), render dưới dạng markdown.
    if (this.pendingAIMsg) {
      // Đang có tin nhắn AI đang streaming (hoặc mới) → cập nhật nội dung.
      const cur = this.currentAIContentEl.dataset.raw || '';
      this.currentAIContentEl.dataset.raw = cur + text;
      this.currentAIContentEl.innerHTML = renderMarkdown(cur + text);
    } else {
      // Tin nhắn AI mới.
      this.pendingAIMsg = document.createElement('div');
      this.pendingAIMsg.className = 'message ai';
      this.pendingAIMsg.innerHTML = `<div class="md content" data-raw="${escapeHtml(text)}"></div>`;
      this.currentAIContentEl = this.pendingAIMsg.querySelector('.content');
      this.messagesEl.appendChild(this.pendingAIMsg);
    }
    this.hideLoading();
    this.scrollBottom();
  }

  finishAIMessage() {
    if (this.pendingAIMsg) {
      this.pendingAIMsg = null;
      this.currentAIContentEl = null;
    }
  }

  /* ----- Loading state: 3 chấm nhảy ----- */
  showLoading() {
    // Tạo hoặc cập nhật tin nhắn AI đang "đang gõ".
    if (!this.pendingAIMsg) {
      const el = document.createElement('div');
      el.className = 'message ai loading-msg';
      el.innerHTML = `<span class="loading-dots"><span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span></span>`;
      this.pendingAIMsg = el;
      this.messagesEl.appendChild(el);
      this.scrollBottom();
    }
  }

  hideLoading() {
    const loading = this.pendingAIMsg && this.pendingAIMsg.classList.contains('loading-msg');
    if (loading) {
      this.pendingAIMsg.remove();
      this.pendingAIMsg = null;
      this.currentAIContentEl = null;
      // Sau loading sẽ có fragment AI thực sự.
      this.isProcessing = false;
      this.sendBtn.disabled = !this.inputEl.value.trim();
    } else {
      this.isProcessing = false;
      this.updateSendBtn();
    }
  }

  setStatus(status, cls = '') {
    this.statusText.textContent = status;
    this.statusText.className = cls;
  }

  scrollBottom() {
    const parent = this.messagesEl.parentElement;
    parent.scrollTop = parent.scrollHeight;
  }
}

// Khởi chạy app khi DOM sẵn sàng
document.addEventListener('DOMContentLoaded', () => {
  window.chatApp = new ChatApp();
});
