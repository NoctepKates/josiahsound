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

import { WordDef, findAllDecompositions, findWaits, findRiichiDiscards } from './words';
import { computeScore, ScoreResult } from './score';

export interface AnalyzeOptions {
  riichi?: boolean;
  ippatsu?: boolean;
  isDealer?: boolean;
  winType?: 'ron' | 'tsumo';
  doraCount?: number;
  doraIndicators?: string[];
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
      handWithDoraCount: opts.doraCount ?? 0,
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
