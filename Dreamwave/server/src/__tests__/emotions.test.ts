import { describe, it, expect } from 'vitest';
import { guessEmotion, generateNarrative } from '../utils/emotions';

describe('guessEmotion', () => {
  // 测试6种情绪的关键词匹配
  it('应该识别"喜悦"情绪', () => {
    expect(guessEmotion('今天很开心，阳光真好')).toBe('joy');
  });

  it('应该识别"平静"情绪', () => {
    expect(guessEmotion('安静地躺在海边，感觉很放松')).toBe('calm');
  });

  it('应该识别"悲伤"情绪', () => {
    expect(guessEmotion('我哭了，心里很难过')).toBe('sadness');
  });

  it('应该识别"恐惧"情绪', () => {
    expect(guessEmotion('黑暗中有怪物在追我，好害怕')).toBe('fear');
  });

  it('应该识别"奇妙"情绪', () => {
    expect(guessEmotion('我在星空下飞翔，太奇妙了')).toBe('wonder');
  });

  it('应该识别"怀念"情绪', () => {
    expect(guessEmotion('回忆起小时候在老家的日子')).toBe('nostalgia');
  });

  // 测试无匹配返回null
  it('无匹配关键词时应该返回null', () => {
    expect(guessEmotion('这是一段没有任何情绪关键词的文字')).toBeNull();
  });

  // 测试多情绪关键词时返回得分最高的
  it('多个情绪关键词时应该返回得分最高的情绪', () => {
    // "开心"匹配joy，"害怕"匹配fear，joy有1个匹配，fear有1个匹配
    // 这里测试一个情绪关键词更密集的场景
    const result = guessEmotion('开心快乐高兴笑幸福阳光温暖');
    expect(result).toBe('joy');
  });
});

describe('generateNarrative', () => {
  // 测试生成叙事文本不为空
  it('应该为喜悦情绪生成非空叙事文本', () => {
    const result = generateNarrative('我在花园里散步。看到了很多花。', 'joy');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('应该为恐惧情绪生成非空叙事文本', () => {
    const result = generateNarrative('我在黑暗中行走。身后有脚步声。', 'fear');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('叙事文本应包含原始内容', () => {
    const content = '我在花园里散步';
    const result = generateNarrative(content, 'joy');
    expect(result).toContain('我在花园里散步');
  });

  it('空内容时应返回原始内容', () => {
    const result = generateNarrative('', 'joy');
    expect(result).toBe('');
  });
});
