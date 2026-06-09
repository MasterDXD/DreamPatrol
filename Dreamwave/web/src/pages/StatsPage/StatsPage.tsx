import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import { EMOTION_META } from '../../constants/emotions';
import styles from './StatsPage.module.css';

interface StatsData {
  emotionDistribution: { emotion: string; count: number }[];
  recentDailyCounts: { recorded_date: string; count: number }[];
  totalDreams: number;
  totalDays: number;
  topTags: { name: string; color: string; count: number }[];
}

export default function StatsPage() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getDreamStats()
      .then(data => setStats(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <div>
            <div className={`${styles.pageTitle} ${styles.skeletonTitle}`}></div>
            <div className={`${styles.pageSubtitle} ${styles.skeletonSubtitle}`}></div>
          </div>
          <div className={`${styles.pageBadge} ${styles.skeletonBadge}`}></div>
        </div>
        <div className={styles.bentoGrid}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={`${styles.kpiCard} ${styles.skeletonCard}`}>
              <div className={styles.kpiTop}>
                <div className={`${styles.kpiLabel} ${styles.skeletonLabel}`}></div>
                <div className={`${styles.kpiIcon} ${styles.skeletonIcon}`}></div>
              </div>
              <div className={`${styles.kpiValue} ${styles.skeletonValue}`}></div>
              <div className={`${styles.kpiTrend} ${styles.skeletonTrend}`}></div>
            </div>
          ))}
          <div className={`${styles.nebulaCard} ${styles.skeletonCard}`}>
            <div className={`${styles.sectionTitle} ${styles.skeletonSectionTitle}`}></div>
            <div className={styles.nebulaVis}>
              <div className={styles.skeletonCircle}></div>
            </div>
          </div>
          <div className={`${styles.ringCard} ${styles.skeletonCard}`}>
            <div className={`${styles.sectionTitle} ${styles.skeletonSectionTitle}`}></div>
            <div className={`${styles.sectionSubtitle} ${styles.skeletonSectionSubtitle}`}></div>
            <div className={styles.ringChartWrapper}>
              <div className={styles.skeletonRing}></div>
            </div>
          </div>
          <div className={`${styles.trendCard} ${styles.skeletonCard}`}>
            <div className={styles.trendHeader}>
              <div className={`${styles.sectionTitle} ${styles.skeletonSectionTitle}`}></div>
              <div className={`${styles.trendPeriod} ${styles.skeletonPeriod}`}></div>
            </div>
            <div className={styles.barChart}>
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className={styles.barItem}>
                  <div className={styles.skeletonBar}></div>
                </div>
              ))}
            </div>
          </div>
          <div className={`${styles.tagCard} ${styles.skeletonCard}`}>
            <div className={`${styles.sectionTitle} ${styles.skeletonSectionTitle}`}></div>
            <div className={`${styles.sectionSubtitle} ${styles.skeletonSectionSubtitle}`}></div>
            <div className={styles.tagCloud}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={styles.skeletonTag}></div>
              ))}
            </div>
          </div>
          <div className={`${styles.aiCard} ${styles.skeletonCard}`}>
            <div className={styles.aiContent}>
              <div className={styles.skeletonAiIcon}></div>
              <div className={styles.aiTextWrap}>
                <div className={`${styles.aiTitle} ${styles.skeletonAiTitle}`}></div>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className={styles.skeletonAiText}></div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (!stats) return <div className={styles.empty}>暂无统计数据</div>;

  const maxCount = Math.max(...stats.recentDailyCounts.map(d => d.count), 1);
  const totalEmotions = stats.emotionDistribution.reduce((s, d) => s + d.count, 0);

  // 主导情绪
  const dominant = stats.emotionDistribution.length > 0
    ? stats.emotionDistribution.reduce((a, b) => (a.count > b.count ? a : b))
    : null;
  const dominantMeta = dominant
    ? EMOTION_META[dominant.emotion as keyof typeof EMOTION_META]
    : null;
  const dominantPct = dominant && totalEmotions > 0
    ? Math.round((dominant.count / totalEmotions) * 100)
    : 0;

  // 次要情绪（排除主导后的前2个）
  const secondaryEmotions = stats.emotionDistribution
    .filter(e => e !== dominant)
    .slice(0, 2);

  // SVG 环图参数
  const ringRadius = 80;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringSegments = buildRingSegments(stats.emotionDistribution, totalEmotions, ringCircumference);

  // 高频标签最大count
  const maxTagCount = Math.max(...stats.topTags.map(t => t.count), 1);

  // 今天日期字符串 MM-DD
  const todayStr = new Date().toISOString().slice(5, 10);

  return (
    <div className={styles.container}>
      {/* 背景装饰：星云光晕 */}
      <div className={styles.bgGlow1} />
      <div className={styles.bgGlow2} />

      {/* 页面标题 */}
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.pageTitle}>潜意识解析</h2>
          <p className={styles.pageSubtitle}>你本月的梦境模式与情绪波动已生成，基于过去30天的记录。</p>
        </div>
        <div className={styles.pageBadge}>本周分析</div>
      </div>

      {/* Bento Grid */}
      <div className={styles.bentoGrid}>
        {/* Row 1: KPI Stat Cards (3 cards) */}
        <div className={`${styles.kpiCard} ${styles.kpiCard1}`}>
          <div className={styles.kpiTop}>
            <span className={styles.kpiLabel}>记录总数</span>
            <div className={`${styles.kpiIcon} ${styles.kpiIconTertiary}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/>
              </svg>
            </div>
          </div>
          <div className={styles.kpiValue}>
            {stats.totalDreams}
            <span className={styles.kpiUnit}>场</span>
          </div>
          <p className={styles.kpiTrend}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
            比上月增加 12%
          </p>
        </div>

        <div className={`${styles.kpiCard} ${styles.kpiCard2}`}>
          <div className={styles.kpiTop}>
            <span className={styles.kpiLabel}>平均深度</span>
            <div className={`${styles.kpiIcon} ${styles.kpiIconSecondary}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61z"/>
              </svg>
            </div>
          </div>
          <div className={styles.kpiValue}>
            {stats.totalDays > 0 ? (stats.totalDreams / stats.totalDays).toFixed(1) : '0'}
            <span className={styles.kpiUnit}>场/天</span>
          </div>
          <p className={styles.kpiTrendSecondary}>
            {stats.totalDays} 天的记录密度
          </p>
        </div>

        <div className={`${styles.kpiCard} ${styles.kpiCard3}`}>
          <div className={styles.kpiTop}>
            <span className={styles.kpiLabel}>连续记录</span>
            <div className={`${styles.kpiIcon} ${styles.kpiIconPrimary}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/>
              </svg>
            </div>
          </div>
          <div className={styles.kpiValue}>
            {stats.totalDays}
            <span className={styles.kpiUnit}>天</span>
          </div>
          <p className={styles.kpiTrendPrimary}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
            保持记录习惯
          </p>
        </div>

        {/* Row 2: Mood Nebula (span 7) + Emotion Ring Chart (span 5) */}
        <div className={styles.nebulaCard}>
          <h3 className={styles.sectionTitle}>核心情绪状态</h3>
          <div className={styles.nebulaVis}>
            <div className={styles.nebulaOuterBlur} />
            <div className={styles.nebulaCircle} />
            <div className={styles.nebulaCenter}>
              <span className={styles.nebulaPct}>{dominantPct}%</span>
              <span className={styles.nebulaEmotion}>
                {dominantMeta?.label || '—'}
              </span>
            </div>
          </div>
          {secondaryEmotions.length > 0 && (
            <div className={styles.nebulaSecondary}>
              {secondaryEmotions.map(item => {
                const meta = EMOTION_META[item.emotion as keyof typeof EMOTION_META];
                const pct = totalEmotions > 0 ? Math.round((item.count / totalEmotions) * 100) : 0;
                return (
                  <div key={item.emotion} className={styles.secondaryItem}>
                    <div className={styles.secondaryBar}>
                      <div
                        className={styles.secondaryBarFill}
                        style={{
                          width: `${pct}%`,
                          backgroundColor: meta?.color || '#999',
                          boxShadow: `0 0 8px ${meta?.color || '#999'}`,
                        }}
                      />
                    </div>
                    <span className={styles.secondaryLabel}>
                      {meta?.label || item.emotion} {pct}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className={styles.ringCard}>
          <h3 className={styles.sectionTitle}>情绪分布</h3>
          <p className={styles.sectionSubtitle}>梦境中的主导情绪</p>
          <div className={styles.ringChartWrapper}>
            <svg className={styles.ringSvg} viewBox="0 0 200 200">
              {/* Background track */}
              <circle
                cx="100" cy="100" r={ringRadius}
                fill="none"
                stroke="rgba(255,255,255,0.05)"
                strokeWidth="16"
              />
              {/* Segments */}
              {ringSegments.map((seg, i) => (
                <circle
                  key={i}
                  className={styles.ringSegment}
                  cx="100" cy="100" r={ringRadius}
                  fill="none"
                  stroke={seg.color}
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={seg.offset}
                  strokeLinecap="round"
                  strokeWidth="16"
                  transform={`rotate(${seg.rotation} 100 100)`}
                  style={{
                    transition: `stroke-dashoffset 1.5s ease-out ${i * 0.2}s`,
                  }}
                />
              ))}
              {/* Center text */}
              <g transform="rotate(90 100 100)">
                <text
                  x="100" y="92"
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize="18"
                  fontWeight="600"
                  fontFamily="inherit"
                >
                  {dominantMeta?.label || '—'}
                </text>
                <text
                  x="100" y="115"
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="9"
                  fontFamily="inherit"
                >
                  主导情绪
                </text>
              </g>
            </svg>
          </div>
          {/* Legend */}
          <div className={styles.ringLegend}>
            {stats.emotionDistribution.slice(0, 5).map(item => {
              const meta = EMOTION_META[item.emotion as keyof typeof EMOTION_META];
              const pct = totalEmotions > 0 ? Math.round((item.count / totalEmotions) * 100) : 0;
              return (
                <div key={item.emotion} className={styles.legendItem}>
                  <span
                    className={styles.legendDot}
                    style={{
                      backgroundColor: meta?.color || '#999',
                      boxShadow: `0 0 8px ${meta?.color || '#999'}`,
                    }}
                  />
                  <span className={styles.legendLabel}>
                    {meta?.label || item.emotion} ({pct}%)
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Row 3: 7-Day Trend (span 7) + High-Frequency Elements (span 5) */}
        <div className={styles.trendCard}>
          <div className={styles.trendHeader}>
            <div>
              <h3 className={styles.sectionTitle}>情绪波动趋势</h3>
            </div>
            <span className={styles.trendPeriod}>近 7 天</span>
          </div>
          <div className={styles.barChart}>
            {stats.recentDailyCounts.map((item, idx) => {
              const isToday = item.recorded_date.slice(5) === todayStr;
              const isLast = idx === stats.recentDailyCounts.length - 1;
              return (
                <div key={item.recorded_date} className={styles.barItem}>
                  <span className={styles.barValue}>{item.count}</span>
                  <div
                    className={`${styles.bar} ${isToday || isLast ? styles.barHighlight : ''}`}
                    style={{ height: `${(item.count / maxCount) * 100}%` }}
                  />
                  <span className={styles.barLabel}>
                    {isToday || isLast ? '今日' : item.recorded_date.slice(5)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className={styles.tagCard}>
          <h3 className={styles.sectionTitle}>高频元素</h3>
          <p className={styles.sectionSubtitle}>潜意识中反复出现的意象</p>
          <div className={styles.tagCloud}>
            {stats.topTags.map((tag, idx) => {
              const ratio = tag.count / maxTagCount;
              const isTop = idx === 0;
              const sizeClass = isTop
                ? styles.tagLg
                : ratio > 0.6
                  ? styles.tagMd
                  : styles.tagSm;
              return (
                <span
                  key={tag.name}
                  className={`${styles.tagPill} ${sizeClass}`}
                  style={isTop ? {
                    borderColor: `${tag.color}66`,
                    backgroundColor: `${tag.color}1a`,
                    color: tag.color,
                    boxShadow: `0 0 15px ${tag.color}26`,
                  } : ratio > 0.6 ? {
                    borderColor: `${tag.color}4d`,
                    backgroundColor: `${tag.color}1a`,
                    color: tag.color,
                  } : undefined}
                >
                  <span
                    className={styles.tagDot}
                    style={{
                      backgroundColor: isTop ? tag.color : undefined,
                      boxShadow: isTop ? `0 0 6px ${tag.color}` : undefined,
                    }}
                  />
                  {tag.name}
                </span>
              );
            })}
          </div>
        </div>

        {/* Row 4: AI Insight (span 12) */}
        <div className={styles.aiCard}>
          <div className={styles.aiDecorIcon}>
            <svg width="80" height="80" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
          </div>
          <div className={styles.aiContent}>
            <div className={styles.aiIconSquare}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                <path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25z"/>
              </svg>
            </div>
            <div className={styles.aiTextWrap}>
              <h3 className={styles.aiTitle}>AI 织梦洞察</h3>
              <p className={styles.aiText}>
                {dominant
                  ? `本周你的梦境中主导情绪为「${dominantMeta?.label || dominant.emotion}」，占比 ${dominantPct}%。${
                      secondaryEmotions.length > 0
                        ? `次要情绪包括${secondaryEmotions
                            .map(e => EMOTION_META[e.emotion as keyof typeof EMOTION_META]?.label || e.emotion)
                            .join('和')}。`
                        : ''
                    }${stats.topTags.length > 0 ? `高频元素「${stats.topTags[0].name}」反复出现，暗示着内心正在经历深层的情感整合。建议在睡前进行10分钟的冥想，帮助潜意识平稳着陆。` : '建议保持记录习惯，更多数据将帮助生成更精准的洞察。'}`
                  : '记录更多梦境后，AI 将为你生成个性化的潜意识洞察。'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RingSegment {
  color: string;
  offset: number;
  rotation: number;
}

function buildRingSegments(
  distribution: { emotion: string; count: number }[],
  total: number,
  circumference: number,
): RingSegment[] {
  if (total === 0 || distribution.length === 0) return [];

  const segments: RingSegment[] = [];
  let accumulatedRotation = 0;

  for (const item of distribution) {
    const meta = EMOTION_META[item.emotion as keyof typeof EMOTION_META];
    const color = meta?.color || '#999';
    const fraction = item.count / total;
    const segmentLength = fraction * circumference;
    const offset = circumference - segmentLength;

    segments.push({
      color,
      offset,
      rotation: accumulatedRotation,
    });

    accumulatedRotation += fraction * 360;
  }

  return segments;
}
