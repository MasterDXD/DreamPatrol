/**
 * @module utils/text-tokenizer
 * @deprecated 孤立模块 - 未被任何文件引用，计划在下一版本移除
 */
/**
 * 对文本进行分词，返回不重复的词元集合。
 * ASCII 单词按空格拆分后转小写，非 ASCII 文本按双字符 bigram 拆分。
 * @param {string} text - 待分词的文本
 * @returns {Set<string>} 词元集合
 */
function tokenizeText(text) {
  if (typeof text !== 'string' || !text) return new Set();
  const tokens = new Set();
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    if (/^[\x00-\x7F]+$/.test(word)) {
      tokens.add(word.toLowerCase());
    } else {
      for (let j = 0; j <= word.length - 2; j++) {
        tokens.add(word.substring(j, j + 2));
      }
      if (word.length === 1) tokens.add(word);
    }
  }
  return tokens;
}

/**
 * 计算两段文本的 Jaccard 相似度。
 * 参数可为字符串或已分词的 Set，字符串会自动调用 tokenizeText 进行分词。
 * @param {string|Set<string>} a - 第一段文本或词元集合
 * @param {string|Set<string>} b - 第二段文本或词元集合
 * @returns {number} Jaccard 相似度，范围 [0, 1]
 */
tokenizeText.jaccardSimilarity = function (a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return 0;
  const setA = typeof a === 'string' ? tokenizeText(a) : a;
  const setB = typeof b === 'string' ? tokenizeText(b) : b;
  let intersection = 0;
  setA.forEach(function (w) { if (setB.has(w)) intersection++; });
  const union = new Set([].concat(Array.from(setA), Array.from(setB)));
  return union.size === 0 ? 0 : intersection / union.size;
};

module.exports = tokenizeText;
