// ひらがじゃん 牌定義
// 77種類 = 通常46 + 濁音/半濁音26 + 小さい文字4 + 長音1

export const SEION_ORDER: string[] = [
  'あ', 'い', 'う', 'え', 'お',
  'か', 'き', 'く', 'け', 'こ',
  'さ', 'し', 'す', 'せ', 'そ',
  'た', 'ち', 'つ', 'て', 'と',
  'な', 'に', 'ぬ', 'ね', 'の',
  'は', 'ひ', 'ふ', 'へ', 'ほ',
  'ま', 'み', 'む', 'め', 'も',
  'や', 'ゆ', 'よ',
  'ら', 'り', 'る', 'れ', 'ろ',
  'わ', 'を', 'ん',
]; // 46

export const DAKUTEN_ORDER: string[] = [
  'が', 'ぎ', 'ぐ', 'げ', 'ご',
  'ざ', 'じ', 'ず', 'ぜ', 'ぞ',
  'だ', 'ぢ', 'づ', 'で', 'ど',
  'ば', 'び', 'ぶ', 'べ', 'ぼ',
  'ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ',
  'ゔ',
]; // 26

export const SMALL_ORDER: string[] = ['っ', 'ゃ', 'ゅ', 'ょ']; // 4
export const CHOON_ORDER: string[] = ['ー']; // 1

// ドラ計算用の全体順序（この配列内で「次」がドラになる。末尾は先頭に循環）
export const DORA_SEQUENCE: string[] = [
  ...SEION_ORDER,
  ...DAKUTEN_ORDER,
  ...SMALL_ORDER,
  ...CHOON_ORDER,
]; // 77

export const ALL_TILE_KINDS: string[] = DORA_SEQUENCE;

export function nextForDora(indicator: string): string {
  const idx = DORA_SEQUENCE.indexOf(indicator);
  if (idx === -1) throw new Error(`未知の牌: ${indicator}`);
  return DORA_SEQUENCE[(idx + 1) % DORA_SEQUENCE.length];
}

export function isSmall(ch: string): boolean {
  return SMALL_ORDER.includes(ch);
}
export function isChoon(ch: string): boolean {
  return CHOON_ORDER.includes(ch);
}
export function isDakuHandaku(ch: string): boolean {
  return DAKUTEN_ORDER.includes(ch);
}
// 符計算で「特殊文字を含む単語か」の判定に使う（っゃゅょ/ー/濁音半濁音）
export function isSpecialChar(ch: string): boolean {
  return isSmall(ch) || isChoon(ch) || isDakuHandaku(ch);
}

export interface Tile {
  id: string;       // 一意な牌インスタンスID
  kind: string;      // ひらがな1文字
}

let tileSeq = 0;
export function makeTile(kind: string): Tile {
  tileSeq += 1;
  return { id: `t${Date.now()}_${tileSeq}_${Math.random().toString(36).slice(2, 6)}`, kind };
}

/**
 * 山を構築する。countPerKind: 各文字を何枚使うか(2〜8)
 */
export function buildWall(countPerKind: number): Tile[] {
  const tiles: Tile[] = [];
  for (const kind of ALL_TILE_KINDS) {
    for (let i = 0; i < countPerKind; i++) {
      tiles.push(makeTile(kind));
    }
  }
  return shuffle(tiles);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * サイコロ2つ相当（1〜6の合計を2回振って親決め等に使う）
 */
export function rollDice2(): number {
  return (1 + Math.floor(Math.random() * 6)) + (1 + Math.floor(Math.random() * 6));
}
