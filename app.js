/* Meo Meo — Chat client for Hermes dashboard /api/ws JSON-RPC gateway.
 *
 * Luồng (wire-identical với stdio):
 *   1. fetch trang chủ để lấy session token (inject vào index.html).
 *   2. Mở ws://localhost:9119/api/ws?token=<token>.
 *   3. Server tự động gửi gateway.ready event sau accept — client không cần handshake.
 *   4. Gửi session.create để tạo session_id.
 *   5. Gửi prompt.submit với session_id + text.
 *   6. Nhận streaming message.delta (từng token), message.complete (kết thúc).
 *
 * Giao thức: newline-delimited JSON-RPC 2.0. Mỗi .onmessage là 1 message (không prefix).
 */

(function () {
  'use strict';

  // Tránh double-init nếu script bị load 2 lần (Capacitor/WebView caching).
  if (window.__MEO_MEO_APP_INITIALIZED) {
    return;
  }
  window.__MEO_MEO_APP_INITIALIZED = true;

  // ---------- marked.js (CDN, loaded in index.html) ----------
  function renderMarkdown(mdText) {
    if (typeof marked !== 'undefined') {
      try {
        return marked.parse(mdText || '');
      } catch (e) {
        console.error('[meo] marked parse error:', e);
      }
    }
    return escapeHtml(mdText || '');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  class ChatApp {
    constructor() {
      this.ws = null;
      this.requestId = 0;
      this.sessionId = null;
      this.isProcessing = false;
      this.pendingAIMsg = null;        // <div class="message ai"> đang streaming
      this.currentAIContentEl = null;  // phần .content của tin nhắn AI hiện tại

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
    }

    initEventListeners() {
      if (this.formEl) {
        this.formEl.addEventListener('submit', (e) => {
          e.preventDefault();
          const text = this.inputEl.value.trim();
          if (text && !this.isProcessing) this.sendMessage(text);
        });
      }
      if (this.inputEl) {
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
      }
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
      if (this.sendBtn) {
        this.sendBtn.disabled = !this.inputEl.value.trim() || this.isProcessing || !this.sessionId;
      }
    }

    async fetchSessionToken() {
      try {
        const resp = await fetch('http://localhost:9119/');
        const html = await resp.text();
        const m = html.match(/window\.__HERMES_SESSION_TOKEN__="([^"]+)"/);
        return m ? m[1] : '';
      } catch (e) {
        console.error('[meo] fetch session token failed:', e);
        return '';
      }
    }

    nextId() {
      return ++this.requestId;
    }

    sendRpc(method, params = {}) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextId(),
          method: method,
          params: params,
        }));
      }
    }

    async initWebSocket() {
      this.setStatus('Đang kết nối…');

      const sessionToken = await this.fetchSessionToken();
      const wsUrl = `ws://localhost:9119/api/ws?token=${encodeURIComponent(sessionToken || '')}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[meo] /api/ws connected');
        this.setStatus('Đã kết nối');
        this.updateSendBtn();
        // Server tự động gửi gateway.ready → không cần handshake.
        this.sendRpc('session.create', { title: 'Meo Meo Chat' });
      };

      this.ws.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (e) {
          console.error('[meo] WS message parse error:', e, event.data);
          return;
        }
        this.handleMessage(data);
      };

      this.ws.onclose = () => {
        console.log('[meo] /api/ws closed');
        this.setStatus('Ngắt kết nối');
        this.isProcessing = false;
        this.pendingAIMsg = null;
        this.currentAIContentEl = null;
        this.sessionId = null;
        // Retry.
        setTimeout(() => this.initWebSocket(), 3000);
      };

      this.ws.onerror = (err) => {
        console.error('[meo] WS error:', err);
        this.setStatus('Lỗi kết nối');
      };
    }

    handleMessage(data) {
      // Response (có id → trả lời RPC).
      if (data.id != null && data.result) {
        this.handleRpcResponse(data.id, data.result);
        return;
      }
      // Event (method === 'event' + params.type).
      if (data.method === 'event' && data.params) {
        const p = data.params;
        const ev = p.type;
        if (ev === 'gateway.ready') {
          console.log('[meo] gateway ready:', p.payload);
          this.setStatus('Sẵn sàng');
          return;
        }
        if (ev === 'session.created') {
          const payload = p.payload || {};
          const sid = payload.session_id;
          if (sid) {
            this.sessionId = sid;
            this.setStatus('Sẵn sàng');
            this.updateSendBtn();
          }
          return;
        }
        // message.delta — streaming token.
        if (ev === 'message.delta') {
          const text = (p.payload && p.payload.text) || '';
          if (text) this.appendAIFragment(text);
          return;
        }
        // message.complete — kết thúc turn.
        if (ev === 'message.complete') {
          this.finishAIMessage();
          return;
        }
      }
    }

    handleRpcResponse(id, result) {
      // session.create response trả về session_id.
      if (result && result.session_id) {
        this.sessionId = result.session_id;
        this.setStatus('Sẵn sàng');
        this.updateSendBtn();
      }
    }

    /* ----- Gửi: prompt.submit (raw JSON-RPC) ----- */
    sendMessage(text) {
      if (!this.sessionId) {
        this.setStatus('Chưa có phiên');
        return;
      }
      this.isProcessing = true;
      this.appendUserMessage(text);
      this.showLoading();
      this.sendRpc('prompt.submit', { session_id: this.sessionId, text: text });
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
      if (this.pendingAIMsg) {
        const cur = this.currentAIContentEl.dataset.raw || '';
        this.currentAIContentEl.dataset.raw = cur + text;
        this.currentAIContentEl.innerHTML = renderMarkdown(cur + text);
      } else {
        this.pendingAIMsg = document.createElement('div');
        this.pendingAIMsg.className = 'message ai';
        this.pendingAIMsg.innerHTML = `<div class="md content" data-raw="${escapeHtml(text)}"></div>`;
        this.currentAIContentEl = this.pendingAIMsg.querySelector('.content');
        this.messagesEl.appendChild(this.pendingAIMsg);
      }
      this.hideLoading(true);
      this.scrollBottom();
    }

    finishAIMessage() {
      if (this.pendingAIMsg && this.currentAIContentEl) {
        // Chuẩn bị sẵn sàng cho tin nhắn tiếp theo.
        this.pendingAIMsg = null;
        this.currentAIContentEl = null;
      }
      this.isProcessing = false;
      this.updateSendBtn();
    }

    /* ----- Loading state: 3 chấm nhảy ----- */
    showLoading() {
      if (!this.pendingAIMsg || this.pendingAIMsg.classList.contains('loading-msg')) {
        if (!this.pendingAIMsg) {
          const el = document.createElement('div');
          el.className = 'message ai loading-msg';
          el.innerHTML = `<span class="loading-dots"><span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span></span>`;
          this.pendingAIMsg = el;
          this.messagesEl.appendChild(el);
          this.scrollBottom();
        }
      }
    }

    hideLoading(isStreaming = false) {
      const loading = this.pendingAIMsg && this.pendingAIMsg.classList.contains('loading-msg');
      if (loading) {
        this.pendingAIMsg.remove();
        // pendingAIMsg đã được set lại trong appendAIFragment.
      }
      if (!isStreaming) {
        this.isProcessing = false;
      }
      this.updateSendBtn();
    }

    setStatus(status, cls = '') {
      if (this.statusText) {
        this.statusText.textContent = status;
        this.statusText.className = cls;
      }
    }

    scrollBottom() {
      if (this.messagesEl && this.messagesEl.parentElement) {
        const parent = this.messagesEl.parentElement;
        parent.scrollTop = parent.scrollHeight;
      }
    }
  }

  // Khởi chạy app khi DOM sẵn sàng
  document.addEventListener('DOMContentLoaded', () => {
    window.chatApp = new ChatApp();
  });
})();
