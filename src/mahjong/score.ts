import { isSpecialChar } from './tiles';
import type { WordDef } from './words';

export interface ScoreInput {
  words: string[];        // 和了時の分解に使われた単語リスト（14枚ぶん）
  dict: WordDef[];        // 飜数参照用の辞書
  doraIndicators: string[]; // ドラ表示牌（複数：通常1〜、裏ドラ含めるなら追加で渡す）
  handWithDoraCount: number; // 手牌中のドラ枚数（表ドラ+裏ドラの合計。呼び出し側で数える）
  riichi: boolean;
  ippatsu: boolean;
  isDealer: boolean;
  winType: 'ron' | 'tsumo';
}

export interface ScoreResult {
  isChiitoi: boolean;
  fu: number;
  han: number;
  baseHanBreakdown: { label: string; han: number }[];
  basePoints: number;      // 符×2^(2+飜)
  limitName: string | null; // 満貫/跳満/倍満/三倍満/役満
  payments: {
    // ron: 放銃者が払う額。tsumo: 各家からの受取額
    total: number;
    fromNonDealer?: number;
    fromDealer?: number;
  };
}

function hanForWord(word: string, dict: WordDef[]): number {
  const found = dict.find((d) => d.word === word);
  return found ? found.han : 1;
}

export function computeFu(words: string[], isChiitoi: boolean): number {
  if (isChiitoi) return 25; // 七対子判定は一律25符（丸めなし）
  let fu = 25; // 基本符（通常20符から変更）
  for (const w of words) {
    const hasSpecial = [...w].some((ch) => isSpecialChar(ch));
    fu += w.length * (hasSpecial ? 4 : 2);
  }
  // 通常役は10符単位に切り上げ
  return Math.ceil(fu / 10) * 10;
}

export function computeHan(
  words: string[],
  dict: WordDef[],
  doraCount: number,
  riichi: boolean,
  ippatsu: boolean,
): { han: number; breakdown: { label: string; han: number }[] } {
  const breakdown: { label: string; han: number }[] = [];
  let han = 0;
  for (const w of words) {
    const h = hanForWord(w, dict);
    han += h;
    breakdown.push({ label: w, han: h });
  }
  if (riichi) { han += 1; breakdown.push({ label: 'リーチ', han: 1 }); }
  if (ippatsu) { han += 1; breakdown.push({ label: '一発', han: 1 }); }
  if (doraCount > 0) { han += doraCount; breakdown.push({ label: `ドラ${doraCount}`, han: doraCount }); }
  return { han, breakdown };
}

function limitFor(han: number): { name: string | null; base: number | null } {
  if (han >= 13) return { name: '役満', base: 8000 };
  if (han >= 11) return { name: '三倍満', base: 6000 };
  if (han >= 8) return { name: '倍満', base: 4000 };
  if (han >= 6) return { name: '跳満', base: 3000 };
  if (han >= 5) return { name: '満貫', base: 2000 };
  return { name: null, base: null };
}

export function computeScore(input: ScoreInput): ScoreResult {
  // 七対子判定: 分解が全て2文字単語×7個の場合
  const isChiitoi = input.words.length === 7 && input.words.every((w) => w.length === 2);

  const fu = computeFu(input.words, isChiitoi);
  const { han, breakdown } = computeHan(
    input.words,
    input.dict,
    input.handWithDoraCount,
    input.riichi,
    input.ippatsu,
  );

  const limit = limitFor(han);
  let basePoints: number;
  if (limit.base !== null) {
    basePoints = limit.base;
  } else {
    basePoints = fu * Math.pow(2, 2 + han);
    // 天井（満貫未満での基本点は2000点=満貫の一歩手前で頭打ちにする一般ルールと同様）
    if (basePoints > 2000) basePoints = 2000;
  }

  const roundUp100 = (n: number) => Math.ceil(n / 100) * 100;

  let total = 0;
  let fromNonDealer: number | undefined;
  let fromDealer: number | undefined;

  if (input.winType === 'ron') {
    total = input.isDealer ? roundUp100(basePoints * 6) : roundUp100(basePoints * 4);
  } else {
    if (input.isDealer) {
      fromNonDealer = roundUp100(basePoints * 2);
      total = fromNonDealer * 3;
    } else {
      fromNonDealer = roundUp100(basePoints * 1);
      fromDealer = roundUp100(basePoints * 2);
      total = fromNonDealer * 2 + fromDealer;
    }
  }

  return {
    isChiitoi,
    fu,
    han,
    baseHanBreakdown: breakdown,
    basePoints,
    limitName: limit.name,
    payments: { total, fromNonDealer, fromDealer },
  };
}
