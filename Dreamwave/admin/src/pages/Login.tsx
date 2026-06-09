import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Form, Input, Button, App } from 'antd';
import { adminApi } from '../services/api';

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const data = await adminApi.login(values.username, values.password);
      if (data.user.role !== 'admin') {
        message.error('需要管理员权限');
        return;
      }
      localStorage.setItem('dreamwave_admin_token', data.token);
      onLogin();
      navigate('/');
    } catch (err: any) {
      console.error('[Admin Login] Error:', err);
      message.error(err.message || '登录失败，请检查用户名和密码');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden',
      background: '#0d1126',
    }}>
      {/* Nebula effects */}
      <div style={{
        position: 'absolute',
        top: '15%',
        left: '15%',
        width: 400,
        height: 400,
        background: 'rgba(167, 139, 250, 0.15)',
        borderRadius: 9999,
        filter: 'blur(100px)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute',
        bottom: '15%',
        right: '10%',
        width: 500,
        height: 500,
        background: 'rgba(139, 92, 246, 0.1)',
        borderRadius: 9999,
        filter: 'blur(120px)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '60%',
        width: 300,
        height: 300,
        background: 'rgba(217, 70, 239, 0.08)',
        borderRadius: 9999,
        filter: 'blur(80px)',
        pointerEvents: 'none',
      }} />

      {/* Form Card */}
      <div style={{
        position: 'relative',
        zIndex: 2,
        width: 380,
        padding: '32px 32px',
        borderRadius: 20,
        background: 'rgba(20, 25, 55, 0.45)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 60px rgba(167, 139, 250, 0.06)',
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <img
            src="/assets/logo.jpg"
            alt="巡梦"
            style={{
              height: 24,
              width: 'auto',
              objectFit: 'contain',
              marginBottom: 6,
              filter: 'drop-shadow(0 0 12px rgba(167, 139, 250, 0.4))',
            }}
          />
          <p style={{
            fontSize: 13,
            color: '#94a3b8',
            letterSpacing: 2,
          }}>
            管理后台
          </p>
          <div style={{
            width: 50,
            height: 2,
            background: 'linear-gradient(90deg, transparent, #a78bfa, transparent)',
            margin: '12px auto 0',
            borderRadius: 1,
          }} />
        </div>

        <Form onFinish={onFinish} layout="vertical" size="large">
          <Form.Item
            name="username"
            label={<span style={{ color: '#94a3b8', fontSize: 13 }}>用户名</span>}
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              placeholder="admin"
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                background: 'rgba(45, 50, 90, 0.4)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#e2e8f0',
              }}
            />
          </Form.Item>
          <Form.Item
            name="password"
            label={<span style={{ color: '#94a3b8', fontSize: 13 }}>密码</span>}
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              placeholder="admin123"
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                background: 'rgba(45, 50, 90, 0.4)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#e2e8f0',
              }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 12 }}>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              style={{
                height: 42,
                borderRadius: 21,
                fontSize: 15,
                fontWeight: 600,
                background: 'linear-gradient(90deg, #8b5cf6, #d946ef)',
                border: 'none',
                boxShadow: '0 0 20px rgba(167, 139, 250, 0.4)',
              }}
            >
              登 录
            </Button>
          </Form.Item>
        </Form>

        <div style={{
          textAlign: 'center',
          color: '#64748b',
          fontSize: 12,
          paddingTop: 6,
          borderTop: '1px solid rgba(255, 255, 255, 0.06)',
        }}>
          默认管理员：admin / admin123
        </div>
      </div>
    </div>
  );
}
