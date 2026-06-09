import { useState, useEffect } from 'react';
import { Table, Button, Input, Popconfirm, message, Tag, Space, Modal, Typography } from 'antd';
import { adminApi } from '../services/api';
import { EMOTION_LABELS } from '../constants/emotions';
import type { Dream } from '../types';

const { Paragraph, Title } = Typography;

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
        title={detailDream?.title || '梦境详情'}
        open={!!detailDream}
        onCancel={() => setDetailDream(null)}
        footer={null}
        width={720}
      >
        {detailDream && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Tag color={EMOTION_LABELS[detailDream.emotion]?.color || '#999'}>
                {EMOTION_LABELS[detailDream.emotion]?.label || detailDream.emotion}
              </Tag>
              <span style={{ color: '#94a3b8', marginLeft: 8 }}>
                {detailDream.recorded_date}
              </span>
            </div>

            {/* 梦境图 */}
            {detailDream.image_url && (
              <div style={{ marginBottom: 20 }}>
                <Title level={5}>梦境图</Title>
                <img
                  src={getImageFullUrl(detailDream.image_url)}
                  alt="梦境图"
                  style={{
                    width: '100%', maxHeight: 400, objectFit: 'contain',
                    borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)',
                    background: 'rgba(0,0,0,0.2)',
                  }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
            )}

            <Title level={5}>梦境内容</Title>
            <Paragraph>{detailDream.content}</Paragraph>

            {/* 梦境解读 */}
            {detailDream.interpretation && (
              <div style={{ marginTop: 16 }}>
                <Title level={5}>溯梦心语</Title>
                <div
                  style={{
                    padding: 16,
                    borderRadius: 12,
                    background: 'rgba(167, 139, 250, 0.08)',
                    border: '1px solid rgba(167, 139, 250, 0.15)',
                    color: '#e2e8f0',
                    lineHeight: 1.8,
                    fontSize: 14,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {detailDream.interpretation}
                </div>
              </div>
            )}

            {/* 叙事解读 */}
            {detailDream.narrative && (
              <div style={{ marginTop: 16 }}>
                <Title level={5}>叙事解读</Title>
                <Paragraph type="secondary">{detailDream.narrative}</Paragraph>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
