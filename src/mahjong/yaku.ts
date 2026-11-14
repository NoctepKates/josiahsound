import { WordDef } from './words';

export interface SpecialYaku {
  name: string;
  han: number | 'y';
  check(words: WordDef[]): boolean;
}

function hasTag(word: WordDef, tag: string): boolean {
  return word.tag?.includes(tag) ?? false;
}

function allHaveTag(words: WordDef[], tag: string): boolean {
  if (words.length === 0) return false;
  return words.every((word) => hasTag(word, tag));
}

export const specialYakus: SpecialYaku[] = [

  {
    name: '淫一色',
    han: 1,

    check(words) {
      return allHaveTag(words, '淫夢');
    }
  },


  {
    name: '光一色',
    han: 1,

    check(words) {
      return allHaveTag(words, 'ヒカマニ');
    }
  },


  {
    name: 'これは、夢なのか、現実なのか…。',
    han: 2,

    check(words) {
      return allHaveTag(words, 'IMP');
    }
  },


  {
    name: '第一章 極道脅迫！体育部員たちの逆襲',
    han: 3,

    check(words) {
      return allHaveTag(words, '34一章');
    }
  },


  {
    name: '第二章 モデル反撃！犯されるスカウトマン',
    han: 3,

    check(words) {
      return allHaveTag(words, '34二章');
    }
  },


  {
    name: '第三章 盗撮！そしてSM妄想へ…',
    han: 3,

    check(words) {
      return allHaveTag(words, '34三章');
    }
  },


  {
    name: '第四章 昏睡レイプ！野獣と化した先輩',
    han: 3,

    check(words) {
      return allHaveTag(words, '34四章');
    }
  },

  {
    name: '二度と名乗るな',
    han: 3,

    check(words) {
      return allHaveTag(words, 'SAENS');
    }
  }
];


export function findSpecialYakus(words: WordDef[]): SpecialYaku[] {
  // 成立した役を1回ずつ数える。
  // (以前は filter の結果にさらに同じ役を push していたため、全ての役が二重に加算されていた)
  const matched = specialYakus.filter((yaku) => yaku.check(words));
  const names = new Set(matched.map((y) => y.name));

  const CHAPTER_NAMES = [
    '第一章 極道脅迫！体育部員たちの逆襲',
    '第二章 モデル反撃！犯されるスカウトマン',
    '第三章 盗撮！そしてSM妄想へ…',
    '第四章 昏睡レイプ！野獣と化した先輩',
  ];
  const IMP = 'これは、夢なのか、現実なのか…。';

  // 上位役が成立した場合、下位役を消す。
  //   章の役 > 「これは、夢なのか、現実なのか…。」 > 淫一色
  // (以前は最初に当てはまった条件で return していたため、
  //  「IMP と 章」が同時に成立すると IMP が消えずに残っていた)
  const hasChapter = CHAPTER_NAMES.some((n) => names.has(n));

  return matched.filter((y) => {
    if (y.name === IMP && hasChapter) return false;
    if (y.name === '淫一色' && names.has(IMP)) return false;
    return true;
  });
}
