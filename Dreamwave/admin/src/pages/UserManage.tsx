import { useState, useEffect, useMemo } from 'react';
import { Table, Button, Popconfirm, message, Tag, Input, Space } from 'antd';
import { adminApi } from '../services/api';
import type { User } from '../types';

export default function UserManage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getUsers();
      setUsers(data.users);
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadUsers(); }, []);

  const toggleStatus = async (id: string, isActive: boolean) => {
    try {
      await adminApi.updateUserStatus(id, !isActive);
      message.success(isActive ? '已禁用' : '已启用');
      loadUsers();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  // 按用户名搜索过滤
  const filteredUsers = useMemo(() => {
    if (!searchText.trim()) return users;
    const keyword = searchText.trim().toLowerCase();
    return users.filter(u => u.username.toLowerCase().includes(keyword));
  }, [users, searchText]);

  const columns = [
    {
      title: '用户',
      key: 'user',
      render: (_: unknown, record: User) => {
        const avatarSrc = record.avatar
          || `https://ui-avatars.com/api/?name=${encodeURIComponent(record.username)}&background=7c3aed&color=fff&size=64`;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <img
              src={avatarSrc}
              alt={record.username}
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                border: '2px solid rgba(124, 58, 237, 0.5)',
                objectFit: 'cover',
                flexShrink: 0,
              }}
            />
            <div>
              <div style={{ fontWeight: 500 }}>{record.username}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', fontFamily: 'monospace' }}>
                {record.id.slice(0, 8)}...
              </div>
            </div>
          </div>
        );
      },
    },
    { title: '梦境数', dataIndex: 'dream_count', key: 'dream_count', width: 90 },
    {
      title: '注册时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (v: string) => (
        <div>
          <div style={{ fontSize: 13 }}>{v?.slice(0, 19).replace('T', ' ')}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
            📅 {(() => {
              if (!v) return '—';
              const d = new Date(v);
              const now = new Date();
              const diffMs = now.getTime() - d.getTime();
              const days = Math.floor(diffMs / 86400000);
              if (days < 1) return '今天';
              if (days < 7) return `${days}天前`;
              if (days < 30) return `${Math.floor(days / 7)}周前`;
              return `${Math.floor(days / 30)}个月前`;
            })()}
          </div>
        </div>
      ),
    },
    {
      title: '状态', dataIndex: 'is_active', key: 'is_active', width: 80,
      render: (isActive: number) => isActive ? <Tag color="green">活跃</Tag> : <Tag color="red">禁用</Tag>,
    },
    {
      title: '操作', key: 'action', width: 80,
      render: (_: unknown, record: User) => (
        <Popconfirm
          title={record.is_active ? '确认禁用该用户？' : '确认启用该用户？'}
          onConfirm={() => toggleStatus(record.id, !!record.is_active)}
        >
          <Button type={record.is_active ? 'default' : 'primary'} size="small" danger={!!record.is_active}>
            {record.is_active ? '禁用' : '启用'}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Input.Search
          placeholder="按用户名搜索"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          onSearch={() => setSearchText(searchText)}
          allowClear
          style={{ width: 300 }}
        />
      </Space>
      <Table
        columns={columns}
        dataSource={filteredUsers}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: true }}
      />
    </div>
  );
}
