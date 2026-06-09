import { useState, useEffect } from 'react';
import { Table, Button, Input, Popconfirm, message, Tag, Space, Modal } from 'antd';
import { adminApi } from '../services/api';
import { EMOTION_LABELS } from '../constants/emotions';
import type { Dream } from '../types';


export default function DreamManage() {
  const [dreams, setDreams] = useState<Dream[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  // 梦境详情弹窗
  const [detailDream, setDetailDream] = useState<Dream | null>(null);

  const loadDreams = async (p = page, s = search) => {
    setLoading(true);
    try {
      const data = await adminApi.getDreams({ page: p, limit: 20, search: s || undefined });
      setDreams(data.dreams);
      setTotal(data.total);
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDreams(); }, [page]);

  const handleDelete = async (id: string) => {
    try {
      await adminApi.deleteDream(id);
      message.success('删除成功');
      loadDreams();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  // 构建图片完整 URL
  const getImageFullUrl = (url: string | undefined) => {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `https://dimilinks.com${url}`;
  };

  const columns = [
    {
      title: '梦境图', dataIndex: 'image_url', key: 'image_url', width: 144,
      render: (url: string | undefined) => {
        if (!url) return <span style={{ color: '#64748b', fontSize: 12 }}>—</span>;
        const fullUrl = getImageFullUrl(url);
        return (
          <img
            src={fullUrl}
            alt="梦境图"
            style={{
              width: 48, height: 48, borderRadius: 8,
              objectFit: 'cover', border: '1px solid rgba(255,255,255,0.1)',
            }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        );
      },
    },
    {
      title: '标题', dataIndex: 'title', key: 'title', ellipsis: true,
      render: (text: string, record: Dream) => (
        <a onClick={() => setDetailDream(record)}>{text}</a>
      ),
    },
    {
      title: '解读', dataIndex: 'interpretation', key: 'interpretation', width: 160,
      render: (text: string | undefined, record: Dream) => {
        if (!text) return <span style={{ color: '#64748b', fontSize: 12 }}>—</span>;
        return (
          <Button type="link" size="small" onClick={() => setDetailDream(record)}>
            查看
          </Button>
        );
      },
    },
    { title: '用户', dataIndex: 'username' as const, key: 'username', width: 200 },
    {
      title: '情绪', dataIndex: 'emotion', key: 'emotion', width: 160,
      render: (emotion: string) => {
        const meta = EMOTION_LABELS[emotion] || { label: emotion, color: '#999' };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    { title: '日期', dataIndex: 'recorded_date', key: 'recorded_date', width: 220 },
    {
      title: '操作', key: 'action', width: 240,
      render: (_: unknown, record: Dream) => (
        <Space>
          <Button type="link" size="small" onClick={() => setDetailDream(record)}>详情</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button danger size="small">删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Input.Search
          placeholder="搜索梦境标题或内容"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onSearch={() => { setPage(1); loadDreams(1, search); }}
          style={{ width: 300 }}
        />
      </Space>
      <Table
        columns={columns}
        dataSource={dreams}
        rowKey="id"
        loading={loading}
        pagination={{ current: page, total, pageSize: 20, onChange: (p) => setPage(p) }}
      />

      {/* 梦境详情弹窗 */}
      <Modal
        open={!!detailDream}
        onCancel={() => setDetailDream(null)}
        footer={null}
        width={720}
        closable
        styles={{
          content: {
            background: 'rgba(18, 33, 49, 0.95)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 20,
            padding: 0,
            overflow: 'hidden',
          },
          header: {
            background: 'linear-gradient(135deg, rgba(87, 27, 193, 0.15), rgba(76, 215, 246, 0.08))',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            padding: '20px 28px',
          },
          body: { padding: '24px 28px 28px' },
        }}
        title={
          detailDream ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{
                fontSize: 20,
                fontWeight: 700,
                color: '#fff',
                textShadow: '0 0 12px rgba(167,139,250,0.5)',
                letterSpacing: '0.02em',
              }}>
                {detailDream.title}
              </span>
            </div>
          ) : '梦境详情'
        }
      >
        {detailDream && (
          <div>
            {/* 情绪 & 日期 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24,
            }}>
              <Tag color={EMOTION_LABELS[detailDream.emotion]?.color || '#999'} style={{
                borderRadius: 9999, padding: '3px 14px', fontSize: 13,
              }}>
                {EMOTION_LABELS[detailDream.emotion]?.label || detailDream.emotion}
              </Tag>
              <span style={{ color: '#94a3b8', fontSize: 13 }}>
                {detailDream.recorded_date}
              </span>
            </div>

            {/* 梦境图 */}
            {detailDream.image_url && (
              <div style={{ marginBottom: 24 }}>
                <h4 style={{
                  color: '#c6c6cd', fontSize: 12, fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                  marginBottom: 10,
                }}>
                  梦境图
                </h4>
                <div style={{
                  borderRadius: 16, overflow: 'hidden',
                  border: '1px solid rgba(167,139,250,0.2)',
                  boxShadow: '0 0 24px rgba(167,139,250,0.1)',
                  background: 'rgba(0,0,0,0.3)',
                }}>
                  <img
                    src={getImageFullUrl(detailDream.image_url)}
                    alt="梦境图"
                    style={{
                      width: '100%', maxHeight: 380, objectFit: 'contain', display: 'block',
                    }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
              </div>
            )}

            {/* 梦境内容 */}
            <div style={{ marginBottom: 24 }}>
              <h4 style={{
                color: '#c6c6cd', fontSize: 12, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.08em',
                marginBottom: 10,
              }}>
                梦境内容
              </h4>
              <div style={{
                padding: 20, borderRadius: 16,
                background: 'rgba(5, 20, 36, 0.5)',
                border: '1px solid rgba(255,255,255,0.06)',
                color: '#e2e8f0', lineHeight: 1.9, fontSize: 14,
                whiteSpace: 'pre-wrap',
              }}>
                {detailDream.content}
              </div>
            </div>

            {/* 梦境解读 */}
            {detailDream.interpretation && (
              <div style={{ marginBottom: 24 }}>
                <h4 style={{
                  color: '#d0bcff', fontSize: 12, fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                  marginBottom: 10,
                  textShadow: '0 0 8px rgba(167,139,250,0.4)',
                }}>
                  溯梦心语
                </h4>
                <div style={{
                  padding: 20, borderRadius: 16,
                  background: 'linear-gradient(135deg, rgba(87, 27, 193, 0.12), rgba(167, 139, 250, 0.06))',
                  border: '1px solid rgba(167,139,250,0.18)',
                  boxShadow: '0 0 20px rgba(167,139,250,0.06)',
                  color: '#e2e8f0', lineHeight: 1.9, fontSize: 14,
                  whiteSpace: 'pre-wrap',
                }}>
                  {detailDream.interpretation}
                </div>
              </div>
            )}

            {/* 叙事解读 */}
            {detailDream.narrative && (
              <div>
                <h4 style={{
                  color: '#4cd7f6', fontSize: 12, fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                  marginBottom: 10,
                  textShadow: '0 0 8px rgba(76,215,246,0.4)',
                }}>
                  叙事解读
                </h4>
                <div style={{
                  padding: 20, borderRadius: 16,
                  background: 'linear-gradient(135deg, rgba(0, 141, 165, 0.1), rgba(76, 215, 246, 0.05))',
                  border: '1px solid rgba(76,215,246,0.15)',
                  color: '#c6c6cd', lineHeight: 1.9, fontSize: 14,
                  whiteSpace: 'pre-wrap',
                }}>
                  {detailDream.narrative}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
