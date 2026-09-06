// 上游转发：将 OpenAI 格式请求发送到上游兼容端点（Node 18+ 内置 fetch）

const config = require('./config');

/**
 * 调用上游 OpenAI 兼容端点
 * @param {object} oaiBody OpenAI Chat Completions 请求体
 * @returns {Promise<Response>} fetch Response（未检查 ok）
 */
async function callUpstream(oaiBody) {
  const base = config.upstreamBaseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.upstreamApiKey}`,
  };

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(oaiBody),
  });
}

/** 读取上游错误响应的可读信息（JSON 或纯文本） */
async function readUpstreamError(res) {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    return (j.error && (j.error.message || j.error.code)) || text;
  } catch {
    return text;
  }
}

module.exports = { callUpstream, readUpstreamError };
