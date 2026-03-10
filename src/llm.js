import OpenAI from 'openai';
import { execSync } from 'node:child_process';

const openai = new OpenAI({
  apiKey: process.env.OPENCLAW_GATEWAY_TOKEN,
  baseURL: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789/v1',
});

const SYSTEM_PROMPT = `あなたはクロウ、Discord音声チャットで会話するAIアシスタントです。

あなたの構成：
- STT: Whisper.cppローカル（smallモデル、日本語）
- LLM: Claude Sonnet（OpenClaw Gateway経由）
- TTS: VOICEVOX ずんだもん（48kHz）

重要なルール：
- 音声で話すので、短く自然な話し言葉で答えてください
- マークダウンや記号は使わないでください（絵文字も不要）
- 1〜2文で簡潔に答えてください。長くならないで
- 日本語で話してください
- 親しみやすく、でも丁寧に
- ツールや検索は使わず、知っている知識だけで答えてください
- 分からないことは「ちょっと分からないな」と正直に言ってOK`;

/**
 * memory-lancedb-pro CLI で関連記憶を検索
 * @param {string} query - 検索クエリ
 * @param {number} limit - 最大件数
 * @returns {string[]} 記憶テキストの配列
 */
function recallMemories(query, limit = 3) {
  try {
    const result = execSync(
      `openclaw memory-pro search ${JSON.stringify(query)} --scope global --limit ${limit} --json`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const data = JSON.parse(result);
    if (Array.isArray(data) && data.length > 0) {
      return data.map(m => m.text || m.content).filter(Boolean);
    }
  } catch (e) {
    console.warn('⚠️ Memory recall failed:', e.message);
  }
  return [];
}

/**
 * memory-lancedb-pro CLI で記憶を保存（非同期、失敗しても無視）
 * @param {string} text - 保存するテキスト
 * @param {string} category - カテゴリ（fact/preference/decision/entity）
 */
function storeMemory(text, category = 'fact') {
  try {
    execSync(
      `openclaw memory-pro store --text ${JSON.stringify(text)} --scope global --category ${category}`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    console.log(`💾 Memory stored: "${text.substring(0, 50)}..."`);
  } catch (e) {
    console.warn('⚠️ Memory store failed:', e.message);
  }
}

/**
 * Generate a response via OpenClaw Gateway with streaming.
 * Yields sentence chunks as they become available.
 * @param {string} userMessage
 * @param {string} userId
 * @returns {AsyncGenerator<string>} sentence chunks
 */
export async function* generateResponseStream(userMessage, userId) {
  try {
    // 関連記憶を検索してコンテキストに注入
    const memories = recallMemories(userMessage);
    let systemPrompt = SYSTEM_PROMPT;
    if (memories.length > 0) {
      const memoryBlock = memories.map((m, i) => `${i + 1}. ${m}`).join('\n');
      systemPrompt += `\n\n以下はこのユーザーに関する過去の記憶です。自然に活用してください：\n${memoryBlock}`;
      console.log(`🧠 Recalled ${memories.length} memories for context`);
    }

    const stream = await openai.chat.completions.create({
      model: 'openclaw:main',
      user: `voice:${userId}`,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 100,
    });

    let buffer = '';
    // Sentence-ending patterns for Japanese
    const sentenceEnd = /[。！？\n]/;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;

      buffer += delta;

      // Check for sentence boundaries
      let match;
      while ((match = sentenceEnd.exec(buffer)) !== null) {
        const sentence = buffer.substring(0, match.index + 1).trim();
        buffer = buffer.substring(match.index + 1);
        if (sentence.length > 0) {
          yield sentence;
        }
      }
    }

    // Yield remaining buffer
    if (buffer.trim().length > 0) {
      yield buffer.trim();
    }
  } catch (e) {
    console.error('LLM error:', e.message);
    yield 'ごめん、ちょっとエラーが起きちゃった。';
  }
}

/**
 * Non-streaming version (kept for compatibility)
 */
export async function generateResponse(userMessage, userId) {
  const chunks = [];
  for await (const chunk of generateResponseStream(userMessage, userId)) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

export { recallMemories, storeMemory };
