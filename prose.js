'use strict';
/**
 * prose.js — §4 문장화 단계. Claude API 1콜/일 (월 <$1).
 * ★사실 추가 권한 없음. 뼈대 JSON 값만 자연어화.
 *
 * 라이브 실행 조건: env ANTHROPIC_API_KEY + api.anthropic.com 접근.
 * 모델은 비용 최소화 위해 Haiku 계열 기본(환경변수로 변경 가능).
 */

const SYSTEM_PROMPT =
  '너는 F29 크립토 브리핑 문장화기다. 아래 JSON의 사실만 사용해 ' +
  '한국어 존댓말 브리핑을 쓴다. 규칙:\n' +
  '- 숫자 판정을 신설 변경 금지. JSON에 있는 값만 사용.\n' +
  "- verdict 문구('관망' 등) 그대로 유지. 다른 판정 단어 창작 금지.\n" +
  '- forbidden 배열의 단어 절대 사용 금지.\n' +
  '- 3~5문단. 비트코인 가격은 k 표기(62.7k), 이더리움은 숫자만(1771).\n' +
  '- 따옴표 중점 금지. 방향 예측 아닌 상태 서술로.\n' +
  "- 확정적 미래 표현('오를 것'/'하락한다') 금지. 사후 서술만.\n" +
  "- watch_next는 '다음 확인 조건'으로 문장화(지시 아님).";

async function generateProse(skeleton, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  const model = opts.model || process.env.F29_BRIEF_MODEL || 'claude-opus-4-8';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 미설정');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(skeleton) }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

module.exports = { generateProse, SYSTEM_PROMPT };
