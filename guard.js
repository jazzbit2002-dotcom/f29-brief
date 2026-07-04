'use strict';
/**
 * guard.js — §5 폴백 필터. B(순수 LLM)와 C(하이브리드)를 가르는 이중 안전망.
 *
 * LLM 출력을 뼈대 사실과 대조. REJECT 시 순수 템플릿(A)으로 자동 폴백.
 * 무인 운영 전제 → 느슨함보다 엄격함 우선(과-REJECT는 템플릿 폴백으로 안전 착지).
 */

const { btcToK } = require('./skeleton');

// 뉘앙스 경계어 — REJECT 아님, WARN 로그만 (방향 암시 감시)
const NUANCE_WARN = ['긍정적 흐름', '회복세', '반등 시작', '상승 전환', '바닥', '저점 매수'];

/**
 * 뼈대에서 "허용 숫자 토큰" 집합 생성.
 * 원값 + 절대값 + 표시형(k표기, 정수반올림)까지 포함해 정상 프로즈의 과-REJECT 방지.
 */
function buildAllowedNumbers(sk) {
  const allow = new Set();
  const add = (n) => {
    if (n === null || n === undefined || n === '' || isNaN(Number(n))) return;
    const x = Number(n);
    allow.add(String(x));                 // 62662, -0.08, 76.5
    allow.add(String(Math.abs(x)));        // 0.08
    allow.add(String(Math.round(x)));      // 정수 반올림형
  };

  add(sk.btc_price); add(sk.eth_price);   // 원시 가격 (62662 / 1771)
  add(sk.vol_mult); add(sk.vol_mult_btc); add(sk.vol_mult_eth);
  add(sk.passCount); allow.add('4');       // 게이트 분모 x/4
  add(sk.drift);
  for (const k of ['pos', 'kobe', 'cvd', 'bounce', 'struct']) {
    add(sk.btc[k]); add(sk.eth[k]);
  }
  // BTC k 표기: "62.7k" → k 접미 제거 후 62.7 허용
  const kNum = btcToK(sk.btc_price).replace('k', '');
  allow.add(kNum);
  // risk 등급의 숫자부 (R5→5, R4→4)
  if (sk.risk) add(String(sk.risk).replace(/\D/g, ''));
  if (sk.risk_prev) add(String(sk.risk_prev).replace(/\D/g, ''));

  return allow;
}

/**
 * 프로즈에서 "데이터 숫자"만 추출.
 * - 영문/숫자 라벨 내부 숫자 제외: F29→29, R5→5, GA4→4, 1H→1 (앞뒤 ASCII 영숫자 차단)
 * - 한글 조사 붙은 숫자는 포함: "1771에서"→1771, "99999입니다"→99999
 * - 후행 k/K는 허용 후 분리: "62.7k"→62.7
 */
function extractNumbers(text) {
  const re = /(?<![A-Za-z0-9.])-?\d+(?:\.\d+)?(?:[kK])?(?![A-Za-z0-9])/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0].replace(/[kK]$/, ''));
  }
  return out;
}

/**
 * §5 검사 실행.
 * return { ok, rejects:[...], warns:[...] }
 */
function inspect(prose, sk) {
  const rejects = [];
  const warns = [];

  // 1. 금지어 스캔
  for (const w of sk.forbidden) {
    if (prose.includes(w)) rejects.push(`FORBIDDEN:${w}`);
  }

  // 2-a. verdict 단어 변조: 뼈대 verdict가 프로즈에 반드시 존재해야 함
  if (!prose.includes(sk.verdict)) {
    rejects.push(`VERDICT_MISSING:${sk.verdict}`);
  }
  // 2-b. 뼈대와 다른 판정 단어 창작 금지
  const otherVerdicts = ['관찰 격상', '관망(개선 방향)', '관망'].filter((x) => x !== sk.verdict);
  for (const ov of otherVerdicts) {
    // '관망'은 '관망(개선 방향)'의 부분문자열이므로 정확 판정어만 별도 취급 생략:
    // 뼈대 verdict가 포함하지 않는 다른 판정어가 등장하면 REJECT
    if (ov !== '관망' && prose.includes(ov)) rejects.push(`VERDICT_ALT:${ov}`);
  }

  // 2-c. 숫자 대조 (환각 방지)
  const allow = buildAllowedNumbers(sk);
  const nums = extractNumbers(prose);
  for (const n of nums) {
    if (!allow.has(n) && !allow.has(String(Math.abs(Number(n))))) {
      rejects.push(`NUM_HALLUCINATION:${n}`);
    }
  }

  // 3. 뉘앙스 경계어 → WARN만
  for (const w of NUANCE_WARN) {
    if (prose.includes(w)) warns.push(`NUANCE:${w}`);
  }

  return { ok: rejects.length === 0, rejects, warns };
}

/**
 * 순수 템플릿(A) 폴백. 기계적이지만 안전. 무인 운영 최악 보장선.
 */
function templateFallback(sk) {
  const kobeDir = (sk.btc.kobeDir === 'NEG' && sk.eth.kobeDir === 'NEG')
    ? 'NEG' : `BTC ${sk.btc.kobeDir}/ETH ${sk.eth.kobeDir}`;
  const wn = sk.watch_next.length ? sk.watch_next.join(', ') : '없음';
  return (
    `오늘 F29 위험 단계는 ${sk.risk}입니다. 게이트 ${sk.passCount}/4, ` +
    `코베 프리미엄 양자 ${kobeDir}. verdict: ${sk.verdict}. ` +
    `다음 확인 조건: ${wn}. (투자 판단 신호 아님)`
  );
}

module.exports = { inspect, templateFallback, buildAllowedNumbers, extractNumbers, NUANCE_WARN };
