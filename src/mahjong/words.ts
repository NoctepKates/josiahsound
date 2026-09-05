// 単語辞書を使った手牌分解ロジック
// 「手牌14枚(ひらがな14文字)が、登録された単語だけで過不足なく構成される」かどうかを判定する

export interface WordDef {
  word: string;   // 例: "ありがとう"
  han: number;    // この単語が確定したときの飜数
}

export type CharCount = Record<string, number>;

export function toCharCount(chars: string[]): CharCount {
  const c: CharCount = {};
  for (const ch of chars) c[ch] = (c[ch] || 0) + 1;
  return c;
}

function subtractWord(count: CharCount, word: string): CharCount | null {
  const wc = toCharCount(word.split(''));
  const result: CharCount = { ...count };
  for (const ch in wc) {
    const have = result[ch] || 0;
    if (have < wc[ch]) return null;
    result[ch] = have - wc[ch];
    if (result[ch] === 0) delete result[ch];
  }
  return result;
}

function isEmpty(count: CharCount): boolean {
  return Object.keys(count).length === 0;
}

export interface Decomposition {
  words: string[]; // 使用した単語のリスト
}

/**
 * 手牌(14枚 or 13枚+和了牌)がdictの単語だけで過不足なく分解できる全パターンを探す。
 * 語数が少ない辞書を想定した素直な深さ優先探索。組み合わせ爆発を避けるため
 * 一定件数で打ち切る。
 */
export function findAllDecompositions(
  handChars: string[],
  dict: WordDef[],
  limit = 500,
): Decomposition[] {
  const results: Decomposition[] = [];
  const dictWords = dict.map((d) => d.word);
  // 長い単語から試す方が早く手数が減って枝刈りしやすい
  const sorted = [...dictWords].sort((a, b) => b.length - a.length);

  function dfs(count: CharCount, used: string[]) {
    if (results.length >= limit) return;
    if (isEmpty(count)) {
      results.push({ words: [...used] });
      return;
    }
    for (const w of sorted) {
      const next = subtractWord(count, w);
      if (next) {
        used.push(w);
        dfs(next, used);
        used.pop();
        if (results.length >= limit) return;
      }
    }
  }

  dfs(toCharCount(handChars), []);
  return results;
}

export function canWin(handChars: string[], dict: WordDef[]): boolean {
  if (handChars.length !== 14) return false;
  const decomps = findAllDecompositions(handChars, dict, 1);
  return decomps.length > 0;
}

/**
 * 鳴き候補を探す。
 * discardKind を含み、handKinds(自分の手牌)の一部 + discardKind でちょうど
 * 単語リストの1語になる組み合わせを全て返す。
 */
export interface CallCandidate {
  word: string;
  han: number;
  usedFromHand: string[]; // 手牌から使う牌の文字（discard牌は含まない）
}

export function findCallCandidates(
  handKinds: string[],
  discardKind: string,
  dict: WordDef[],
): CallCandidate[] {
  const handCount = toCharCount(handKinds);
  const candidates: CallCandidate[] = [];
  for (const d of dict) {
    const wc = toCharCount(d.word.split(''));
    if (!wc[discardKind]) continue; // discard牌を含む単語のみ対象
    // discard牌1枚を引いた残りが手牌でまかなえるか
    const need: CharCount = { ...wc };
    need[discardKind] -= 1;
    if (need[discardKind] === 0) delete need[discardKind];

    let ok = true;
    const usedFromHand: string[] = [];
    for (const ch in need) {
      if ((handCount[ch] || 0) < need[ch]) { ok = false; break; }
      for (let i = 0; i < need[ch]; i++) usedFromHand.push(ch);
    }
    if (ok) {
      candidates.push({ word: d.word, han: d.han, usedFromHand });
    }
  }
  return candidates;
}
