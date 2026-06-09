import { useState, useEffect } from 'react';
import { Select, Button, Modal, Spin, Pagination } from 'antd';
import { adminApi } from '../services/api';
import type { AICallLog } from '../services/api';

const STATUS_MAP: Record<string, { color: string; label: string; bg: string }> = {
  pending: { color: '#faad14', label: '等待中', bg: 'rgba(250,173,20,0.15)' },
  submitted: { color: '#4cd7f6', label: '已提交', bg: 'rgba(76,215,246,0.15)' },
  in_progress: { color: '#4cd7f6', label: '进行中', bg: 'rgba(76,215,246,0.15)' },
  succeeded: { color: '#4caf50', label: '成功', bg: 'rgba(76,175,80,0.15)' },
  failed: { color: '#ff4d4f', label: '失败', bg: 'rgba(255,77,79,0.15)' },
};

const CALL_TYPE_MAP: Record<string, { color: string; label: string; icon: string; bg: string }> = {
  image: { color: '#d0bcff', label: '生图', icon: '🎨', bg: 'rgba(208,188,255,0.15)' },
  chat: { color: '#4cd7f6', label: '解读', icon: '💬', bg: 'rgba(76,215,246,0.15)' },
};

export default function AICallLogs() {
  const [logs, setLogs] = useState<AICallLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [callTypeFilter, setCallTypeFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  // 详情弹窗
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLog, setDetailLog] = useState<AICallLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchLogs = async (p: number, callType?: string, status?: string) => {
    setLoading(true);
    try {
      const res = await adminApi.getAICallLogs({ page: p, limit: 12, call_type: callType, status });
      setLogs(res.logs);
      setTotal(res.total);
    } catch {
      // 静默处理
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(page, callTypeFilter, statusFilter);
  }, [page]);

  const handleFilter = () => {
    setPage(1);
    fetchLogs(1, callTypeFilter, statusFilter);
  };

  const handleViewDetail = async (id: string) => {
    setDetailVisible(true);
    setDetailLoading(true);
    try {
      const res = await adminApi.getAICallLogDetail(id);
      setDetailLog(res.log);
    } catch {
      // 静默处理
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div>
      <h2 className="page-title">AI 调用记录</h2>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Select
          placeholder="调用类型"
          value={callTypeFilter || undefined}
          onChange={v => setCallTypeFilter(v || '')}
          allowClear
          style={{ width: 140 }}
        >
          <Select.Option value="image">🎨 生图</Select.Option>
          <Select.Option value="chat">💬 解读</Select.Option>
        </Select>
        <Select
          placeholder="状态"
          value={statusFilter || undefined}
          onChange={v => setStatusFilter(v || '')}
          allowClear
          style={{ width: 140 }}
        >
          <Select.Option value="succeeded">✅ 成功</Select.Option>
          <Select.Option value="failed">❌ 失败</Select.Option>
          <Select.Option value="pending">⏳ 等待中</Select.Option>
          <Select.Option value="submitted">📤 已提交</Select.Option>
          <Select.Option value="in_progress">🔄 进行中</Select.Option>
        </Select>
        <Button type="primary" onClick={handleFilter}>筛选</Button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
      ) : (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: 16,
          }}>
            {logs.map(log => {
              const typeInfo = CALL_TYPE_MAP[log.call_type] || { color: '#999', label: log.call_type, icon: '❓', bg: 'rgba(255,255,255,0.1)' };
              const statusInfo = STATUS_MAP[log.status] || { color: '#999', label: log.status, bg: 'rgba(255,255,255,0.1)' };

              return (
                <div
                  key={log.id}
                  className="glass-panel"
                  onClick={() => handleViewDetail(log.id)}
                  style={{
                    borderRadius: 12,
                    overflow: 'hidden',
                    cursor: 'pointer',
                    transition: 'box-shadow 0.2s, transform 0.15s',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 20px rgba(76,215,246,0.15)';
                    (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                    (e.currentTarget as HTMLDivElement).style.transform = 'none';
                  }}
                >
                  {/* 顶部类型色条 */}
                  <div style={{
                    height: 4,
                    background: `linear-gradient(90deg, ${typeInfo.color}, ${statusInfo.color})`,
                  }} />

                  <div style={{ padding: '16px 20px' }}>
                    {/* 标题行：类型 + 状态 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '2px 10px',
                          borderRadius: 12,
                          fontSize: 13,
                          fontWeight: 500,
                          color: typeInfo.color,
                          background: typeInfo.bg,
                        }}>
                          {typeInfo.icon} {typeInfo.label}
                        </span>
                        <span style={{ fontSize: 12, color: '#c6c6cd' }}>{log.model}</span>
                      </div>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '2px 8px',
                        borderRadius: 10,
                        fontSize: 12,
                        fontWeight: 500,
                        color: statusInfo.color,
                        background: statusInfo.bg,
                      }}>
                        {statusInfo.label}
                      </span>
                    </div>

                    {/* Prompt 预览 */}
                    <p style={{
                      margin: '0 0 12px 0',
                      fontSize: 13,
                      color: '#d4e4fa',
                      lineHeight: 1.6,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}>
                      {log.prompt || '-'}
                    </p>

                    {/* 结果预览 */}
                    {log.call_type === 'image' && log.result_url && (
                      <div style={{ marginBottom: 12, borderRadius: 8, overflow: 'hidden' }}>
                        <img
                          src={log.result_url}
                          alt="生成结果"
                          style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }}
                        />
                      </div>
                    )}
                    {log.call_type === 'chat' && log.result_text && (
                      <div style={{
                        marginBottom: 12,
                        padding: '8px 12px',
                        background: 'rgba(5,20,36,0.5)',
                        borderRadius: 8,
                        fontSize: 12,
                        color: '#c6c6cd',
                        lineHeight: 1.5,
                        maxHeight: 60,
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                      }}>
                        {log.result_text}
                      </div>
                    )}
                    {log.status === 'failed' && log.error_message && (
                      <div style={{
                        marginBottom: 12,
                        padding: '6px 10px',
                        background: 'rgba(255,77,79,0.1)',
                        borderRadius: 6,
                        fontSize: 12,
                        color: '#ff4d4f',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {log.error_message}
                      </div>
                    )}

                    {/* 底部元信息 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: '#909097' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span>{log.username || '未知用户'}</span>
                        {log.duration_ms != null && <span>⏱ {(log.duration_ms / 1000).toFixed(1)}s</span>}
                        {log.tokens_used != null && <span>🔤 {log.tokens_used} tokens</span>}
                      </div>
                      <span>{new Date(log.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {logs.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#909097' }}>暂无调用记录</div>
          )}

          {total > 12 && (
            <div style={{ marginTop: 24, textAlign: 'center' }}>
              <Pagination
                current={page}
                total={total}
                pageSize={12}
                onChange={p => setPage(p)}
                showTotal={t => `共 ${t} 条`}
              />
            </div>
          )}
        </>
      )}

      {/* 详情弹窗 */}
      <Modal
        title="调用详情"
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={null}
        width={720}
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : detailLog ? (
          <div>
            {/* 头部信息 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              {(() => {
                const typeInfo = CALL_TYPE_MAP[detailLog.call_type] || { color: '#999', label: detailLog.call_type, icon: '❓', bg: 'rgba(255,255,255,0.1)' };
                const statusInfo = STATUS_MAP[detailLog.status] || { color: '#999', label: detailLog.status, bg: 'rgba(255,255,255,0.1)' };
                return (
                  <>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '4px 14px', borderRadius: 14, fontSize: 14, fontWeight: 500,
                      color: typeInfo.color, background: typeInfo.bg,
                    }}>
                      {typeInfo.icon} {typeInfo.label}
                    </span>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center',
                      padding: '4px 10px', borderRadius: 10, fontSize: 13, fontWeight: 500,
                      color: statusInfo.color, background: statusInfo.bg,
                    }}>
                      {statusInfo.label}
                    </span>
                  </>
                );
              })()}
              <span style={{ fontSize: 13, color: '#909097', marginLeft: 'auto' }}>
                {new Date(detailLog.created_at).toLocaleString('zh-CN')}
              </span>
            </div>

            {/* 信息网格 */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px',
              padding: 16, background: 'rgba(5,20,36,0.5)', borderRadius: 10, marginBottom: 20,
            }}>
              <div><span style={{ color: '#909097', fontSize: 12 }}>用户</span><div style={{ fontWeight: 500 }}>{detailLog.username || detailLog.user_id}</div></div>
              <div><span style={{ color: '#909097', fontSize: 12 }}>模型</span><div style={{ fontWeight: 500 }}>{detailLog.model}</div></div>
              <div><span style={{ color: '#909097', fontSize: 12 }}>耗时</span><div style={{ fontWeight: 500 }}>{detailLog.duration_ms != null ? `${(detailLog.duration_ms / 1000).toFixed(2)}s` : '-'}</div></div>
              <div><span style={{ color: '#909097', fontSize: 12 }}>Tokens</span><div style={{ fontWeight: 500 }}>{detailLog.tokens_used ?? '-'}</div></div>
              {detailLog.dream_id && <div style={{ gridColumn: '1 / -1' }}><span style={{ color: '#909097', fontSize: 12 }}>梦境ID</span><div style={{ fontWeight: 500, fontSize: 12, fontFamily: 'monospace' }}>{detailLog.dream_id}</div></div>}
              {detailLog.completed_at && <div><span style={{ color: '#909097', fontSize: 12 }}>完成时间</span><div style={{ fontWeight: 500 }}>{new Date(detailLog.completed_at).toLocaleString('zh-CN')}</div></div>}
            </div>

            {/* Prompt */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Prompt</div>
              <div style={{
                padding: 16, background: 'rgba(5,20,36,0.5)', borderRadius: 10,
                maxHeight: 150, overflow: 'auto', whiteSpace: 'pre-wrap',
                fontSize: 13, lineHeight: 1.7, color: '#d4e4fa',
              }}>
                {detailLog.prompt || '-'}
              </div>
            </div>

            {/* 生图结果 */}
            {detailLog.result_url && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>生成图片</div>
                <img
                  src={detailLog.result_url}
                  alt="生成结果"
                  style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 10, display: 'block' }}
                />
              </div>
            )}

            {/* 解读结果 */}
            {detailLog.result_text && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>解读结果</div>
                <div style={{
                  padding: 16, background: 'rgba(5,20,36,0.5)', borderRadius: 10,
                  maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap',
                  fontSize: 13, lineHeight: 1.8, color: '#d4e4fa',
                }}>
                  {detailLog.result_text}
                </div>
              </div>
            )}

            {/* 错误信息 */}
            {detailLog.error_message && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>错误信息</div>
                <div style={{
                  padding: 16, background: 'rgba(255,77,79,0.1)', borderRadius: 10,
                  fontSize: 13, color: '#ff4d4f', lineHeight: 1.6,
                }}>
                  {detailLog.error_message}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
