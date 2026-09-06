// 配置中心：优先读取 .env（dotenv），未配置时使用默认值
require('dotenv').config();

function parseModelMap(raw) {
  // 格式: claude-haiku=deepseek-v4-flash-0731,claude-opus=deepseek-v4-pro
  const map = {};
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) map[k] = v;
  }
  return map;
}

const config = {
  // 监听地址：默认 127.0.0.1 仅本机可访问；除非配置了鉴权，否则不要改成 0.0.0.0
  host: process.env.HOST || '127.0.0.1',

  // 本服务监听端口（Claude Code 的 ANTHROPIC_BASE_URL 指向 http://127.0.0.1:<port>）
  port: parseInt(process.env.PORT || '18880', 10),

  // 上游 OpenAI 兼容端点（默认阿里云百炼）
  upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',

  // 上游 API Key（如百炼 sk-xxx）
  upstreamApiKey: process.env.UPSTREAM_API_KEY || '',

  // 默认模型：请求未带 model 或映射表无匹配时使用
  defaultModel: process.env.DEFAULT_MODEL || 'deepseek-v4-flash-0731',

  // 模型映射：Claude Code 里配置的模型名 -> 上游模型名；无匹配则透传原模型名
  modelMap: parseModelMap(process.env.MODEL_MAP || ''),

  // 本地鉴权 Token（可选）：设置后，Claude Code 的 x-api-key/Authorization 必须等于该值；留空则不校验
  localAuthToken: process.env.LOCAL_AUTH_TOKEN || '',
};

module.exports = config;
