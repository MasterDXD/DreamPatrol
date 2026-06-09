import { useState, useEffect } from 'react';
import { Row, Col, Tag } from 'antd';
import { FileTextOutlined, UserOutlined, SmileOutlined, CalendarOutlined } from '@ant-design/icons';
import { Pie, Line } from '@ant-design/charts';
import { adminApi } from '../services/api';
import { EMOTION_LABELS } from '../constants/emotions';

export default function Dashboard() {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof adminApi.getStats>> | null>(null);
  const [trends, setTrends] = useState<Awaited<ReturnType<typeof adminApi.getTrends>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      adminApi.getStats().then(setStats),
      adminApi.getTrends().then(setTrends),
    ]).catch((err) => {
      console.error('[Dashboard] Failed to load data:', err);
      setError(err.message || '加载数据失败');
    });
  }, []);

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: 60, color: '#ff4d4f' }}>
        <p>{error}</p>
        <button onClick={() => { setError(null); window.location.reload(); }} style={{ color: '#a78bfa', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>重试</button>
      </div>
    );
  }

  if (!stats) {
    return (
      <div style={{ animation: 'skeletonPulse 1.5s ease-in-out infinite' }}>
        <Row gutter={[16, 16]}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Col span={6} key={i}>
              <div className="glass-panel" style={{ borderRadius: 16, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <div style={{ width: 20, height: 20, background: 'rgba(255,255,255,0.1)', borderRadius: 4 }}></div>
                  <div style={{ width: 80, height: 14, background: 'rgba(255,255,255,0.08)', borderRadius: 4 }}></div>
                </div>
                <div className="stat-well" style={{ padding: 12, textAlign: 'center' }}>
                  <div style={{ width: 100, height: 28, background: 'rgba(255,255,255,0.1)', borderRadius: 8, margin: '0 auto' }}></div>
                </div>
              </div>
            </Col>
          ))}
        </Row>
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col span={12}>
            <div className="glass-panel" style={{ borderRadius: 16, padding: 16, height: 296 }}>
              <div style={{ width: 100, height: 18, background: 'rgba(255,255,255,0.1)', borderRadius: 4, marginBottom: 12 }}></div>
              <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 150, height: 150, background: 'rgba(255,255,255,0.06)', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.08)' }}></div>
              </div>
            </div>
          </Col>
          <Col span={12}>
            <div className="glass-panel" style={{ borderRadius: 16, padding: 16, height: 296 }}>
              <div style={{ width: 120, height: 18, background: 'rgba(255,255,255,0.1)', borderRadius: 4, marginBottom: 12 }}></div>
              <div style={{ height: 240, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-around', padding: '0 20px' }}>
                {Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} style={{ width: 24, height: `${30 + Math.random() * 70}%`, background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}></div>
                ))}
              </div>
            </div>
          </Col>
        </Row>
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col span={12}>
            <div className="glass-panel" style={{ borderRadius: 16, padding: 16, height: 296 }}>
              <div style={{ width: 120, height: 18, background: 'rgba(255,255,255,0.1)', borderRadius: 4, marginBottom: 12 }}></div>
              <div style={{ height: 240, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-around', padding: '0 20px' }}>
                {Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} style={{ width: 24, height: `${30 + Math.random() * 70}%`, background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}></div>
                ))}
              </div>
            </div>
          </Col>
          <Col span={12}>
            <div className="glass-panel" style={{ borderRadius: 16, padding: 16, height: 296 }}>
              <div style={{ width: 100, height: 18, background: 'rgba(255,255,255,0.1)', borderRadius: 4, marginBottom: 12 }}></div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} style={{ height: 28, padding: '0 16px', background: 'rgba(255,255,255,0.08)', borderRadius: 9999 }}></div>
                ))}
              </div>
            </div>
          </Col>
        </Row>
      </div>
    );
  }

  const pieData = (stats.emotionDistribution || []).map((item) => ({
    type: EMOTION_LABELS[item.emotion]?.label || item.emotion,
    value: item.count,
    color: EMOTION_LABELS[item.emotion]?.color || '#999',
  }));

  const lineData: { date: string; count: number }[] = trends?.recentDreams?.map(
    (item) => ({ date: item.date, count: item.count })
  ) || [];

  const userLineData: { date: string; count: number }[] = trends?.recentUsers?.map(
    (item) => ({ date: item.date, count: item.count })
  ) || [];

  const statCards = [
    { title: '梦境总数', value: stats.totalDreams, icon: <FileTextOutlined />, color: '#d0bcff' },
    { title: '注册用户', value: stats.totalUsers, icon: <UserOutlined />, color: '#4cd7f6' },
    { title: '活跃用户', value: stats.activeUsers, icon: <SmileOutlined />, color: '#4caf50' },
    { title: '今日梦境', value: stats.todayDreams, icon: <CalendarOutlined />, color: '#F0A050' },
  ];

  return (
    <div>
      {/* Page Header */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{
          fontSize: 24,
          fontWeight: 700,
          color: '#d4e4fa',
          letterSpacing: '0.02em',
          marginBottom: 4,
        }}>
          数据概览
        </h2>
        <p style={{ fontSize: 13, color: '#909097', letterSpacing: '0.02em' }}>
          梦境系统的整体运行状态
        </p>
      </div>

      {/* Stat Cards */}
      <Row gutter={[16, 16]}>
        {statCards.map((card) => (
          <Col span={6} key={card.title}>
            <div className="glass-panel" style={{
              borderRadius: 16,
              padding: 16,
              position: 'relative',
              overflow: 'hidden',
            }}>
              {/* 装饰渐变光晕 */}
              <div style={{
                position: 'absolute',
                top: -20,
                right: -20,
                width: 80,
                height: 80,
                borderRadius: '50%',
                background: `radial-gradient(circle, ${card.color}25, transparent 70%)`,
                filter: 'blur(8px)',
                pointerEvents: 'none',
              }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, color: card.color, position: 'relative' }}>
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: `${card.color}15`,
                  border: `1px solid ${card.color}30`,
                }}>
                  {card.icon}
                </div>
                <span style={{ fontSize: 11, color: '#c6c6cd', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  {card.title}
                </span>
              </div>
              <div className="stat-well" style={{ padding: 16, textAlign: 'center', position: 'relative' }}>
                <span className="text-glow" style={{
                  fontSize: 32,
                  fontWeight: 700,
                  color: card.color,
                  display: 'block',
                  letterSpacing: '0.02em',
                }}>
                  {card.value}
                </span>
              </div>
            </div>
          </Col>
        ))}
      </Row>

      {/* Charts Row */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <div className="glass-panel" style={{ borderRadius: 16, padding: 20, height: 320, position: 'relative', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 2,
              background: 'linear-gradient(90deg, transparent, #d0bcff, transparent)',
              opacity: 0.6,
            }} />
            <h3 style={{
              color: '#d0bcff',
              fontSize: 14,
              fontWeight: 600,
              marginBottom: 16,
              letterSpacing: '0.05em',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{
                width: 4,
                height: 14,
                borderRadius: 2,
                background: 'linear-gradient(180deg, #d0bcff, #a78bfa)',
                boxShadow: '0 0 8px rgba(208, 188, 255, 0.5)',
              }} />
              情绪分布
            </h3>
            {pieData.length > 0 ? (
              <div style={{ height: 240 }}>
                <Pie
                  data={pieData}
                  angleField="value"
                  colorField="type"
                  color={pieData.map((d) => d.color)}
                  radius={0.9}
                  label={{
                    text: (d: { type: string; value: number }) => `${d.type}: ${d.value}`,
                    position: 'spider',
                  }}
                  legend={{ color: { position: 'bottom' } }}
                  interaction={{ elementHighlight: true }}
                />
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 30, color: '#909097' }}>暂无数据</div>
            )}
          </div>
        </Col>
        <Col span={12}>
          <div className="glass-panel" style={{ borderRadius: 16, padding: 20, height: 320, position: 'relative', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 2,
              background: 'linear-gradient(90deg, transparent, #4cd7f6, transparent)',
              opacity: 0.6,
            }} />
            <h3 style={{
              color: '#4cd7f6',
              fontSize: 14,
              fontWeight: 600,
              marginBottom: 16,
              letterSpacing: '0.05em',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{
                width: 4,
                height: 14,
                borderRadius: 2,
                background: 'linear-gradient(180deg, #4cd7f6, #1789fb)',
                boxShadow: '0 0 8px rgba(76, 215, 246, 0.5)',
              }} />
              近7天梦境数量
            </h3>
            {lineData.length > 0 ? (
              <div style={{ height: 240 }}>
                <Line
                  data={lineData}
                  xField="date"
                  yField="count"
                  shapeField="smooth"
                  point={{ shapeField: 'circle', sizeField: 4 }}
                  axis={{ y: { min: 0 } }}
                  tooltip={true}
                />
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 30, color: '#909097' }}>暂无数据</div>
            )}
          </div>
        </Col>
      </Row>

      {/* Second Charts Row */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <div className="glass-panel" style={{ borderRadius: 16, padding: 20, height: 320, position: 'relative', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 2,
              background: 'linear-gradient(90deg, transparent, #4cd7f6, transparent)',
              opacity: 0.6,
            }} />
            <h3 style={{
              color: '#4cd7f6',
              fontSize: 14,
              fontWeight: 600,
              marginBottom: 16,
              letterSpacing: '0.05em',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{
                width: 4,
                height: 14,
                borderRadius: 2,
                background: 'linear-gradient(180deg, #4cd7f6, #1789fb)',
                boxShadow: '0 0 8px rgba(76, 215, 246, 0.5)',
              }} />
              近7天新用户数量
            </h3>
            {userLineData.length > 0 ? (
              <div style={{ height: 240 }}>
                <Line
                  data={userLineData}
                  xField="date"
                  yField="count"
                  shapeField="smooth"
                  point={{ shapeField: 'circle', sizeField: 4 }}
                  axis={{ y: { min: 0 } }}
                  tooltip={true}
                />
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 30, color: '#909097' }}>暂无数据</div>
            )}
          </div>
        </Col>
        <Col span={12}>
          <div className="glass-panel" style={{ borderRadius: 16, padding: 20, height: 320, position: 'relative', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 2,
              background: 'linear-gradient(90deg, transparent, #d0bcff, transparent)',
              opacity: 0.6,
            }} />
            <h3 style={{
              color: '#d0bcff',
              fontSize: 14,
              fontWeight: 600,
              marginBottom: 16,
              letterSpacing: '0.05em',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{
                width: 4,
                height: 14,
                borderRadius: 2,
                background: 'linear-gradient(180deg, #d0bcff, #a78bfa)',
                boxShadow: '0 0 8px rgba(208, 188, 255, 0.5)',
              }} />
              情绪分布（标签）
            </h3>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {stats.emotionDistribution?.map((item) => {
                const meta = EMOTION_LABELS[item.emotion] || { label: item.emotion, color: '#999' };
                return (
                  <Tag key={item.emotion} color={meta.color} style={{
                    fontSize: 13,
                    padding: '6px 14px',
                    borderRadius: 9999,
                    fontWeight: 500,
                    border: 'none',
                    boxShadow: `0 0 12px ${meta.color}30`,
                  }}>
                    {meta.label}: {item.count}
                  </Tag>
                );
              })}
            </div>
          </div>
        </Col>
      </Row>
    </div>
  );
}
