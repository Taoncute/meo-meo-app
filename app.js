class ChatApp {
  constructor() {
    this.ws = null;
    this.requestId = 0;
    this.sessionId = null;
    this.isProcessing = false;
    this.pendingMessageId = null;
    
    this.initElements();
    this.initWebSocket();
    this.initEventListeners();
  }

  initElements() {
    this.messagesEl = document.getElementById('messages');
    this.inputEl = document.getElementById('message-input');
    this.sendBtn = document.getElementById('send-button');
    this.statusText = document.getElementById('status-text');
  }

  async initWebSocket() {
    // Lấy session token động từ dashboard (inject vào index.html).
    // Token thay đổi mỗi lần khởi động, nên không thể hardcode.
    let sessionToken = null;
    try {
      const resp = await fetch('http://localhost:9119/');
      if (resp.ok) {
        const html = await resp.text();
        const m = html.match(/window.__HERMES_SESSION_TOKEN__="([^"]+)"/);
        sessionToken = m ? m[1] : null;
      }
    } catch (e) {
      console.error('Failed to fetch session token:', e);
    }

    // /api/pty là endpoint WS thực sự cho Chat tab (PTY-over-WebSocket /
    // terminal emulator). /api/ws chỉ là JSON-RPC sidecar dành cho metadata.
    const wsUrl = `ws://localhost:9119/api/pty?token=${encodeURIComponent(sessionToken || '')}`;
    this.ws = new WebSocket(wsUrl);
  
    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.setStatus('Connected');
      this.createSession();
    };
  
    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };
  
    this.ws.onclose = () => {
      console.log('WebSocket closed');
      this.setStatus('Disconnected');
      // Retry connection after 3 seconds
      setTimeout(() => this.initWebSocket(), 3000);
    };
  
    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.setStatus('Error');
    };
  }

  handleMessage(data) {
    // Xử lý event gateway.ready
    if (data.method === 'event' && data.params?.type === 'gateway.ready') {
      console.log('Gateway ready:', data.params?.payload);
      this.setStatus('Ready');
      return;
    }
  
    // Xử lý response
    if (data.result) {
      this.handleResponse(data.id, data.result);
    }
  
    // Xử lý event streaming
    if (data.method === 'event' && data.params) {
      this.handleStreamingEvent(data.params);
    }
  }

  handleResponse(reqId, result) {
    const pending = this.pendingMessageId;
    if (!pending) return;
  
    // Xóa trạng thái đang xử lý
    this.setProcessing(false);
  
    // Xử lý kết quả từ prompt.submit
    if (result?.turn) {
      // Kết quả từ prompt.submit - không có message để hiển thị
      return;
    }
  
    // Xử lý message.complete (kết thúc streaming)
    if (result?.type === 'message.complete') {
      this.appendMessage('ai', result.content || '', pending);
      return;
    }
  }

  handleStreamingEvent(params) {
    if (!params) return;
  
    const { type, delta, content } = params;
  
    if (type === 'message.delta' && delta) {
      // Streaming tin nhắn từ AI
      this.appendMessage('ai', delta, this.pendingMessageId, true);
    }
  }

  async createSession() {
    const requestId = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'session.create',
      params: {
        title: 'Chat Session'
      }
    };
    this.ws.send(JSON.stringify(request));
  }

  async submitPrompt(text) {
    if (!this.sessionId || this.isProcessing) return;
  
    this.setProcessing(true);
    this.appendMessage('user', text);
    this.inputEl.value = '';
    this.inputEl.focus();
  
    const requestId = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'prompt.submit',
      params: {
        session_id: this.sessionId,
        text: text
      }
    };
    this.ws.send(JSON.stringify(request));
  
    // Lưu ID để gắn tin nhắn streaming
    this.pendingMessageId = `msg-${Date.now()}`;
  }

  appendMessage(role, text, messageId = null, isStreaming = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    if (messageId) {
      messageDiv.dataset.messageId = messageId;
    }
  
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;
    bubble.innerHTML = `<div class=\"content\">${this.escapeHtml(text)}</div>`;
  
    if (isStreaming) {
      bubble.dataset.streaming = 'true';
    }
  
    messageDiv.appendChild(bubble);
  
    if (isStreaming && this.pendingMessageId) {
      // Tìm tin nhắn cũ hoặc tạo mới
      let existing = this.messagesEl.querySelector(`[data-message-id=\"${this.pendingMessageId}\"]`);
      if (existing) {
        // Cập nhật tin nhắn hiện có
        let existingBubble = existing.querySelector('.bubble');
        if (existingBubble) {
          existingBubble.innerHTML = `<div class=\"content\">${this.escapeHtml(existingBubble.querySelector('.content')?.textContent || '' + text)}</div>`;
        }
      } else {
        // Thêm tin nhắn mới cho streaming
        messageDiv.dataset.messageId = this.pendingMessageId;
        this.messagesEl.appendChild(messageDiv);
      }
    } else {
      this.messagesEl.appendChild(messageDiv);
    }
  
    // Scroll cuối cùng
    this.messagesEl.parentElement.scrollTop = this.messagesEl.parentElement.scrollHeight;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  setProcessing(isProcessing) {
    this.isProcessing = isProcessing;
    this.sendBtn.disabled = isProcessing;
    if (isProcessing) {
      this.sendBtn.textContent = 'Sending...';
    } else {
      this.sendBtn.textContent = 'Send';
    }
  }

  setStatus(status) {
    this.statusText.textContent = status;
  }

  initEventListeners() {
    // Gửi tin nhắn khi bấm nút Send
    this.sendBtn.addEventListener('click', () => {
      const text = this.inputEl.value.trim();
      if (text) {
        this.submitPrompt(text);
      }
    });
  
    // Gửi tin nhắn khi nhấn Enter
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = this.inputEl.value.trim();
        if (text) {
          this.submitPrompt(text);
        }
      }
    });
  }
}

// Khởi chạy app khi DOM sẵn sàng
document.addEventListener('DOMContentLoaded', () => {
  window.chatApp = new ChatApp();
});
