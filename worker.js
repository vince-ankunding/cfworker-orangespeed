// ================== 全局配置变量 ==================

/**
 * 默认请求头 - 播放器特征
 * 模拟真实的流媒体播放器行为，更适合直播场景
 */
const DEFAULT_HEADERS = {
  'User-Agent': 'ExoPlayer/2.18.1 (Linux; Android 10; arm64-v8a) ExoPlayerLib/2.18.1',
  'Accept': '*/*',
  'Accept-Encoding': 'gzip, deflate',
  'Connection': 'keep-alive',
};

/**
 * 用于识别流媒体URL的正则表达式模式数组。
 */
const STREAMING_URL_PATTERNS = [
  /rtmp[s]?:\/\//i,
  /\.flv$/i,
  /\.m3u8$/i,
  /\.ts$/i,
  /\.mp4$/i,
  /\.webm$/i,
  /hls/i,
  /dash/i,
  /stream/i,
  /live/i,
  /broadcast/i
];

/**
 * 从客户端请求头中排除的请求头前缀或名称。
 */
const EXCLUDED_HEADERS = [
  'cf-',
  'x-forwarded-',
  'x-real-ip',
  'x-client-ip'
];

/**
 * 重试配置
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelay: 500, // 毫秒
  maxDelay: 3000,
  backoffMultiplier: 2
};

// ================== Worker 核心逻辑 ==================

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  // 从路径中提取目标 URL
  let targetUrl = url.pathname.slice(1);
  targetUrl = decodeURIComponent(targetUrl);

  // 如果没有目标URL，显示配置页面
  if (!targetUrl) {
    return getConfigPage(url.hostname);
  }

  // 检查是否为流媒体相关请求
  const isStreamingRequest = isStreamingUrl(targetUrl) || isStreamingMethod(request);

  // 使用重试机制处理请求
  return await retryRequest(request, targetUrl, url, isStreamingRequest);
}

/**
 * 带重试机制的请求处理
 */
async function retryRequest(request, targetUrl, originalUrl, isStreamingRequest, attempt = 1) {
  try {
    // 构建请求头
    const proxyHeaders = buildProxyHeaders(request, targetUrl, isStreamingRequest);

    // 创建代理请求
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.body,
      redirect: 'follow', // 改为自动跟随重定向
      cf: {
        // Cloudflare 特定配置
        cacheTtl: 0, // 不缓存
        cacheEverything: false,
        scrapeShield: false,
        minify: {
          javascript: false,
          css: false,
          html: false
        }
      }
    });

    // 发起请求
    const response = await fetch(proxyRequest);

    // 检查响应状态
    if (!response.ok && attempt < RETRY_CONFIG.maxRetries) {
      // 如果是 4xx 错误,不重试
      if (response.status >= 400 && response.status < 500) {
        return handleErrorResponse(response, targetUrl);
      }
      
      // 对于 5xx 或网络错误,进行重试
      const delay = Math.min(
        RETRY_CONFIG.initialDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1),
        RETRY_CONFIG.maxDelay
      );
      
      await sleep(delay);
      return retryRequest(request, targetUrl, originalUrl, isStreamingRequest, attempt + 1);
    }

    // 处理响应
    return handleResponse(response, originalUrl, targetUrl, isStreamingRequest);

  } catch (error) {
    console.error(`代理请求失败 (尝试 ${attempt}/${RETRY_CONFIG.maxRetries}):`, error);
    
    // 如果还有重试次数
    if (attempt < RETRY_CONFIG.maxRetries) {
      const delay = Math.min(
        RETRY_CONFIG.initialDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1),
        RETRY_CONFIG.maxDelay
      );
      
      await sleep(delay);
      return retryRequest(request, targetUrl, originalUrl, isStreamingRequest, attempt + 1);
    }
    
    // 最后一次尝试也失败了
    return new Response(
      JSON.stringify({
        error: '代理请求失败',
        message: error.message,
        targetUrl: targetUrl,
        attempts: attempt,
        suggestion: '请检查目标URL是否正确，或稍后重试'
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
}

/**
 * 睡眠函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 检查URL是否符合流媒体特征
 */
function isStreamingUrl(url) {
  return STREAMING_URL_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * 检查请求方法或内容类型是否与流媒体相关
 */
function isStreamingMethod(request) {
  const contentType = request.headers.get('content-type') || '';
  return contentType.includes('video/') ||
    contentType.includes('application/x-rtmp') ||
    contentType.includes('application/vnd.apple.mpegurl') ||
    contentType.includes('application/dash+xml');
}

/**
 * 构建转发到目标服务器的请求头 - 播放器模式
 */
function buildProxyHeaders(request, targetUrl, isStreaming) {
  const proxyHeaders = new Headers();
  
  // 解析目标URL以获取域名信息
  const targetUrlObj = new URL(targetUrl);

  // 首先设置默认请求头
  for (const [key, value] of Object.entries(DEFAULT_HEADERS)) {
    proxyHeaders.set(key, value);
  }

  // 复制客户端的重要请求头
  const importantHeaders = [
    'range',
    'if-none-match',
    'if-modified-since',
    'authorization',
    'cookie'
  ];

  for (const headerName of importantHeaders) {
    const value = request.headers.get(headerName);
    if (value) {
      proxyHeaders.set(headerName, value);
    }
  }

  // 复制其他客户端请求头(排除特定头)
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (!EXCLUDED_HEADERS.some(prefix => lowerKey.startsWith(prefix)) &&
        !proxyHeaders.has(key) &&
        !['host', 'connection'].includes(lowerKey)) {
      proxyHeaders.set(key, value);
    }
  }

  // 确保 Host 头正确
  proxyHeaders.set('Host', targetUrlObj.host);

  return proxyHeaders;
}

/**
 * 处理错误响应
 */
function handleErrorResponse(response, targetUrl) {
  const errorInfo = {
    status: response.status,
    statusText: response.statusText,
    targetUrl: targetUrl,
    message: getErrorMessage(response.status)
  };

  return new Response(
    JSON.stringify(errorInfo),
    {
      status: response.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    }
  );
}

/**
 * 获取友好的错误消息
 */
function getErrorMessage(status) {
  const messages = {
    400: '请求格式错误',
    401: '需要身份验证',
    403: '访问被拒绝 - 可能是防盗链或IP限制',
    404: '资源不存在',
    429: '请求过于频繁，请稍后重试',
    500: '服务器内部错误',
    502: '网关错误',
    503: '服务暂时不可用',
    504: '网关超时'
  };
  
  return messages[status] || '未知错误';
}

/**
 * 处理从目标服务器返回的响应
 */
async function handleResponse(response, originalUrl, targetUrl, isStreaming) {
  // 对于流媒体响应,进行特殊处理
  if (isStreaming) {
    return handleStreamingResponse(response);
  }

  // 处理普通响应
  const responseHeaders = new Headers(response.headers);
  
  // 移除所有缓存相关的响应头
  responseHeaders.delete('Cache-Control');
  responseHeaders.delete('Pragma');
  responseHeaders.delete('Expires');
  responseHeaders.delete('ETag');
  responseHeaders.delete('Last-Modified');
  responseHeaders.delete('Age');

  const modifiedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });

  return addCorsHeaders(modifiedResponse, isStreaming);
}

/**
 * 专门处理流媒体响应
 */
async function handleStreamingResponse(response) {
  const responseHeaders = new Headers(response.headers);

  // 移除所有缓存相关的响应头
  responseHeaders.delete('Cache-Control');
  responseHeaders.delete('Pragma');
  responseHeaders.delete('Expires');
  responseHeaders.delete('ETag');
  responseHeaders.delete('Last-Modified');
  responseHeaders.delete('Age');

  // 保持连接活跃
  responseHeaders.set('Connection', 'keep-alive');

  // 支持范围请求（对视频流重要）
  if (response.headers.has('accept-ranges')) {
    responseHeaders.set('Accept-Ranges', response.headers.get('accept-ranges'));
  } else {
    responseHeaders.set('Accept-Ranges', 'bytes');
  }

  // 保留内容类型
  if (response.headers.has('content-type')) {
    responseHeaders.set('Content-Type', response.headers.get('content-type'));
  }

  // 保留内容长度
  if (response.headers.has('content-length')) {
    responseHeaders.set('Content-Length', response.headers.get('content-length'));
  }

  const streamResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });

  return addCorsHeaders(streamResponse, true);
}

/**
 * 为响应添加CORS头
 */
function addCorsHeaders(response, isStreaming) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  response.headers.set('Access-Control-Allow-Headers', '*');
  response.headers.set('Access-Control-Expose-Headers', '*');

  if (isStreaming) {
    response.headers.set('Access-Control-Max-Age', '86400');
  }

  return response;
}

/**
 * 生成并返回配置页面的HTML
 */
function getConfigPage(hostname) {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>直播推流加速代理</title>
  <link rel="icon" type="image/jpg" href="https://cdn.jsdelivr.net/gh/png-dot/pngpng@main/20231112-014821-y4poc8.jpg">
  <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      
      body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #333;
      }
      
      .container {
          background: rgba(255, 255, 255, 0.95);
          backdrop-filter: blur(10px);
          border-radius: 20px;
          padding: 40px;
          box-shadow: 0 20px 40px rgba(0,0,0,0.1);
          width: 90%;
          max-width: 600px;
          animation: fadeIn 0.8s ease-out;
      }
      
      @keyframes fadeIn {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
      }
      
      h1 {
          text-align: center;
          margin-bottom: 30px;
          color: #2c3e50;
          font-size: 2.2em;
          font-weight: 600;
      }
      
      .subtitle {
          text-align: center;
          margin-bottom: 30px;
          color: #7f8c8d;
          font-size: 1.1em;
      }
      
      .features {
          background: #e3f2fd;
          padding: 15px;
          border-radius: 10px;
          margin-bottom: 25px;
          border-left: 4px solid #2196f3;
      }
      
      .features h3 {
          color: #1976d2;
          margin-bottom: 10px;
          font-size: 1.1em;
      }
      
      .features ul {
          list-style: none;
          padding-left: 0;
      }
      
      .features li {
          color: #1565c0;
          padding: 5px 0;
          font-size: 0.95em;
      }
      
      .features li:before {
          content: "✓ ";
          color: #4caf50;
          font-weight: bold;
          margin-right: 5px;
      }
      
      .form-group {
          margin-bottom: 25px;
      }
      
      label {
          display: block;
          margin-bottom: 8px;
          font-weight: 500;
          color: #2c3e50;
      }
      
      input[type="text"] {
          width: 100%;
          padding: 15px;
          border: 2px solid #e0e6ed;
          border-radius: 12px;
          font-size: 16px;
          transition: all 0.3s ease;
          background: #f8f9fa;
      }
      
      input[type="text"]:focus {
          outline: none;
          border-color: #667eea;
          background: white;
          box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1);
      }
      
      .btn {
          width: 100%;
          padding: 15px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          text-transform: uppercase;
          letter-spacing: 1px;
      }
      
      .btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 25px rgba(102, 126, 234, 0.3);
      }
      
      .examples {
          margin-top: 30px;
          padding: 20px;
          background: #f8f9fa;
          border-radius: 12px;
          border-left: 4px solid #667eea;
      }
      
      .examples h3 {
          margin-bottom: 15px;
          color: #2c3e50;
      }
      
      .examples ul {
          list-style: none;
      }
      
      .examples li {
          margin: 8px 0;
          color: #7f8c8d;
          font-family: monospace;
          background: white;
          padding: 8px 12px;
          border-radius: 6px;
          border: 1px solid #e0e6ed;
      }
      
      .footer {
          text-align: center;
          margin-top: 30px;
          color: #7f8c8d;
      }
      
      @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-5px); }
          75% { transform: translateX(5px); }
      }
      
      .shake {
          animation: shake 0.5s ease-in-out;
      }
      
      @media (max-width: 768px) {
          .container {
              margin: 20px;
              padding: 30px 20px;
          }
          
          h1 {
              font-size: 1.8em;
          }
      }
      
      @media (prefers-color-scheme: dark) {
          .container {
              background: rgba(30, 30, 30, 0.95);
              color: #e0e0e0;
          }
          
          h1, label {
              color: #f0f0f0;
          }
          
          .subtitle {
              color: #b0b0b0;
          }
          
          .features {
              background: #1e3a5f;
              border-left-color: #2196f3;
          }
          
          .features h3 {
              color: #64b5f6;
          }
          
          .features li {
              color: #90caf9;
          }
          
          input[type="text"] {
              background: #2a2a2a;
              color: #e0e0e0;
              border-color: #444;
          }
          
          input[type="text"]:focus {
              background: #333;
              border-color: #667eea;
          }
          
          .examples {
              background: #2a2a2a;
              border-left-color: #667eea;
          }
          
          .examples li {
              background: #333;
              color: #e0e0e0;
              border-color: #555;
          }
      }
  </style>
</head>
<body>
  <div class="container">
      <h1>🚀 直播推流加速代理</h1>
      <p class="subtitle">为您的直播流提供全球加速服务</p>
      
      <div class="features">
          <h3>🎯 优化特性</h3>
          <ul>
              <li>使用播放器 UA，更适合流媒体场景</li>
              <li>自动重试机制，提高连接成功率</li>
              <li>无缓存策略，确保实时性</li>
              <li>支持 HLS/RTMP/HTTP-FLV 等多种协议</li>
          </ul>
      </div>
      
      <div class="form-group">
          <label for="url">输入直播源地址:</label>
          <input type="text" id="url" placeholder="例如: https://your-stream-server.com/live/stream.m3u8" />
          <button class="btn" onclick="createProxy()">生成加速地址</button>
      </div>
      
      <div class="examples">
          <h3>📝 使用示例:</h3>
          <ul>
              <li>RTMP推流: rtmp://live.example.com/live/streamkey</li>
              <li>HLS播放: https://cdn.example.com/live/stream.m3u8</li>
              <li>HTTP-FLV: https://live.example.com/live/stream.flv</li>
              <li>TS分片: https://cdn.example.com/live/segment.ts</li>
          </ul>
      </div>
      
      <div class="footer">
          <p>&copy; 2024 直播加速代理服务 - 增强版 v2.0</p>
      </div>
  </div>
  
  <script>
      function createProxy() {
          const urlInput = document.getElementById('url');
          const inputUrl = urlInput.value.trim();
          
          if (!inputUrl) {
              urlInput.classList.add('shake');
              setTimeout(() => urlInput.classList.remove('shake'), 500);
              return;
          }
          
          const normalizedUrl = normalizeUrl(inputUrl);
          const proxyUrl = \`https://\${hostname}/\${encodeURIComponent(normalizedUrl)}\`;
          
          showResult(proxyUrl, normalizedUrl);
          urlInput.value = '';
      }
      
      function normalizeUrl(url) {
          if (!url.match(/^https?:\\/\\//i) && !url.match(/^rtmp[s]?:\\/\\//i)) {
              return 'https://' + url;
          }
          return url;
      }
      
      function showResult(proxyUrl, originalUrl) {
          // 移除之前的结果
          const oldResult = document.querySelector('.result-box');
          if (oldResult) {
              oldResult.remove();
          }
          
          const resultHtml = \`
              <div class="result-box" style="margin-top: 20px; padding: 20px; background: #e8f5e8; border-radius: 12px; border: 1px solid #4caf50; animation: fadeIn 0.5s ease-out;">
                  <h3 style="color: #2e7d32; margin-bottom: 15px;">✅ 加速地址已生成</h3>
                  <p style="margin-bottom: 10px;"><strong>原始地址:</strong></p>
                  <div style="background: white; padding: 10px; border-radius: 6px; word-break: break-all; font-family: monospace; border: 1px solid #ddd; font-size: 0.9em;">\${originalUrl}</div>
                  <p style="margin: 15px 0 10px 0;"><strong>加速地址:</strong></p>
                  <div style="background: white; padding: 10px; border-radius: 6px; word-break: break-all; font-family: monospace; border: 1px solid #ddd; font-size: 0.9em;">\${proxyUrl}</div>
                  <button onclick="copyToClipboard('\${proxyUrl}')" style="margin-top: 15px; padding: 10px 20px; background: #4caf50; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">📋 复制加速地址</button>
              </div>
          \`;
          
          document.querySelector('.form-group').insertAdjacentHTML('afterend', resultHtml);
      }
      
      function copyToClipboard(text) {
          navigator.clipboard.writeText(text).then(() => {
              showNotification('✓ 加速地址已复制到剪贴板！', 'success');
          }).catch(() => {
              const textarea = document.createElement('textarea');
              textarea.value = text;
              document.body.appendChild(textarea);
              textarea.select();
              document.execCommand('copy');
              document.body.removeChild(textarea);
              showNotification('✓ 加速地址已复制到剪贴板！', 'success');
          });
      }
      
      function showNotification(message, type) {
          const notification = document.createElement('div');
          notification.textContent = message;
          notification.style.cssText = \`
              position: fixed;
              top: 20px;
              right: 20px;
              background: \${type === 'success' ? '#4caf50' : '#f44336'};
              color: white;
              padding: 15px 25px;
              border-radius: 8px;
              box-shadow: 0 4px 12px rgba(0,0,0,0.2);
              z-index: 10000;
              animation: slideIn 0.3s ease-out;
          \`;
          
          document.body.appendChild(notification);
          
          setTimeout(() => {
              notification.style.animation = 'slideOut 0.3s ease-out';
              setTimeout(() => notification.remove(), 300);
          }, 3000);
      }
      
      document.getElementById('url').addEventListener('keypress', function(e) {
          if (e.key === 'Enter') {
              createProxy();
          }
      });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8'
    }
  });
}
