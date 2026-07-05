'use strict';
/**
 * generator.js — 파이프라인 오케스트레이션 (§0 ①~⑤).
 * cron 1회/일: collect → skeleton → prose → guard → archive.
 * 별도 cron: review 채움 (N일 후 history.d7에서 max/min 추출).
 *
 * 사용:
 *   node generator.js run          # 오늘 브리핑 생성
 *   node generator.js review       # 미완 사후검증 채움
 */

const fs = require('fs');
const path = require('path');
const { buildSkeleton } = require('./skeleton');
const { inspect, templateFallback } = require('./guard');
const { generateProse } = require('./prose');
const { fillReview } = require('./review');

const BRIEFS_DIR = path.join(__dirname, 'briefs');
const INDEX_FILE = path.join(BRIEFS_DIR, 'brief_index.json');
const STATE_URL = process.env.F29_STATE_URL || 'https://f29.io/api/state/pro';

// ① collector — Risk Monitor(3000) state.json을 curl/fetch. (계산 0, 소유권 Risk Monitor)
async function collect() {
  const res = await fetch(STATE_URL);
  if (!res.ok) throw new Error(`state fetch ${res.status}`);
  return res.json();
}

// 연속성(§한계1): 가장 최근 전일 브리핑에서 범주형 상태만 추출.
// 원시 소수값은 넣지 않는다 → guard 숫자 대조에 새 숫자 유입 없음.
function loadPrev(currentDate) {
  if (!fs.existsSync(BRIEFS_DIR)) return null;
  const files = fs.readdirSync(BRIEFS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < `${currentDate}.json`)
    .sort();
  if (!files.length) return null;
  const prev = JSON.parse(fs.readFileSync(path.join(BRIEFS_DIR, files[files.length - 1]), 'utf8'));
  const s = prev.skeleton || {};
  return {
    date: prev.date,
    risk: s.risk,
    verdict: prev.verdict || s.verdict,
    passCount: s.passCount,
    btc: s.btc ? { kobeDir: s.btc.kobeDir, cvdDir: s.btc.cvdDir } : null,
    eth: s.eth ? { kobeDir: s.eth.kobeDir, cvdDir: s.eth.cvdDir } : null,
  };
}

// ③④ prose + guard: LLM 시도 → 실패 시 템플릿 폴백
async function proseWithGuard(skeleton) {
  try {
    const prose = await generateProse(skeleton);
    const g = inspect(prose, skeleton);
    if (g.ok) return { text: prose, source: 'llm', guard: g };
    console.warn('[guard] REJECT → 템플릿 폴백:', g.rejects.join(', '));
    return { text: templateFallback(skeleton), source: 'template_fallback', guard: g };
  } catch (e) {
    console.warn('[prose] API 실패 → 템플릿 폴백:', e.message);
    return { text: templateFallback(skeleton), source: 'template_error', guard: null };
  }
}

// ⑤ archive: 브리핑 + 사후검증 스키마 = 같은 파일 (§6 소급 불가)
function archive(skeleton, proseResult) {
  const brief = {
    date: skeleton.date,
    generated_at: new Date().toISOString(),
    verdict: skeleton.verdict,   // ★FIX-4: review isWatch 판정용 (§6 스키마 최상위 필드)
    risk: skeleton.risk,
    skeleton,
    prose: proseResult.text,
    prose_source: proseResult.source,
    guard: proseResult.guard,
    // ★사후검증 스키마 (§6) — 처음부터 같은 파일
    anchor: { btc: skeleton.btc_price, eth: skeleton.eth_price, ts: skeleton.anchor_ts },
    review: {
      d1: { btc: null, eth: null, filled: false },
      d3: { btc: null, eth: null, filled: false },
      d7: { btc: null, eth: null, filled: false },
    },
    anchor_high: { d7_max_btc: null, d7_max_eth: null },
    anchor_low: { d7_min_btc: null, d7_min_eth: null },
    verdict_eval: { missed_upside: null, avoided_downside: null, risk_reward_if_entered: null },
    verdict_correct: null,
  };

  if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const file = path.join(BRIEFS_DIR, `${skeleton.date}.json`);
  fs.writeFileSync(file, JSON.stringify(brief, null, 2));

  // 인덱스 갱신 (조회용, render는 계산 0)
  let idx = [];
  if (fs.existsSync(INDEX_FILE)) idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  idx = idx.filter((e) => e.date !== skeleton.date);
  idx.unshift({ date: skeleton.date, verdict: skeleton.verdict, risk: skeleton.risk });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
  return file;
}

async function run() {
  const state = await collect();
  const skeleton = buildSkeleton(state);        // ② ★verdict·사실 확정
  skeleton.prev = loadPrev(skeleton.date);      // 연속성 주입 (없으면 null)
  const proseResult = await proseWithGuard(skeleton);
  const file = archive(skeleton, proseResult);
  console.log(`[brief] ${skeleton.date} verdict=${skeleton.verdict} source=${proseResult.source} → ${file}`);
}

// review 채움: 미완 브리핑에 대해 현재 state.history.d7로 max/min 추출
async function reviewPass() {
  const state = await collect();
  const d7 = (state.history && state.history.d7) || [];
  const files = fs.readdirSync(BRIEFS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const f of files) {
    const p = path.join(BRIEFS_DIR, f);
    const brief = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (brief.verdict_correct !== null) continue;            // 이미 완료
    const ageDays = (Date.now() - new Date(brief.anchor.ts).getTime()) / 86400000;
    if (ageDays < 7) continue;                               // d7 미도래
    const filled = fillReview(brief, d7);
    if (filled.verdict_correct != null) {
      fs.writeFileSync(p, JSON.stringify(filled, null, 2));
      console.log(`[review] ${brief.date} → ${filled.verdict_correct} (rr=${filled.verdict_eval.risk_reward_if_entered})`);
    }
  }
}

if (require.main === module) {
  const cmd = process.argv[2] || 'run';
  (cmd === 'review' ? reviewPass() : run()).catch((e) => {
    console.error('[fatal]', e.message);
    process.exit(1);
  });
}

module.exports = { collect, loadPrev, proseWithGuard, archive, run, reviewPass };
