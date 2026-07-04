'use strict';
/**
 * review.js — §6 사후검증. 처음부터 같은 파일에 스키마 박음(소급 불가).
 *
 * N일 후 cron이 history.d7에서 앵커ts 이후 max/min 추출 → anchor_high/low.
 * ★"안 떨어졌나"가 아니라 "진입 손익비"로 측정 (#19 EQ-RTH buy-hold 전례).
 *   관망을 무조건 정당화하지 않음 = 트랙레코드 정직성.
 */

/** 사후검증 스키마 초기 골격 (브리핑 저장 시 동시 생성). */
function initReviewSchema(sk) {
  return {
    date: sk.date,
    verdict: sk.verdict,
    risk: sk.risk,
    anchor: { btc: sk.btc.pos !== undefined ? sk.btcAnchor : undefined },
    // 실제 anchor는 원시 가격이 필요 → generator에서 주입
    review: {
      d1: { btc: null, eth: null, filled: false },
      d3: { btc: null, eth: null, filled: false },
      d7: { btc: null, eth: null, filled: false },
    },
    anchor_high: { d7_max_btc: null, d7_max_eth: null },
    anchor_low: { d7_min_btc: null, d7_min_eth: null },
    verdict_eval: {
      missed_upside: null,
      avoided_downside: null,
      risk_reward_if_entered: null,
    },
    verdict_correct: null,
  };
}

/**
 * history.d7 배열에서 앵커ts 이후 구간의 btc/eth max·min 추출.
 * d7[i] = { t, r, btc, eth }.  t는 ISO 또는 epoch — 둘 다 허용.
 */
function extractHighLow(d7, anchorTs) {
  const anchorMs = new Date(anchorTs).getTime();
  const after = (d7 || []).filter((row) => new Date(row.t).getTime() >= anchorMs);
  if (after.length === 0) return null;
  const btcs = after.map((r) => r.btc);
  const eths = after.map((r) => r.eth);
  return {
    d7_max_btc: Math.max(...btcs),
    d7_min_btc: Math.min(...btcs),
    d7_max_eth: Math.max(...eths),
    d7_min_eth: Math.min(...eths),
  };
}

/**
 * verdict_eval 계산 + verdict_correct 판정.
 * BTC 기준으로 손익비 산출(앵커 자산 = BTC). ETH 병행 기록은 확장 여지.
 */
function evalVerdict(anchor, hl) {
  const missed_upside = ((hl.d7_max_btc - anchor.btc) / anchor.btc) * 100;
  const avoided_downside = ((anchor.btc - hl.d7_min_btc) / anchor.btc) * 100;
  const rr = avoided_downside > 0 ? missed_upside / avoided_downside : Infinity;

  const round2 = (x) => (x === Infinity ? Infinity : Math.round(x * 100) / 100);
  return {
    missed_upside: round2(missed_upside),
    avoided_downside: round2(avoided_downside),
    risk_reward_if_entered: round2(rr),
  };
}

/**
 * §6 중립 판정 규칙 (verdict === "관망" 계열일 때).
 */
function judgeCorrect(evalObj) {
  const { missed_upside, avoided_downside, risk_reward_if_entered } = evalObj;
  if (risk_reward_if_entered < 1.0) return '손실회피 적중';        // 하방>상방, 관망 옳음
  if (missed_upside > 5 && avoided_downside < 2) return '기회비용 발생'; // 놓침, 관망 틀림
  return '중립';                                                   // 판단 유보
}

/**
 * 완성 파이프라인: 저장된 브리핑 + 갱신된 state.history.d7 → 사후검증 채움.
 * brief.anchor = { btc, eth, ts } 필요.
 */
function fillReview(brief, d7) {
  const hl = extractHighLow(d7, brief.anchor.ts);
  if (!hl) return { ...brief, _reviewNote: 'd7 앵커 이후 데이터 없음' };

  const evalObj = evalVerdict(brief.anchor, hl);
  const isWatch = String(brief.verdict).startsWith('관망');
  const verdict_correct = isWatch ? judgeCorrect(evalObj) : null; // 관망 계열만 이 규칙 적용

  return {
    ...brief,
    anchor_high: { d7_max_btc: hl.d7_max_btc, d7_max_eth: hl.d7_max_eth },
    anchor_low: { d7_min_btc: hl.d7_min_btc, d7_min_eth: hl.d7_min_eth },
    verdict_eval: evalObj,
    verdict_correct,
  };
}

module.exports = { initReviewSchema, extractHighLow, evalVerdict, judgeCorrect, fillReview };
