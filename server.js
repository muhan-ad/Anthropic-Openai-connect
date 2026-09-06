// Anthropic-Openai-connect 服务入口
// 将 Claude Code 的 Anthropic Messages 请求转换为 OpenAI Chat Completions 并转发
const express = require('express');
const config = require('./src/config');
const { anthropicToOpenAI, openAIToAnthropic, openaiSseToAnthropic, estimateTokens } = require('./src/converter');
const { callUpstream, readUpstreamError } = require('./src/upstream');

const app = express();
app.use(express.json({ limit: '10mb' }));

// 可选本地鉴权：设置了 LOCAL_AUTH_TOKEN 时校验 Claude Code 携带的 token
function checkAuth(req, res, next) {
  const token = config.localAuthToken;
  if (!token) return next();
  const h = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : h;
  if (t === token) return next();
  return res.status(401).json({
    type: 'error',
    error: { type: 'authentication_error', message: 'invalid api token' },
  });
}

// 健康检查
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'Anthropic-Openai-connect', model: config.defaultModel });
});

// 模型列表（Claude Code 可选查询）
app.get('/v1/models', (req, res) => {
  const ids = new Set([config.defaultModel, ...Object.values(config.modelMap)]);
  res.json({
    object: 'list',
    data: [...ids].map((id) => ({ id, object: 'model', owned_by: 'anthropic-openai-connect' })),
  });
});

// token 估算（Claude Code 可选调用）
app.post('/v1/messages/count_tokens', (req, res) => {
  const body = req.body || {};
  const text = JSON.stringify(body.messages || body) || '';
  res.json({ input_tokens: estimateTokens(text) });
});

// 核心端点：Anthropic Messages
app.post('/v1/messages', checkAuth, async (req, res) => {
  try {
    const body = req.body || {};
    // 模型映射：命中映射表则替换，否则透传，最后回退默认模型
    const model = config.modelMap[body.model] || body.model || config.defaultModel;

    const oai = anthropicToOpenAI(body);
    oai.model = model;

    if (oai.stream) {
      await handleStream(req, res, oai, model);
    } else {
      await handleNonStream(res, oai, model);
    }
  } catch (err) {
    console.error('[messages] error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: err.message || 'internal error' },
      });
    } else {
      res.end();
    }
  }
});

async function handleNonStream(res, oai, model) {
  const upstream = await callUpstream(oai);
  if (!upstream.ok) {
    const detail = await readUpstreamError(upstream);
    return res.status(upstream.status).json({
      type: 'error',
      error: { type: 'api_error', message: `upstream ${upstream.status}: ${detail}` },
    });
  }
  const data = await upstream.json();
  res.json(openAIToAnthropic(data, model, estimateTokens(JSON.stringify(oai.messages))));
}

async function handleStream(req, res, oai, model) {
  const upstream = await callUpstream(oai);
  if (!upstream.ok) {
    const detail = await readUpstreamError(upstream);
    return res.status(upstream.status).json({
      type: 'error',
      error: { type: 'api_error', message: `upstream ${upstream.status}: ${detail}` },
    });
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  for await (const chunk of openaiSseToAnthropic(upstream.body, model)) {
    res.write(chunk);
  }
  res.end();
}

app.listen(config.port, config.host, () => {
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│  Anthropic-Openai-connect 已启动                      │');
  console.log('│  监听:    http://' + config.host + ':' + config.port + '                    │');
  console.log('│  上游:    ' + config.upstreamBaseUrl);
  console.log('│  默认模型: ' + config.defaultModel);
  console.log('│  Claude Code 配置: ANTHROPIC_BASE_URL=http://127.0.0.1:' + config.port);
  console.log('└──────────────────────────────────────────────────────┘');
});
