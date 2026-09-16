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

];


export function findSpecialYakus(words: WordDef[]): SpecialYaku[] {
  const result = specialYakus.filter((yaku) => yaku.check(words));

  for (const yaku of specialYakus) {
    if (yaku.check(words)) {
      result.push(yaku);
    }
  }


  // 上位役が成立した場合、下位役を消す
  if (result.some(y => y.name === 'これは、夢なのか、現実なのか…。')) {
    return result.filter(y => y.name !== '淫一色');
  }

  if (result.some(y => y.name === '第一章 極道脅迫！体育部員たちの逆襲')) {
    return result.filter(y => y.name !== 'これは、夢なのか、現実なのか…。');
  }

  if (result.some(y => y.name === '第二章 モデル反撃！犯されるスカウトマン')) {
    return result.filter(y => y.name !== 'これは、夢なのか、現実なのか…。');
  }

  if (result.some(y => y.name === '第三章 盗撮！そしてSM妄想へ…')) {
    return result.filter(y => y.name !== 'これは、夢なのか、現実なのか…。');
  }

  if (result.some(y => y.name === '第四章 昏睡レイプ！野獣と化した先輩')) {
    return result.filter(y => y.name !== 'これは、夢なのか、現実なのか…。');
  }

  return result;
}