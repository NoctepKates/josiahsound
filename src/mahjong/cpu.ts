// CPUの思考: 手牌分析(analysis.ts)の結果だけを使って打牌・鳴きを決める。
//
// 強さ(1〜5)。5が最強で、決定的な最善手を打つ。弱いほど、評価を無視した
// ランダムな打牌・鳴きが増え、リーチや和了を見逃すこともある。ロン・ツモの
// 見逃し確率は GameRoom 側(decideCpuPending / runCpuTurn)で使う。
//   ・打牌は、切ったあとの13枚を「待ちの多さ > 単語で覆えた文字数 > あと1文字の単語数」
//     で評価し、最も良いものを選ぶ。強いCPUほどドラを切りにくくする。
//   ・リーチは、切ればテンパイになる牌があるなら確率で宣言する(5は必ず宣言)。
//   ・鳴きは、鳴いたあと打牌してテンパイになるか、手が明確に進む場合だけ受ける。
//     既にテンパイしている手では鳴かない(役満の単語を除く)。リーチ後は鳴かない。
//     1だけは、たまに評価に関係なく鳴いてしまう。
//   ・同点の場合はツモ切りを優先し、それ以外は手牌の並び順で決める(決定的で再現性がある)。
// 乱数は rng 引数で差し替えられる(未指定なら Math.random)。テストでは rng を固定する。

import { analyzeDiscardOptions, evaluateRemaining, DiscardOption } from './analysis';
import { CallCandidate, WordDef } from './words';

export interface CpuDiscardInput {
  handKinds: string[]; // 伏せた手牌の牌種(鳴いた分は含まない)
  meldWordChars: string[]; // 鳴いた単語の文字(各 meld の word を split したもの)
  dict: WordDef[];
  doraKinds: string[]; // 現在のドラの牌種(リーチ中は裏ドラも含める)
  drawnKind: string | null; // 今ツモった牌の牌種(親の配牌直後や鳴き直後は null)
  riichiDiscards: string[]; // GameRoom.computeRiichiDiscards の結果(条件検証済み)
  isRiichi: boolean;
  strength?: number; // 1〜5。未指定なら5(最強・決定的)。
  rng?: () => number; // 0以上1未満を返す関数。未指定なら Math.random。
}

export interface CpuDiscardDecision {
  discardKind: string;
  riichi: boolean;
}

export interface CpuCallInput {
  handKinds: string[];
  meldWordChars: string[];
  dict: WordDef[];
  doraKinds: string[];
  candidates: CallCandidate[];
  isRiichi: boolean;
  strength?: number; // 1〜5。未指定なら5(最強・決定的)。
  rng?: () => number; // 0以上1未満を返す関数。未指定なら Math.random。
}

export interface CpuCallDecision {
  accept: boolean;
  word?: string;
}

export interface CpuStrengthConfig {
  randomDiscard: number; // 評価を無視してランダムに切る確率
  riichiChance: number; // リーチできる時に宣言する確率
  callImproveThreshold: number; // 鳴きでテンパイしない場合に必要な改善幅(スコア差)
  callTenpaiChance: number; // 鳴いてテンパイになる時に受ける確率
  callBlunderChance: number; // 評価に関係なくランダムに鳴く確率
  winMissChance: number; // ロン・ツモを見逃す確率(GameRoom 側で使う)
  doraPenalty: number; // ドラ切りを避ける重み
}

// クライアントや古いセーブから来た強さを 1〜5 に正規化する。不正な値は3(ふつう)。
export function normalizeCpuStrength(value: unknown): 1 | 2 | 3 | 4 | 5 {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.floor(n))) as 1 | 2 | 3 | 4 | 5;
}

// 強さごとの設定。未指定は5扱い(従来の決定的な最善手と同じ)。
export function cpuStrengthConfig(strength: number | undefined): CpuStrengthConfig {
  const s = strength === undefined ? 5 : normalizeCpuStrength(strength);
  switch (s) {
    case 1:
      return { randomDiscard: 0.6, riichiChance: 0.3, callImproveThreshold: Number.POSITIVE_INFINITY, callTenpaiChance: 0.7, callBlunderChance: 0.1, winMissChance: 0.2, doraPenalty: 0 };
    case 2:
      return { randomDiscard: 0.4, riichiChance: 0.5, callImproveThreshold: 60, callTenpaiChance: 0.85, callBlunderChance: 0, winMissChance: 0.1, doraPenalty: 0 };
    case 3:
      return { randomDiscard: 0.25, riichiChance: 0.7, callImproveThreshold: 30, callTenpaiChance: 0.95, callBlunderChance: 0, winMissChance: 0.05, doraPenalty: 75 };
    case 4:
      return { randomDiscard: 0.1, riichiChance: 0.9, callImproveThreshold: 20, callTenpaiChance: 1, callBlunderChance: 0, winMissChance: 0.02, doraPenalty: 150 };
    default:
      return { randomDiscard: 0, riichiChance: 1, callImproveThreshold: 20, callTenpaiChance: 1, callBlunderChance: 0, winMissChance: 0, doraPenalty: 150 };
  }
}

function hanValue(han: number | 'y'): number {
  return han === 'y' ? 13 : han;
}

// 打牌評価のスコア。待ちが1つあるだけで、覆い方の差より常に大きくなる重みにする。
function optionScore(opt: DiscardOption, doraKinds: string[], doraPenalty: number): number {
  let score = opt.waits.length * 1000 + opt.covered * 20 + opt.nearWordCount * 3;
  if (doraKinds.includes(opt.discard)) score -= doraPenalty;
  return score;
}

function remainingScore(waits: number, covered: number, nearWordCount: number): number {
  return waits * 1000 + covered * 20 + nearWordCount * 3;
}

// 分析が使えない手(14枚でない場合など)のフォールバック:
// 辞書の単語にあまり出てこない牌種から切る。ドラは避け、ツモ牌を優先する。
function fallbackDiscardKind(
  handKinds: string[],
  dict: WordDef[],
  doraKinds: string[],
  drawnKind: string | null,
): string {
  const inWords = new Map<string, number>();
  for (const d of dict) {
    for (const ch of new Set([...d.word])) {
      inWords.set(ch, (inWords.get(ch) || 0) + 1);
    }
  }
  let best = handKinds[0];
  let bestKey = Number.POSITIVE_INFINITY;
  handKinds.forEach((kind, idx) => {
    let key = (inWords.get(kind) || 0) * 100 + idx;
    if (doraKinds.includes(kind)) key += 10000;
    if (kind === drawnKind) key -= 50;
    if (key < bestKey) {
      bestKey = key;
      best = kind;
    }
  });
  return best;
}

export function chooseCpuDiscard(input: CpuDiscardInput): CpuDiscardDecision {
  const { handKinds, meldWordChars, dict, doraKinds, drawnKind, riichiDiscards, isRiichi } = input;
  const cfg = cpuStrengthConfig(input.strength);
  const rand = input.rng ?? Math.random;

  if (handKinds.length === 0) {
    return { discardKind: '', riichi: false };
  }

  // リーチ後はツモ切りだけ(人間の制限は未実装だが、CPUはルール通りにする)。
  if (isRiichi && drawnKind && handKinds.includes(drawnKind)) {
    return { discardKind: drawnKind, riichi: false };
  }

  // 分析が使えない手の切り方。弱いCPUはたまにランダムに切る。
  const fallbackKind = (): string =>
    rand() < cfg.randomDiscard
      ? handKinds[Math.floor(rand() * handKinds.length)]
      : fallbackDiscardKind(handKinds, dict, doraKinds, drawnKind);

  const full = [...handKinds, ...meldWordChars];
  if (full.length !== 14) {
    return { discardKind: fallbackKind(), riichi: false };
  }

  const options = analyzeDiscardOptions(full, handKinds, dict);
  if (options.length === 0) {
    return { discardKind: fallbackKind(), riichi: false };
  }

  // 手牌の並び順を同点時の決め手にするため、元の位置を覚える。
  const order = new Map<string, number>();
  handKinds.forEach((kind, idx) => {
    if (!order.has(kind)) order.set(kind, idx);
  });
  const compare = (a: DiscardOption, b: DiscardOption): number => {
    const scoreDiff = optionScore(b, doraKinds, cfg.doraPenalty) - optionScore(a, doraKinds, cfg.doraPenalty);
    if (scoreDiff !== 0) return scoreDiff;
    const drawnDiff = Number(b.discard === drawnKind) - Number(a.discard === drawnKind);
    if (drawnDiff !== 0) return drawnDiff;
    return (order.get(a.discard) ?? 0) - (order.get(b.discard) ?? 0);
  };

  // リーチできるなら、確率で宣言する。見逃した場合は普通の打牌に進む。
  // (rng の消費順: リーチ判定 → ランダム打牌判定 → ランダムな牌の選択)
  if (riichiDiscards.length > 0) {
    const riichiOptions = options.filter((o) => riichiDiscards.includes(o.discard));
    if (riichiOptions.length > 0 && rand() < cfg.riichiChance) {
      riichiOptions.sort(compare);
      return { discardKind: riichiOptions[0].discard, riichi: true };
    }
  }

  // 弱いCPUはたまに評価を無視してランダムに切る。
  if (rand() < cfg.randomDiscard) {
    const pick = options[Math.floor(rand() * options.length)];
    return { discardKind: pick.discard, riichi: false };
  }

  const sorted = [...options].sort(compare);
  return { discardKind: sorted[0].discard, riichi: false };
}

export function chooseCpuCall(input: CpuCallInput): CpuCallDecision {
  const { handKinds, meldWordChars, dict, doraKinds, candidates, isRiichi } = input;
  const cfg = cpuStrengthConfig(input.strength);
  const rand = input.rng ?? Math.random;
  const decline: CpuCallDecision = { accept: false };

  if (isRiichi || candidates.length === 0 || dict.length === 0) return decline;

  const currentFull = [...handKinds, ...meldWordChars];
  // 鳴き判断の土台は13枚の手。想定外の枚数なら高飜の単語だけ受ける。
  if (currentFull.length !== 13) {
    const best = [...candidates].sort(
      (a, b) => hanValue(b.han) - hanValue(a.han) || b.word.length - a.word.length,
    )[0];
    if (hanValue(best.han) >= 4) return { accept: true, word: best.word };
    return decline;
  }

  const baseline = evaluateRemaining(currentFull, dict);
  const baselineScore = remainingScore(baseline.waits.length, baseline.covered, baseline.nearWordCount);

  // 強さ1だけは、たまに評価に関係なく鳴いてしまう(テンパイ中でも)。
  // (rng の消費順: ポカ鳴き判定 → 候補の選択、またはテンパイ成立時の受ける確率判定)
  if (cfg.callBlunderChance > 0 && rand() < cfg.callBlunderChance) {
    const pick = candidates[Math.floor(rand() * candidates.length)];
    return { accept: true, word: pick.word };
  }

  // 既にテンパイしている手は、役満の単語でもなければ鳴いて崩さない。
  if (baseline.waits.length > 0) {
    const yakuman = candidates.find((c) => c.han === 'y');
    if (yakuman) return { accept: true, word: yakuman.word };
    return decline;
  }

  let best: { word: string; rank: number; becomesTenpai: boolean } | null = null;

  for (const cand of candidates) {
    // 鳴いたあとの手: 手牌から使う分を除き、単語の文字を鳴き分に加える。
    const remainingHand = [...handKinds];
    for (const ch of cand.usedFromHand) {
      const idx = remainingHand.indexOf(ch);
      if (idx !== -1) remainingHand.splice(idx, 1);
    }
    const postFull = [...remainingHand, ...meldWordChars, ...cand.word.split('')];
    if (postFull.length !== 14) continue;

    const options = analyzeDiscardOptions(postFull, remainingHand, dict);
    if (options.length === 0) continue;
    const bestOptionScore = Math.max(...options.map((o) => optionScore(o, doraKinds, cfg.doraPenalty)));
    const becomesTenpai = options.some((o) => o.waits.length > 0);

    // テンパイになるか、覆い方が明確に進む場合だけ受ける。弱いほど必要な改善幅が大きい。
    if (!becomesTenpai && bestOptionScore < baselineScore + cfg.callImproveThreshold) continue;

    const rank = bestOptionScore + hanValue(cand.han) * 15;
    if (!best || rank > best.rank) {
      best = { word: cand.word, rank, becomesTenpai };
    }
  }

  if (!best) return decline;
  // 鳴いてテンパイになる場合でも、弱いCPUはたまに見送る。
  if (best.becomesTenpai && !(rand() < cfg.callTenpaiChance)) return decline;
  return { accept: true, word: best.word };
}
