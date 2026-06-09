import { useState, useEffect } from 'react';
import { Card, Form, Input, InputNumber, Select, Button, message, Spin } from 'antd';
import { adminApi } from '../services/api';

const IMAGE_SIZE_OPTIONS = [
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
];
const IMAGE_RESOLUTION_OPTIONS = [
  { value: '1k', label: '1k' },
  { value: '2k', label: '2k' },
  { value: '4k', label: '4k' },
];
const IMAGE_FORMAT_OPTIONS = [
  { value: 'png', label: 'png' },
  { value: 'jpg', label: 'jpg' },
  { value: 'webp', label: 'webp' },
];

export default function AIConfig() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const res = await adminApi.getAIConfig();
      setConfig(res.config);
    } catch {
      message.error('获取AI配置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await adminApi.updateAIConfig(config);
      message.success('AI配置保存成功');
    } catch {
      message.error('保存AI配置失败');
    } finally {
      setSaving(false);
    }
  };

  const updateField = (key: string, value: string) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>;
  }

  return (
    <div>
      <h2 className="page-title">AI 配置</h2>

      <Card title="API 密钥" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="DimiLinks API Key" help="用于生图和解读的大模型 API 密钥">
            <Input.Password
              value={config.api_key || ''}
              onChange={e => updateField('api_key', e.target.value)}
              placeholder="请输入 API Key"
            />
          </Form.Item>
        </Form>
      </Card>

      <Card title="生图参数" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="生图模型">
            <Input
              value={config.image_model || ''}
              onChange={e => updateField('image_model', e.target.value)}
              placeholder="如 gpt-image-2"
            />
          </Form.Item>
          <Form.Item label="图片尺寸">
            <Select
              value={config.image_size || '16:9'}
              onChange={v => updateField('image_size', v)}
              options={IMAGE_SIZE_OPTIONS}
            />
          </Form.Item>
          <Form.Item label="分辨率">
            <Select
              value={config.image_resolution || '1k'}
              onChange={v => updateField('image_resolution', v)}
              options={IMAGE_RESOLUTION_OPTIONS}
            />
          </Form.Item>
          <Form.Item label="输出格式">
            <Select
              value={config.image_format || 'png'}
              onChange={v => updateField('image_format', v)}
              options={IMAGE_FORMAT_OPTIONS}
            />
          </Form.Item>
        </Form>
      </Card>

      <Card title="解读参数" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="解读模型">
            <Input
              value={config.chat_model || ''}
              onChange={e => updateField('chat_model', e.target.value)}
              placeholder="如 deepseek-v4-flash"
            />
          </Form.Item>
          <Form.Item label="Temperature">
            <InputNumber
              min={0}
              max={2}
              step={0.1}
              value={parseFloat(config.chat_temperature || '0.7')}
              onChange={v => updateField('chat_temperature', String(v ?? 0.7))}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item label="System Prompt">
            <Input.TextArea
              rows={12}
              value={config.system_prompt || ''}
              onChange={e => updateField('system_prompt', e.target.value)}
              placeholder="梦境解读的系统提示词"
            />
          </Form.Item>
        </Form>
      </Card>

      <Card title="用户每日限额" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="每日生图限额" help="每个用户每天可生成的图片数量">
            <InputNumber
              min={0}
              max={100}
              value={parseInt(config.daily_image_limit || '2', 10)}
              onChange={v => updateField('daily_image_limit', String(v ?? 2))}
              style={{ width: '100%' }}
              addonAfter="次/天"
            />
          </Form.Item>
          <Form.Item label="每日解读限额" help="每个用户每天可使用的梦境解读次数">
            <InputNumber
              min={0}
              max={100}
              value={parseInt(config.daily_chat_limit || '2', 10)}
              onChange={v => updateField('daily_chat_limit', String(v ?? 2))}
              style={{ width: '100%' }}
              addonAfter="次/天"
            />
          </Form.Item>
        </Form>
      </Card>

      <Button type="primary" onClick={handleSave} loading={saving} size="large">
        保存配置
      </Button>
    </div>
  );
}
