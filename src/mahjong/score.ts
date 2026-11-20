import { findSpecialYakus } from './yaku';
import { isSpecialChar } from './tiles';
import type { WordDef } from './words';

export interface ScoreInput {
  words: string[];        // 和了時の分解に使われた単語リスト（14枚ぶん）
  dict: WordDef[];        // 飜数参照用の辞書
  doraIndicators: string[]; // ドラ表示牌（複数：通常1〜、裏ドラ含めるなら追加で渡す）
  doraCount: number;      // 手牌中の表ドラ枚数
  uraDoraCount?: number;  // 手牌中の裏ドラ枚数（リーチした人のみ）
  honba?: number;         // 本場数（0のとき加算なし）
  riichi: boolean;
  ippatsu: boolean;
  isDealer: boolean;
  winType: 'ron' | 'tsumo';
}

export interface ScoreResult {
  isChiitoi: boolean;
  fu: number;
  han: number;
  baseHanBreakdown: { label: string; han: number | 'y' }[]; // 役満は 'y'
  basePoints: number;      // 符×2^(2+飜)
  limitName: string | null; // 満貫/跳満/倍満/三倍満/役満
  payments: {
    // ron: 放銃者が払う額。tsumo: 各家からの受取額
    total: number;
    fromNonDealer?: number;
    fromDealer?: number;
  };
}

function hanForWord(
  word: string,
  dict: WordDef[],
): number | 'y' {
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
  uraDoraCount = 0,
): {
  han: number;
  hasYakuman: boolean;
  breakdown: { label: string; han: number | 'y' }[];
} {
  const breakdown: { label: string; han: number | 'y' }[] = [];
  let han = 0;
  let hasYakuman = false;

  // 単語文字列 → 辞書定義に変換
  const wordDefs: WordDef[] = words
    .map((word) => dict.find((d) => d.word === word))
    .filter((d): d is WordDef => d !== undefined);

  // タグによる特殊役
  const specialYakus = findSpecialYakus(wordDefs);

  for (const yaku of specialYakus) {
    if (yaku.han === 'y') {
      hasYakuman = true;
      breakdown.push({
        label: yaku.name,
        han: 'y',
      });
    } else {
      han += yaku.han;
      breakdown.push({
        label: yaku.name,
        han: yaku.han,
      });
    }
  }

  // 単語そのものの飜数
  // 長い単語に完全に含まれている短い単語は無効化する。
  // 例:
  //   りんご
  //   でけえりんご
  // の場合、「りんご」は加算しない。
  const activeWords = words.filter((word, index) => {
    return !words.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      if (other.length <= word.length) return false;

      return other.includes(word);
    });
  });

  for (const w of activeWords) {
    const h = hanForWord(w, dict);

    if (h === 'y') {
      hasYakuman = true;
      breakdown.push({
        label: w,
        han: 'y',
      });
    } else {
      han += h;
      breakdown.push({
        label: w,
        han: h,
      });
    }
  }

  if (riichi) {
    han += 1;
    breakdown.push({ label: 'リーチ', han: 1 });
  }

  if (ippatsu) {
    han += 1;
    breakdown.push({ label: '一発', han: 1 });
  }

  // 表ドラと裏ドラは分けて、役一覧の最後に表示する
  if (doraCount > 0) {
    han += doraCount;
    breakdown.push({
      label: 'ドラ',
      han: doraCount,
    });
  }

  if (uraDoraCount > 0) {
    han += uraDoraCount;
    breakdown.push({
      label: '裏ドラ',
      han: uraDoraCount,
    });
  }

  return {
    han,
    hasYakuman,
    breakdown,
  };
}

function limitFor(
  han: number,
  hasYakuman: boolean,
): { name: string | null; base: number | null } {
  if (hasYakuman) {
    return { name: '役満', base: 8000 };
  }

  if (han >= 13) {
    return { name: '数え役満', base: 8000 };
  }

  if (han >= 11) {
    return { name: '三倍満', base: 6000 };
  }

  if (han >= 8) {
    return { name: '倍満', base: 4000 };
  }

  if (han >= 6) {
    return { name: '跳満', base: 3000 };
  }

  if (han >= 5) {
    return { name: '満貫', base: 2000 };
  }

  return { name: null, base: null };
}

export function computeScore(input: ScoreInput): ScoreResult {
  // 七対子判定: 分解が全て2文字単語×7個の場合
  const isChiitoi = input.words.length === 7 && input.words.every((w) => w.length === 2);

  const fu = computeFu(input.words, isChiitoi);
  const { han, hasYakuman, breakdown } = computeHan(
    input.words,
    input.dict,
    input.doraCount,
    input.riichi,
    input.ippatsu,
    input.uraDoraCount ?? 0,
  );

  const limit = limitFor(han, hasYakuman);
  let basePoints: number;
  if (limit.base !== null) {
    basePoints = limit.base;
  } else {
    basePoints = fu * Math.pow(2, 2 + han);
    // 天井（満貫未満での基本点は2000点=満貫の一歩手前で頭打ちにする一般ルールと同様）
    if (basePoints > 2000) basePoints = 2000;
  }

  const roundUp100 = (n: number) => Math.ceil(n / 100) * 100;

  // 本場分は支払いに加算する。ロンなら放銃者が300点/本場、
  // ツモなら各家が100点/本場ずつ払う(4人なら合計300点/本場)。
  const honba = input.honba ?? 0;

  let total = 0;
  let fromNonDealer: number | undefined;
  let fromDealer: number | undefined;

  if (input.winType === 'ron') {
    total = input.isDealer ? roundUp100(basePoints * 6) : roundUp100(basePoints * 4);
    total += 300 * honba;
  } else {
    if (input.isDealer) {
      fromNonDealer = roundUp100(basePoints * 2) + 100 * honba;
      total = fromNonDealer * 3;
    } else {
      fromNonDealer = roundUp100(basePoints * 1) + 100 * honba;
      fromDealer = roundUp100(basePoints * 2) + 100 * honba;
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
