// 単語辞書を使った手牌分解ロジック
// 「手牌14枚(ひらがな14文字)が、登録された単語だけで過不足なく構成される」かどうかを判定する

import { ALL_TILE_KINDS } from './tiles';

export interface WordDef {
  word: string;
  han: number | 'y';
  tag?: string[];
}

export type CharCount = Record<string, number>;

export function toCharCount(chars: string[]): CharCount {
  const c: CharCount = {};
  for (const ch of chars) {
    c[ch] = (c[ch] || 0) + 1;
  }
  return c;
}

export interface Decomposition {
  words: string[]; // 使用した単語のリスト
}

type PreparedWord = {
  word: string;
  counts: CharCount;
  length: number;
  han: number | 'y';
};

type PreparedDict = {
  words: PreparedWord[];
  byChar: Map<string, PreparedWord[]>;
};

// 同じ辞書配列を何度も渡されるので、辞書の前処理結果を再利用する。
// DBから読み込んだ辞書配列は通常そのまま使われるため、このキャッシュが有効。
const preparedDictCache = new WeakMap<WordDef[], PreparedDict>();

function prepareDict(dict: WordDef[]): PreparedDict {
  const cached = preparedDictCache.get(dict);
  if (cached) return cached;

  const words: PreparedWord[] = [];
  const byChar = new Map<string, PreparedWord[]>();

  for (const d of dict) {
    if (!d.word) continue;

    const chars = [...d.word];

    // 14枚の手牌から成立することはないので、
    // 14文字を超える単語は探索対象から除外する。
    if (chars.length > 14) continue;

    const counts = toCharCount(chars);

    const entry: PreparedWord = {
      word: d.word,
      counts,
      length: chars.length,
      han: d.han,
    };

    words.push(entry);

    // この文字を含む単語だけを後で検索できるように索引化する。
    for (const ch of Object.keys(counts)) {
      const list = byChar.get(ch);

      if (list) {
        list.push(entry);
      } else {
        byChar.set(ch, [entry]);
      }
    }
  }

  // 長い単語を先に試す。
  // 先に大きく文字を消せるので、通常は探索量が減る。
  for (const list of byChar.values()) {
    list.sort(
      (a, b) =>
        b.length - a.length ||
        a.word.localeCompare(b.word)
    );
  }

  const result: PreparedDict = {
    words,
    byChar,
  };

  preparedDictCache.set(dict, result);
  return result;
}

function isEmpty(count: CharCount): boolean {
  return Object.keys(count).length === 0;
}

function countKey(count: CharCount): string {
  return Object.keys(count)
    .sort()
    .map((ch) => `${ch}:${count[ch]}`)
    .join('|');
}

/**
 * word が残り文字数に収まるか確認する。
 */
function fits(count: CharCount, word: PreparedWord): boolean {
  for (const ch of Object.keys(word.counts)) {
    if ((count[ch] || 0) < word.counts[ch]) {
      return false;
    }
  }

  return true;
}

/**
 * 残り文字から word を引く。
 */
function subtractPrepared(
  count: CharCount,
  word: PreparedWord,
): CharCount | null {
  if (!fits(count, word)) {
    return null;
  }

  const result: CharCount = { ...count };

  for (const ch of Object.keys(word.counts)) {
    const next = (result[ch] || 0) - word.counts[ch];

    if (next < 0) {
      return null;
    }

    if (next === 0) {
      delete result[ch];
    } else {
      result[ch] = next;
    }
  }

  return result;
}

/**
 * 残っている文字のうち、
 * 「それを含む辞書語が最も少ない文字」を選ぶ。
 *
 * 例えば残りが
 *   あああかきき
 * なら、
 * 「き」を含む単語が2種類しかなく
 * 「あ」を含む単語が100種類ある場合、
 * 「き」から探索した方が枝分かれが少ない。
 */
function choosePivot(
  count: CharCount,
  prepared: PreparedDict,
): string | null {
  let pivot: string | null = null;
  let bestCandidateCount = Number.POSITIVE_INFINITY;

  for (const ch of Object.keys(count)) {
    const candidates = prepared.byChar.get(ch);

    // この文字を含む単語が1つもないなら和了不能。
    if (!candidates || candidates.length === 0) {
      return null;
    }

    if (candidates.length < bestCandidateCount) {
      bestCandidateCount = candidates.length;
      pivot = ch;

      // これ以上良いものはない。
      if (bestCandidateCount === 1) {
        break;
      }
    }
  }

  return pivot;
}

/**
 * 分解可能かどうかだけを高速判定する。
 *
 * メモ化することで、
 * 別の探索経路から同じ残り文字構成に到達した場合は
 * 再計算しない。
 */
function canDecomposePrepared(
  handChars: string[],
  prepared: PreparedDict,
  memo: Map<string, boolean>,
): boolean {
  function dfs(count: CharCount): boolean {
    if (isEmpty(count)) {
      return true;
    }

    const key = countKey(count);

    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const pivot = choosePivot(count, prepared);

    if (!pivot) {
      memo.set(key, false);
      return false;
    }

    const candidates = prepared.byChar.get(pivot)!;

    for (const word of candidates) {
      const next = subtractPrepared(count, word);

      if (!next) {
        continue;
      }

      if (dfs(next)) {
        memo.set(key, true);
        return true;
      }
    }

    memo.set(key, false);
    return false;
  }

  return dfs(toCharCount(handChars));
}

/**
 * 手牌(14枚)がdictの単語だけで過不足なく分解できる全パターンを探す。
 *
 * 元の実装は「辞書内の全単語」を毎階層試していた。
 * 現在は「残り文字のうち1文字を必ず含む単語」のみに絞り込む。
 */
export function findAllDecompositions(
  handChars: string[],
  dict: WordDef[],
  limit = 500,
): Decomposition[] {
  if (handChars.length !== 14) {
    return [];
  }

  if (limit <= 0 || dict.length === 0) {
    return [];
  }

  const prepared = prepareDict(dict);

  const results: Decomposition[] = [];
  const resultKeys = new Set<string>();

  // 「この残り状態以下には解がない」を記憶する。
  const deadStates = new Set<string>();

  function dfs(
    count: CharCount,
    used: string[],
  ): boolean {
    if (results.length >= limit) {
      return true;
    }

    if (isEmpty(count)) {
      // 探索順序が変わった場合でも、
      // 同じ単語集合を重複表示しない。
      const resultKey = [...used]
        .sort()
        .join('\u0001');

      if (!resultKeys.has(resultKey)) {
        resultKeys.add(resultKey);
        results.push({
          words: [...used],
        });
      }

      return true;
    }

    const key = countKey(count);

    if (deadStates.has(key)) {
      return false;
    }

    const pivot = choosePivot(count, prepared);

    if (!pivot) {
      deadStates.add(key);
      return false;
    }

    const candidates = prepared.byChar.get(pivot)!;

    let found = false;

    for (const word of candidates) {
      const next = subtractPrepared(count, word);

      if (!next) {
        continue;
      }

      used.push(word.word);

      const childFound = dfs(next, used);

      used.pop();

      if (childFound) {
        found = true;
      }

      if (results.length >= limit) {
        return true;
      }
    }

    if (!found) {
      deadStates.add(key);
    }

    return found;
  }

  dfs(toCharCount(handChars), []);

  return results;
}

export function canWin(
  handChars: string[],
  dict: WordDef[],
): boolean {
  if (handChars.length !== 14) {
    return false;
  }

  if (dict.length === 0) {
    return false;
  }

  const prepared = prepareDict(dict);

  // 1回の判定中で同じ残り状態を再探索しない。
  const memo = new Map<string, boolean>();

  return canDecomposePrepared(
    handChars,
    prepared,
    memo,
  );
}

/**
 * 鳴き候補を探す。
 *
 * discardKind を含み、
 * handKinds(自分の手牌)の一部 + discardKind
 * でちょうど単語1語になる組み合わせを全て返す。
 */
export interface CallCandidate {
  word: string;
  han: number | 'y';
  usedFromHand: string[]; // 手牌から使う牌の文字（discard牌は含まない）
}

export function findCallCandidates(
  handKinds: string[],
  discardKind: string,
  dict: WordDef[],
): CallCandidate[] {
  const handCount = toCharCount(handKinds);
  const prepared = prepareDict(dict);

  const candidates: CallCandidate[] = [];

  // discardKind を含む単語だけを調べる。
  const possibleWords =
    prepared.byChar.get(discardKind) || [];

  for (const d of possibleWords) {
    const usedFromHand: string[] = [];
    let ok = true;

    for (const ch of Object.keys(d.counts)) {
      const need =
        d.counts[ch] -
        (ch === discardKind ? 1 : 0);

      if (need <= 0) {
        continue;
      }

      if ((handCount[ch] || 0) < need) {
        ok = false;
        break;
      }

      for (let i = 0; i < need; i++) {
        usedFromHand.push(ch);
      }
    }

    if (ok) {
      candidates.push({
        word: d.word,
        han: d.han,
        usedFromHand,
      });
    }
  }

  return candidates;
}

/**
 * 手牌13枚がテンパイかどうかを判定する。
 *
 * 重要:
 * 元の実装では
 *
 *   82種類の牌
 *      ↓
 *   canWin()
 *      ↓
 *   辞書DFS
 *
 * を毎回ほぼ独立して実行していた。
 *
 * 現在は辞書前処理とメモを共有する。
 */
export function isTenpai(
  hand13: string[],
  dict: WordDef[],
): boolean {
  if (hand13.length !== 13) {
    return false;
  }

  if (dict.length === 0) {
    return false;
  }

  const prepared = prepareDict(dict);
  const memo = new Map<string, boolean>();

  for (const kind of ALL_TILE_KINDS) {
    const hand14 = [...hand13, kind];

    if (
      canDecomposePrepared(
        hand14,
        prepared,
        memo,
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * 手牌14枚(打牌前)の中から、
 * どれか1枚を切ればテンパイになるか判定する。
 *
 * リーチ判定で使う。
 */
export function canDeclareRiichiHand(
  hand14: string[],
  dict: WordDef[],
): boolean {
  if (hand14.length !== 14) {
    return false;
  }

  if (dict.length === 0) {
    return false;
  }

  const prepared = prepareDict(dict);

  // 手牌14枚 → 1枚捨てる → 13枚
  // その13枚についての和了判定結果を全部共有。
  const memo = new Map<string, boolean>();

  const triedKinds = new Set<string>();

  for (const kind of hand14) {
    if (triedKinds.has(kind)) {
      continue;
    }

    triedKinds.add(kind);

    const rest = [...hand14];
    const index = rest.indexOf(kind);

    if (index < 0) {
      continue;
    }

    rest.splice(index, 1);

    // 「残り13枚 + 引く牌」で和了できる牌が1つでもあればテンパイ。
    for (const drawKind of ALL_TILE_KINDS) {
      const candidate = [
        ...rest,
        drawKind,
      ];

      if (
        canDecomposePrepared(
          candidate,
          prepared,
          memo,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}