// 协议转换核心：Anthropic Messages <-> OpenAI Chat Completions
// 文档参考：
//   Anthropic Messages API: https://docs.anthropic.com/en/api/messages
//   OpenAI Chat Completions: https://platform.openai.com/docs/api-reference/chat

/** 将 Anthropic 请求体转换为 OpenAI 请求体 */
function anthropicToOpenAI(body) {
  const messages = [];

  // system：Anthropic 独立字段 -> OpenAI messages[0]
  const sys = body.system;
  if (sys) {
    let sysText = '';
    if (typeof sys === 'string') sysText = sys;
    else if (Array.isArray(sys)) {
      sysText = sys.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n');
    }
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  for (const msg of body.messages || []) {
    const content = msg.content;

    // 字符串内容直接透传
    if (typeof content === 'string') {
      messages.push({ role: msg.role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      messages.push({ role: msg.role, content: String(content ?? '') });
      continue;
    }

    if (msg.role === 'user') {
      // 用户消息可能同时含 text 与 tool_result
      const textParts = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const hasToolResult = content.some((b) => b.type === 'tool_result');

      if (hasToolResult) {
        if (textParts) messages.push({ role: 'user', content: textParts });
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          let tc = '';
          if (typeof b.content === 'string') tc = b.content;
          else if (Array.isArray(b.content)) tc = b.content.map((x) => (x.type === 'text' ? x.text : '')).join('');
          else if (b.content != null) tc = String(b.content);
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: tc });
        }
      } else {
        messages.push({ role: 'user', content: textParts || '' });
      }
    } else if (msg.role === 'assistant') {
      // 助手消息：text 块 -> content；tool_use 块 -> tool_calls
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolUses = content.filter((b) => b.type === 'tool_use');

      if (toolUses.length > 0) {
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolUses.map((tu, i) => ({
            id: tu.id || `call_${Date.now()}_${i}`,
            type: 'function',
            function: {
              name: tu.name,
              arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input ?? {}),
            },
          })),
        });
      } else {
        messages.push({ role: 'assistant', content: text });
      }
    } else {
      // 其他角色兜底
      messages.push({ role: msg.role, content: JSON.stringify(content) });
    }
  }

  const oai = {
    model: body.model,
    messages,
    stream: !!body.stream,
    max_tokens: body.max_tokens ?? 4096,
  };

  if (body.temperature !== undefined) oai.temperature = body.temperature;
  if (body.top_p !== undefined) oai.top_p = body.top_p;

  // tools：Anthropic -> OpenAI function calling
  // 注意：Anthropic 工具定义无 type 字段（{name, description, input_schema}），直接映射
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    oai.tools = body.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }));

    // tool_choice 映射
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc.type === 'any') oai.tool_choice = 'required';
      else if (tc.type === 'none') oai.tool_choice = 'none';
      else if (tc.type === 'auto') oai.tool_choice = 'auto';
      else if (tc.type === 'tool' && tc.name) {
        oai.tool_choice = { type: 'function', function: { name: tc.name } };
      }
    }
  }

  // 思考模式：Anthropic thinking -> 百炼等上游的 enable_thinking 字段
  if (body.thinking && body.thinking.type === 'enabled') {
    oai.enable_thinking = true;
  }

  return oai;
}

/** 将 OpenAI 非流式响应转换为 Anthropic 响应 */
function openAIToAnthropic(data, model, inputTokens) {
  const choice = data.choices && data.choices[0];
  const msg = (choice && choice.message) || {};
  const content = [];

  if (msg.content) {
    if (typeof msg.content === 'string') {
      if (msg.content) content.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === 'text' && c.text) content.push({ type: 'text', text: c.text });
      }
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    id: data.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(choice && choice.finish_reason, content),
    stop_sequence: null,
    usage: {
      input_tokens: (data.usage && data.usage.prompt_tokens) || inputTokens || 0,
      output_tokens: (data.usage && data.usage.completion_tokens) || 0,
    },
  };
}

/**
 * 将 OpenAI SSE 流转换为 Anthropic SSE 事件流（async generator）
 * 每个 yield 产出一段完整的事件文本："event: xxx\ndata: {...}\n\n"
 *
 * 注意：上游可能一次返回多个并行 tool_calls（index 0,1,2...），
 * 每个 index 必须独立生成 content_block_start/stop，否则客户端
 * 找不到对应块，报 "Content block not found"。
 */
async function* openaiSseToAnthropic(stream, model) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let blockIndex = 0;          // 全局 content block 索引（text 与 tool_use 共用）
  let textBlockActive = false;
  let textBlockIndex = 0;      // text 块占用的 index
  const toolBlocks = new Map(); // 上游 tool_calls 的 index -> { blockIndex, id, name }
  let finishReason = null;
  let outputTokens = 0;

  // message_start
  yield sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: estimateTokens(''), output_tokens: 0 },
    },
  });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = json.choices && json.choices[0];
      const delta = (choice && choice.delta) || {};
      if (!choice) continue;

      // 文本增量
      if (delta.content) {
        if (!textBlockActive) {
          textBlockActive = true;
          textBlockIndex = blockIndex++; // 分配 index 并递增，确保与后续 tool 块不冲突
          yield sseEvent('content_block_start', {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: { type: 'text', text: '' },
          });
        }
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }

      // 工具调用增量：按上游 tool_calls 的 index 分块，支持并行多工具
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tIdx = typeof tc.index === 'number' ? tc.index : toolBlocks.size;
          let tb = toolBlocks.get(tIdx);
          if (!tb) {
            tb = {
              blockIndex: blockIndex++, // 新工具块分配新 index
              id: tc.id || `toolu_${tIdx}`,
              name: (tc.function && tc.function.name) || '',
            };
            toolBlocks.set(tIdx, tb);
            yield sseEvent('content_block_start', {
              type: 'content_block_start',
              index: tb.blockIndex,
              content_block: {
                type: 'tool_use',
                id: tb.id,
                name: tb.name,
                input: {},
              },
            });
          }
          if (tc.function && tc.function.arguments) {
            yield sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: tb.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }

      // 结束：按块顺序关闭（先 text，再 tool；index 递增）
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        if (textBlockActive) {
          yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
          textBlockActive = false;
        }
        for (const [, tb] of toolBlocks) {
          yield sseEvent('content_block_stop', { type: 'content_block_stop', index: tb.blockIndex });
        }
        toolBlocks.clear();
      }

      if (json.usage && json.usage.completion_tokens) {
        outputTokens = json.usage.completion_tokens;
      }
    }
  }

  // 流意外结束时兜底关闭未关闭的块
  if (textBlockActive) {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
    textBlockActive = false;
  }
  for (const [, tb] of toolBlocks) {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: tb.blockIndex });
  }
  toolBlocks.clear();

  // message_delta + message_stop
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  yield sseEvent('message_stop', { type: 'message_stop' });
}

/** 生成一条 SSE 事件文本 */
function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** OpenAI finish_reason -> Anthropic stop_reason */
function mapStopReason(finishReason, content) {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  if (Array.isArray(content) && content.some((c) => c.type === 'tool_use')) return 'tool_use';
  return 'end_turn';
}

function mapFinishReason(finishReason) {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** 粗略估算 token 数（中文约 1 token/字，英文约 1 token/3-4 字符），仅供 usage 展示 */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - cjk;
  return Math.max(1, Math.round(cjk + other / 3.5));
}

module.exports = {
  anthropicToOpenAI,
  openAIToAnthropic,
  openaiSseToAnthropic,
  estimateTokens,
};
