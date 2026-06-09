import { useState, useEffect } from 'react';
import { Table, Input, Tag } from 'antd';
import { adminApi } from '../services/api';

interface LogEntry {
  id: string;
  user_id: string;
  username?: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  ip_address: string | null;
  created_at: string;
}

export default function OperationLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [actionFilter, setActionFilter] = useState('');

  const fetchLogs = async (p: number, action?: string) => {
    setLoading(true);
    try {
      const res = await adminApi.getOperationLogs({ page: p, limit: 20, action });
      setLogs(res.logs);
      setTotal(res.total);
    } catch {
      // 静默处理
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(page, actionFilter);
  }, [page]);

  const handleSearch = () => {
    setPage(1);
    fetchLogs(1, actionFilter);
  };

  const columns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (text: string) => new Date(text).toLocaleString('zh-CN'),
    },
    {
      title: '操作人',
      dataIndex: 'username',
      key: 'username',
      width: 120,
      render: (text: string) => text || '-',
    },
    {
      title: '操作',
      dataIndex: 'action',
      key: 'action',
      width: 150,
      render: (text: string) => <Tag color="blue">{text}</Tag>,
    },
    {
      title: '目标类型',
      dataIndex: 'target_type',
      key: 'target_type',
      width: 100,
      render: (text: string | null) => text || '-',
    },
    {
      title: '目标ID',
      dataIndex: 'target_id',
      key: 'target_id',
      width: 120,
      render: (text: string | null) => text ? text.slice(0, 8) + '...' : '-',
    },
    {
      title: 'IP地址',
      dataIndex: 'ip_address',
      key: 'ip_address',
      width: 140,
      render: (text: string | null) => text || '-',
    },
  ];

  return (
    <div>
      <h2 className="page-title">操作日志</h2>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <Input
          placeholder="按操作类型搜索"
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          onPressEnter={handleSearch}
          style={{ width: 250 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={logs}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page,
          total,
          pageSize: 20,
          onChange: (p) => setPage(p),
          showTotal: (t) => `共 ${t} 条`,
        }}
        scroll={{ x: 800 }}
      />
    </div>
  );
}
