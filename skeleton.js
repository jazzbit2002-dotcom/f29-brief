'use strict';
/**
 * skeleton.js — 결정론 판정 엔진 (§1 매핑 + §2 verdict + §3 스키마)
 *
 * ★사실·verdict 확정 단계. LLM은 여기서 나온 값을 절대 못 바꾼다.
 * state.pro.gates 가 이미 계산돼 있으므로 재계산하지 않고 읽기만 한다.
 */

const FORBIDDEN = ['매수', '매도', '롱', '숏', '손절', '목표가', '진입', '추천', '적중', '보장'];

/** BTC k 표기 (62662 → "62.7k"). 표시·guard 대조용. */
function btcToK(n) {
  return (Math.round((n / 1000) * 10) / 10).toString() + 'k';
}

/**
 * §1: state.json → 평탄화된 사실 객체.
 * 필드명은 2026-07-04 실측 기준 확정.
 */
function mapState(state) {
  const p = state.pro || {};
  const v = state.volatility || {};
  const log0 = (state.log && state.log[0]) || {};
  return {
    date: (state.updated || new Date().toISOString()).slice(0, 10),
    anchor_ts: state.updated,
    risk: state.code,
    risk_prev: log0.from || null,
    btc: state.btc,
    eth: state.eth,
    gates: {
      demand: p.gates.demand,
      flow: p.gates.flow,
      price: p.gates.price,
      structure: p.gates.structure,
    },
    premBtc: p.premBtc, premBtcDir: p.premBtcDir,
    premEth: p.premEth, premEthDir: p.premEthDir,
    cvdBtc: p.cvdBtc, cvdBtcDir: p.cvdBtcDir,
    cvdEth: p.cvdEth, cvdEthDir: p.cvdEthDir,
    btcPos: p.btcPos, ethPos: p.ethPos,
    bounceBtc: p.bounceBtc, bounceEth: p.bounceEth,
    structBtc: p.structBtc, structEth: p.structEth,
    flowBtcDisp: p.flowBtcDisp, flowEthDisp: p.flowEthDisp,
    ethAttr: p.ethAttr,
    driftCnt: p.driftCnt,
    transition: p.transition,
    invalCore: p.invalCore,
    vol_mult: v.combined,
    vol_mult_btc: v.multBtc,
    vol_mult_eth: v.multEth,
    regime: (state.scorecard && state.scorecard.regime) || null,
  };
}

/**
 * §2: 결정론 verdict.
 * 코베 양자 음수(kobeFail)면 나머지가 아무리 좋아도 무조건 관망 (obs20 로직, 최상위).
 */
function decideVerdict(f) {
  const glist = [f.gates.demand, f.gates.flow, f.gates.price, f.gates.structure];
  const passCount = glist.filter((g) => g === 'PASS').length;
  const partialCount = glist.filter((g) => g === 'PARTIAL').length;

  const kobeFail = f.premBtcDir === 'NEG' && f.premEthDir === 'NEG';

  let verdict, reason;
  if (kobeFail) {
    verdict = '관망'; reason = 'G2_FAIL';           // [최상위 잠금]
  } else if (passCount < 2) {
    verdict = '관망'; reason = 'GATE_LOW';
  } else if (passCount >= 3 && !kobeFail && (f.bounceBtc > 0 || f.bounceEth > 0)) {
    verdict = '관찰 격상'; reason = 'WATCH_UP';
  } else {
    verdict = '관망(개선 방향)'; reason = 'GATE_IMPROVING';
  }

  // 근접미달 처리 (§2): flow가 PARTIAL이면 _NEAR 접미
  if (f.gates.flow === 'PARTIAL') reason += '_NEAR';

  return { verdict, reason, passCount, partialCount, kobeFail };
}

/**
 * watch_next 생성.
 * ★핸드오프 §2는 "flow==PARTIAL → 1H 현물 수요 확인 삽입"만 명시.
 *   그러나 §3 기대출력(2026-07-04, flow=UNMET)은 watch_next에
 *   ["코베 양전 전환","1H 현물 수요 확인"] 두 항목을 요구한다.
 *   → 기본 watch_next 생성 규칙이 §2에 미명세. 아래는 §3 기대출력을
 *     재현하도록 확장한 파생 규칙. 확정 전 Sky 승인 필요(코드 상단 FLAG).
 */
function buildWatchNext(f, v) {
  const out = [];
  const kobeNeg = f.premBtcDir === 'NEG' || f.premEthDir === 'NEG';
  if (kobeNeg) out.push('코베 양전 전환');
  // demand/flow 미충족(UNMET) 또는 flow 근접미달(PARTIAL) → 1H 현물 수요 확인
  if (f.gates.demand === 'UNMET' || f.gates.flow === 'UNMET' || f.gates.flow === 'PARTIAL') {
    out.push('1H 현물 수요 확인');
  }
  return out;
}

/**
 * §3: 뼈대 JSON = LLM 입력의 유일한 사실 원천.
 * verdict·watch_next·inval = 규칙 완전 고정.
 */
function buildSkeleton(state) {
  const f = mapState(state);
  const v = decideVerdict(f);
  const watch_next = buildWatchNext(f, v);

  return {
    date: f.date,
    anchor_ts: f.anchor_ts,
    risk: f.risk,
    risk_prev: f.risk_prev,
    // ★FIX-1: §3 원 스키마엔 없던 원시 가격. §4(62.7k/1771 출력)·§6(anchor) 필수.
    btc_price: f.btc,
    eth_price: f.eth,
    vol_mult: f.vol_mult,
    vol_mult_btc: f.vol_mult_btc,
    vol_mult_eth: f.vol_mult_eth,
    regime: f.regime,
    verdict: v.verdict,
    verdict_reason_code: v.reason,
    passCount: v.passCount,
    gates: f.gates,
    btc: {
      pos: f.btcPos, kobe: f.premBtc, kobeDir: f.premBtcDir,
      cvd: f.cvdBtc, cvdDir: f.cvdBtcDir,
      spot_deriv: f.flowBtcDisp, bounce: f.bounceBtc, struct: f.structBtc,
    },
    eth: {
      pos: f.ethPos, kobe: f.premEth, kobeDir: f.premEthDir,
      cvd: f.cvdEth, cvdDir: f.cvdEthDir,
      spot_deriv: f.flowEthDisp, bounce: f.bounceEth, struct: f.structEth,
      attr: f.ethAttr,
    },
    transition: f.transition,
    inval: f.invalCore,
    drift: f.driftCnt,
    watch_next,
    forbidden: FORBIDDEN.slice(),
  };
}

module.exports = { mapState, decideVerdict, buildWatchNext, buildSkeleton, btcToK, FORBIDDEN };
