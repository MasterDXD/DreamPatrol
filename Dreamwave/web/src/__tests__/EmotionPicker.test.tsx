import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EmotionPicker from '../components/EmotionPicker/EmotionPicker';

describe('EmotionPicker 组件', () => {
  // 渲染6个情绪选项
  it('应该渲染6个情绪选项', () => {
    const onChange = vi.fn();
    render(<EmotionPicker value="joy" onChange={onChange} />);

    // 6种情绪的标签：喜悦、平静、悲伤、恐惧、奇妙、怀念
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(6);
  });

  // 点击选择某个情绪
  it('点击情绪按钮应该调用onChange', () => {
    const onChange = vi.fn();
    render(<EmotionPicker value="joy" onChange={onChange} />);

    // 点击"悲伤"按钮
    const sadnessButton = screen.getByText('悲伤');
    fireEvent.click(sadnessButton);
    expect(onChange).toHaveBeenCalledWith('sadness');
  });

  // 选中项高亮（通过检查按钮的className包含selected）
  it('选中项应该有高亮样式', () => {
    const onChange = vi.fn();
    render(<EmotionPicker value="calm" onChange={onChange} />);

    // 找到包含"平静"文字的按钮
    const buttons = screen.getAllByRole('button');
    const calmButton = buttons.find(btn => btn.textContent?.includes('平静'));
    expect(calmButton).toBeTruthy();
    // 选中项应该包含 selected 样式类
    expect(calmButton!.className).toContain('selected');
  });
});
