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
    { title: '用户名', dataIndex: 'username', key: 'username' },
    { title: '梦境数', dataIndex: 'dream_count', key: 'dream_count', width: 80 },
    { title: '注册时间', dataIndex: 'created_at', key: 'created_at', width: 170, render: (v: string) => v?.slice(0, 19).replace('T', ' ') },
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
