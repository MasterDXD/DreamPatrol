import { useState } from 'react';
import { Card, Form, Input, InputNumber, Button, message } from 'antd';

export default function SystemSettings() {
  const [siteName, setSiteName] = useState('巡梦');
  const [jwtExpiresIn, setJwtExpiresIn] = useState('7d');
  const [rateLimitWindow, setRateLimitWindow] = useState(15);
  const [rateLimitMax, setRateLimitMax] = useState(100);

  const handleSave = () => {
    // 仅前端展示，暂不实现后端持久化
    message.success('设置已保存（仅前端展示，暂未持久化）');
  };

  return (
    <div>
      <h2 className="page-title">系统设置</h2>

      <Card title="站点配置" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="站点名称">
            <Input value={siteName} onChange={e => setSiteName(e.target.value)} />
          </Form.Item>
        </Form>
      </Card>

      <Card title="安全配置" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="JWT 过期时间">
            <Input value={jwtExpiresIn} onChange={e => setJwtExpiresIn(e.target.value)} placeholder="如 7d, 24h, 3600s" />
          </Form.Item>
        </Form>
      </Card>

      <Card title="速率限制" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="时间窗口（分钟）">
            <InputNumber min={1} value={rateLimitWindow} onChange={v => setRateLimitWindow(v || 15)} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="最大请求数">
            <InputNumber min={1} value={rateLimitMax} onChange={v => setRateLimitMax(v || 100)} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Card>

      <Button type="primary" onClick={handleSave}>保存设置</Button>
    </div>
  );
}
