// 手牌の分析: 和了・テンパイ・リーチ可否と、役(飜)の内訳をまとめて返す。
//
// 実戦(GameRoom)とデバッグ画面(/debug/hand)が同じ関数を使うことで、
// 「デバッグ画面では和了なのに実戦ではツモボタンが出ない」のような
// 判定の食い違いが起きないようにする。
//
// 判定の定義(全てここに集約):
//   和了        : 14枚が辞書の単語だけで過不足なく分解できる
//   テンパイ    : 13枚に、どれか1種類の牌を足すと和了になる(待ち牌が1つ以上ある)
//   リーチ可能  : 14枚のうち、どれか1枚を切るとテンパイになる(門前などの条件は呼び出し側)
//
// 14枚の手では「テンパイ」を「切ればテンパイになる打牌がある」として扱う。
// (和了形の14枚は、最後の1枚を切れば、その牌待ちのテンパイだから)

import { WordDef, findAllDecompositions, findWaits, findRiichiDiscards, findBestPartialDecomposition, PartialDecomposition, toCharCount } from './words';
import { computeScore, ScoreResult } from './score';

export interface AnalyzeOptions {
  riichi?: boolean;
  ippatsu?: boolean;
  isDealer?: boolean;
  winType?: 'ron' | 'tsumo';
  doraCount?: number;
  doraIndicators?: string[];
  uraDoraCount?: number; // 手牌中の裏ドラ枚数(リーチしたときだけ数える。実戦と同じ)
  honba?: number; // 本場数(0のとき加算なし)
}

export interface WordInfo {
  word: string;
  han: number | 'y' | null; // 辞書に無い語は null
  tags: string[];
  inDict: boolean;
}

export interface DecompositionAnalysis {
  words: WordInfo[];
  score: ScoreResult;
}

export interface WinAnalysis {
  possible: boolean;
  decompositions: DecompositionAnalysis[];
  bestIndex: number | null; // 点数が最も高い分解
}

export interface WaitAnalysis {
  kind: string;
  win: WinAnalysis;
}

export interface HandAnalysis {
  length: number;

  // 和了(14枚のときだけ判定。それ以外は possible: false)
  win: WinAnalysis;

  // テンパイ
  //   13枚: waits = 待ち牌
  //   14枚: waits は空。切ればテンパイになる打牌は discards を見る
  tenpai: {
    possible: boolean;
    waits: string[];
    waitDetails: WaitAnalysis[]; // 13枚のとき: 待ち牌ごとの和了時の役分析
  };

  // 14枚のとき: 切るとテンパイになる打牌と、そのときの待ち牌
  discards: { discard: string; waits: string[] }[];

  // リーチ可能
  //   13枚: テンパイしていること(次に引いた牌を切る形でも宣言できる)
  //   14枚: 切ればテンパイになる打牌があること
  riichi: {
    possible: boolean;
    discards: string[];
  };
}

function toWordInfo(word: string, dict: WordDef[]): WordInfo {
  const def = dict.find((d) => d.word === word);
  return {
    word,
    han: def ? def.han : null,
    tags: def?.tag ?? [],
    inDict: !!def,
  };
}

function emptyWin(): WinAnalysis {
  return { possible: false, decompositions: [], bestIndex: null };
}

/**
 * 14枚の手を和了形として分析する(全ての分解と、それぞれの役・点数)。
 */
export function analyzeWin(
  hand14: string[],
  dict: WordDef[],
  opts: AnalyzeOptions = {},
  limit = 100,
): WinAnalysis {
  if (hand14.length !== 14) return emptyWin();

  const decomps = findAllDecompositions(hand14, dict, limit);
  if (decomps.length === 0) return emptyWin();

  const decompositions: DecompositionAnalysis[] = decomps.map((d) => ({
    words: d.words.map((w) => toWordInfo(w, dict)),
    score: computeScore({
      words: d.words,
      dict,
      doraIndicators: opts.doraIndicators ?? [],
      doraCount: opts.doraCount ?? 0,
      // 裏ドラはリーチしたときだけ数える(実戦 GameRoom と同じ規則)。
      uraDoraCount: opts.riichi ? (opts.uraDoraCount ?? 0) : 0,
      honba: opts.honba ?? 0,
      riichi: !!opts.riichi,
      ippatsu: !!opts.ippatsu,
      isDealer: !!opts.isDealer,
      winType: opts.winType ?? 'tsumo',
    }),
  }));

  let bestIndex = 0;
  decompositions.forEach((d, i) => {
    if (d.score.payments.total > decompositions[bestIndex].score.payments.total) {
      bestIndex = i;
    }
  });

  return { possible: true, decompositions, bestIndex };
}

/**
 * 手牌(13枚または14枚)を分析する。
 */
export function analyzeHand(
  hand: string[],
  dict: WordDef[],
  opts: AnalyzeOptions = {},
): HandAnalysis {
  const result: HandAnalysis = {
    length: hand.length,
    win: emptyWin(),
    tenpai: { possible: false, waits: [], waitDetails: [] },
    discards: [],
    riichi: { possible: false, discards: [] },
  };

  if (hand.length === 13) {
    const waits = findWaits(hand, dict);

    result.tenpai = {
      possible: waits.length > 0,
      waits,
      // 待ち牌ごとに「その牌で和了したときの役・点数」を分析する
      waitDetails: waits.map((kind) => ({
        kind,
        win: analyzeWin([...hand, kind], dict, opts, 20),
      })),
    };

    // 13枚でテンパイしていれば、リーチ宣言できる形
    result.riichi = {
      possible: waits.length > 0,
      discards: [],
    };
  } else if (hand.length === 14) {
    result.win = analyzeWin(hand, dict, opts);

    const discards = findRiichiDiscards(hand, dict);
    result.discards = discards;

    result.tenpai = {
      possible: discards.length > 0,
      waits: [],
      waitDetails: [],
    };

    result.riichi = {
      possible: discards.length > 0,
      discards: discards.map((d) => d.discard),
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// 打牌評価用(CPUが使う)。和了・テンパイの判定そのものは上の関数と同じ定義で、
// テンパイしていない手の「進み具合」まで数値化する。
// ---------------------------------------------------------------------------

export interface RemainingEvaluation {
  waits: string[]; // この13枚に足すと和了になる牌種(0件ならテンパイしていない)
  covered: number; // 辞書の単語で覆えている文字数(13が最大)
  leftover: string[]; // どの単語にも使えていない文字
  partialWords: string[]; // 覆うのに使った単語
  nearWordCount: number; // あと1文字で完成する単語の数
}

export interface DiscardOption {
  discard: string; // 切る牌種
  waits: string[];
  covered: number;
  leftoverCount: number;
  nearWordCount: number;
}

/**
 * 13枚の手の「進み具合」を評価する。
 * waits が1つでもあればテンパイ。無ければ covered / nearWordCount が大きいほど
 * 和了に近い(1枚の入れ替えで単語が増えやすい)。
 */
export function evaluateRemaining(
  chars13: string[],
  dict: WordDef[],
  waitsMemo: Map<string, boolean> = new Map(),
  partialMemo: Map<string, { words: string[]; covered: number }> = new Map(),
): RemainingEvaluation {
  if (chars13.length !== 13 || dict.length === 0) {
    return { waits: [], covered: 0, leftover: [...chars13], partialWords: [], nearWordCount: 0 };
  }

  const waits = findWaits(chars13, dict, waitsMemo);
  const partial: PartialDecomposition = findBestPartialDecomposition(chars13, dict, partialMemo);

  // あと1文字で完成する単語を数える(既に完成している単語は含めない)。
  const have = toCharCount(chars13);
  let nearWordCount = 0;
  for (const d of dict) {
    const chars = [...d.word];
    if (chars.length > chars13.length + 1) continue;
    const need = toCharCount(chars);
    let missing = 0;
    for (const ch of Object.keys(need)) {
      missing += Math.max(0, need[ch] - (have[ch] || 0));
      if (missing > 1) break;
    }
    if (missing === 1) nearWordCount++;
  }

  return {
    waits,
    covered: partial.covered,
    leftover: partial.leftover,
    partialWords: partial.words,
    nearWordCount,
  };
}

/**
 * 14枚の手(手牌 + 鳴いた単語の文字)について、切れる牌種ごとに
 * 「切ったあとの13枚」の評価を返す。切る牌は concealedKinds の中から選ぶ
 * (鳴いた単語の文字は切れない)。
 */
export function analyzeDiscardOptions(
  fullChars14: string[],
  concealedKinds: string[],
  dict: WordDef[],
): DiscardOption[] {
  if (fullChars14.length !== 14 || dict.length === 0) return [];

  const waitsMemo = new Map<string, boolean>();
  const partialMemo = new Map<string, { words: string[]; covered: number }>();
  const options: DiscardOption[] = [];
  const tried = new Set<string>();

  for (const kind of concealedKinds) {
    if (tried.has(kind)) continue;
    tried.add(kind);
    const idx = fullChars14.indexOf(kind);
    if (idx === -1) continue;
    const rest = [...fullChars14];
    rest.splice(idx, 1);
    const ev = evaluateRemaining(rest, dict, waitsMemo, partialMemo);
    options.push({
      discard: kind,
      waits: ev.waits,
      covered: ev.covered,
      leftoverCount: ev.leftover.length,
      nearWordCount: ev.nearWordCount,
    });
  }

  return options;
}
