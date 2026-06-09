import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EmptyState from '../components/EmptyState/EmptyState';

describe('EmptyState 组件', () => {
  // 渲染提示文案
  it('应该渲染提示文案', () => {
    render(<EmptyState message="暂无梦境记录" />);
    expect(screen.getByText('暂无梦境记录')).toBeInTheDocument();
  });

  // 渲染操作按钮
  it('应该渲染操作按钮', () => {
    const onAction = vi.fn();
    render(<EmptyState message="暂无梦境记录" actionLabel="记录第一个梦" onAction={onAction} />);
    const button = screen.getByText('记录第一个梦');
    expect(button).toBeInTheDocument();

    // 点击按钮应该调用onAction
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledOnce();
  });

  // 没有actionLabel时不渲染按钮
  it('没有actionLabel时不应该渲染按钮', () => {
    const { container } = render(<EmptyState message="暂无梦境记录" />);
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(0);
  });
});
