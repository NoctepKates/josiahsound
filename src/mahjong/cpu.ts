// CPUの思考: 手牌分析(analysis.ts)の結果だけを使って打牌・鳴きを決める。
//
// 方針(v1):
//   ・ツモ・ロンは、判定で和了できると分かったら必ず宣言する(判断は GameRoom 側)。
//   ・リーチは、切ればテンパイになる牌があるなら必ず宣言し、待ちが最も多い牌を切る。
//   ・打牌は、切ったあとの13枚を「待ちの多さ > 単語で覆えた文字数 > あと1文字の単語数」
//     で評価し、最も良いものを選ぶ。ドラは切りにくくする。
//   ・鳴きは、鳴いたあと打牌してテンパイになるか、手が明確に進む場合だけ受ける。
//     既にテンパイしている手では鳴かない(役満の単語を除く)。リーチ後は鳴かない。
//   ・同点の場合はツモ切りを優先し、それ以外は手牌の並び順で決める(決定的で再現性がある)。

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
}

export interface CpuCallDecision {
  accept: boolean;
  word?: string;
}

function hanValue(han: number | 'y'): number {
  return han === 'y' ? 13 : han;
}

// 打牌評価のスコア。待ちが1つあるだけで、覆い方の差より常に大きくなる重みにする。
function optionScore(opt: DiscardOption, doraKinds: string[]): number {
  let score = opt.waits.length * 1000 + opt.covered * 20 + opt.nearWordCount * 3;
  if (doraKinds.includes(opt.discard)) score -= 150;
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

  if (handKinds.length === 0) {
    return { discardKind: '', riichi: false };
  }

  // リーチ後はツモ切りだけ(人間の制限は未実装だが、CPUはルール通りにする)。
  if (isRiichi && drawnKind && handKinds.includes(drawnKind)) {
    return { discardKind: drawnKind, riichi: false };
  }

  const full = [...handKinds, ...meldWordChars];
  if (full.length !== 14) {
    return {
      discardKind: fallbackDiscardKind(handKinds, dict, doraKinds, drawnKind),
      riichi: false,
    };
  }

  const options = analyzeDiscardOptions(full, handKinds, dict);
  if (options.length === 0) {
    return {
      discardKind: fallbackDiscardKind(handKinds, dict, doraKinds, drawnKind),
      riichi: false,
    };
  }

  // 手牌の並び順を同点時の決め手にするため、元の位置を覚える。
  const order = new Map<string, number>();
  handKinds.forEach((kind, idx) => {
    if (!order.has(kind)) order.set(kind, idx);
  });
  const compare = (a: DiscardOption, b: DiscardOption): number => {
    const scoreDiff = optionScore(b, doraKinds) - optionScore(a, doraKinds);
    if (scoreDiff !== 0) return scoreDiff;
    const drawnDiff = Number(b.discard === drawnKind) - Number(a.discard === drawnKind);
    if (drawnDiff !== 0) return drawnDiff;
    return (order.get(a.discard) ?? 0) - (order.get(b.discard) ?? 0);
  };

  // リーチできるなら、リーチになる打牌の中から最も良いものを選んで宣言する。
  if (riichiDiscards.length > 0) {
    const riichiOptions = options.filter((o) => riichiDiscards.includes(o.discard));
    if (riichiOptions.length > 0) {
      riichiOptions.sort(compare);
      return { discardKind: riichiOptions[0].discard, riichi: true };
    }
  }

  const sorted = [...options].sort(compare);
  return { discardKind: sorted[0].discard, riichi: false };
}

export function chooseCpuCall(input: CpuCallInput): CpuCallDecision {
  const { handKinds, meldWordChars, dict, doraKinds, candidates, isRiichi } = input;
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

  // 既にテンパイしている手は、役満の単語でもなければ鳴いて崩さない。
  if (baseline.waits.length > 0) {
    const yakuman = candidates.find((c) => c.han === 'y');
    if (yakuman) return { accept: true, word: yakuman.word };
    return decline;
  }

  let best: { word: string; rank: number } | null = null;

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
    const bestOptionScore = Math.max(...options.map((o) => optionScore(o, doraKinds)));
    const becomesTenpai = options.some((o) => o.waits.length > 0);

    // テンパイになるか、覆い方が明確に進む(スコア+20 = 1文字ぶん以上)場合だけ受ける。
    if (!becomesTenpai && bestOptionScore < baselineScore + 20) continue;

    const rank = bestOptionScore + hanValue(cand.han) * 15;
    if (!best || rank > best.rank) {
      best = { word: cand.word, rank };
    }
  }

  if (!best) return decline;
  return { accept: true, word: best.word };
}
