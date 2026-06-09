import { useState, useEffect } from 'react';
import { Row, Col, Tag } from 'antd';
import { FileTextOutlined, UserOutlined, SmileOutlined, CalendarOutlined } from '@ant-design/icons';
import { Pie, Line } from '@ant-design/charts';
import { adminApi } from '../services/api';
import { EMOTION_LABELS } from '../constants/emotions';

export default function Dashboard() {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof adminApi.getStats>> | null>(null);
  const [trends, setTrends] = useState<Awaited<ReturnType<typeof adminApi.getTrends>> | null>(null);

  useEffect(() => {
    adminApi.getStats().then(setStats).catch(console.error);
    adminApi.getTrends().then(setTrends).catch(console.error);
  }, []);

  if (!stats) return <div style={{ color: '#c6c6cd', textAlign: 'center', padding: 40 }}>加载中...</div>;

  const pieData = (stats.emotionDistribution || []).map((item) => ({
    type: EMOTION_LABELS[item.emotion]?.label || item.emotion,
    value: item.count,
    color: EMOTION_LABELS[item.emotion]?.color || '#999',
  }));

  const lineData: { date: string; count: number }[] = trends?.recentDreams?.map(
    (item) => ({ date: item.date, count: item.count })
  ) || (stats as any).recentDailyCounts?.map(
    (item: any) => ({ date: item.date, count: item.count })
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
      {/* Stat Cards */}
      <Row gutter={[16, 16]}>
        {statCards.map((card) => (
          <Col span={6} key={card.title}>
            <div className="glass-panel" style={{ borderRadius: 16, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, color: card.color }}>
                {card.icon}
                <span style={{ fontSize: 11, color: '#c6c6cd', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  {card.title}
                </span>
              </div>
              <div className="stat-well" style={{ padding: 12, textAlign: 'center' }}>
                <span className="text-glow" style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: card.color,
                  display: 'block',
                  marginBottom: 2,
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
          <div className="glass-panel" style={{ borderRadius: 16, padding: 16, height: 296 }}>
            <h3 style={{ color: '#d0bcff', fontSize: 13, marginBottom: 12, letterSpacing: '0.05em' }}>情绪分布</h3>
            {pieData.length > 0 ? (
              <div style={{ height: 240 }}>
                <Pie
                  data={pieData}
                  angleField="value"
                  colorField="type"
                  color={pieData.map((d) => d.color)}
                  radius={0.9}
                  label={{ type: 'outer', content: '{name} {percentage}' }}
                  legend={{ position: 'bottom' as const }}
                  interactions={[{ type: 'pie-legend-active' }, { type: 'element-active' }]}
                />
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 30, color: '#909097' }}>暂无数据</div>
            )}
          </div>
        </Col>
        <Col span={12}>
          <div className="glass-panel" style={{ borderRadius: 16, padding: 16, height: 296 }}>
            <h3 style={{ color: '#4cd7f6', fontSize: 13, marginBottom: 12, letterSpacing: '0.05em' }}>近7天梦境数量</h3>
            {lineData.length > 0 ? (
              <div style={{ height: 240 }}>
                <Line
                  data={lineData}
                  xField="date"
                  yField="count"
                  smooth
                  point={{ size: 4 }}
                  yAxis={{ min: 0 }}
                  tooltip={{ showMarkers: true }}
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
          <div className="glass-panel" style={{ borderRadius: 16, padding: 16, height: 296 }}>
            <h3 style={{ color: '#4cd7f6', fontSize: 13, marginBottom: 12, letterSpacing: '0.05em' }}>近7天新用户数量</h3>
            {userLineData.length > 0 ? (
              <div style={{ height: 240 }}>
                <Line
                  data={userLineData}
                  xField="date"
                  yField="count"
                  smooth
                  point={{ size: 4 }}
                  yAxis={{ min: 0 }}
                  tooltip={{ showMarkers: true }}
                />
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 30, color: '#909097' }}>暂无数据</div>
            )}
          </div>
        </Col>
        <Col span={12}>
          <div className="glass-panel" style={{ borderRadius: 16, padding: 16, height: 296 }}>
            <h3 style={{ color: '#d0bcff', fontSize: 13, marginBottom: 12, letterSpacing: '0.05em' }}>情绪分布（标签）</h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {stats.emotionDistribution?.map((item) => {
                const meta = EMOTION_LABELS[item.emotion] || { label: item.emotion, color: '#999' };
                return (
                  <Tag key={item.emotion} color={meta.color} style={{ fontSize: 13, padding: '3px 10px' }}>
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
