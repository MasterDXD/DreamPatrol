import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import type { Dream, EmotionType } from '../../types/dream';
import { EMOTION_META } from '../../constants/emotions';
import Toast from '../../components/Toast/Toast';
import styles from './CalendarPage.module.css';

const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const WEEK_DAYS = ['一', '二', '三', '四', '五', '六', '日'];

function formatDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function emotionGlow(color: string): string {
  // Convert hex to rgb for glow
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `0 0 8px rgba(${r}, ${g}, ${b}, 0.6)`;
}

export default function CalendarPage() {
  const navigate = useNavigate();
  const today = new Date();
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(today.getMonth() + 1);
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const d = new Date();
    return formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  });
  const [dreamsByDate, setDreamsByDate] = useState<Dream[]>([]);
  const [recordedDates, setRecordedDates] = useState<string[]>([]);
  const [dateEmotions, setDateEmotions] = useState<Map<string, EmotionType[]>>(new Map());
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [fading, setFading] = useState(false);

  /* 加载记录日期列表和情绪分布数据 */
  const loadCalendarData = useCallback(async () => {
    try {
      const datesData = await api.getRecordedDates();
      setRecordedDates(datesData.dates);
    } catch (err: any) {
      setToast({ message: err.message || '加载日历数据失败', type: 'error' });
    }
  }, []);

  /* 加载近期梦境，构建日期-情绪映射 */
  const loadEmotionData = useCallback(async () => {
    try {
      const data = await api.getDreams({ limit: 100 });
      const map = new Map<string, EmotionType[]>();
      for (const dream of data.dreams) {
        const date = dream.recorded_date;
        if (!map.has(date)) {
          map.set(date, []);
        }
        const emotions = map.get(date)!;
        if (!emotions.includes(dream.emotion)) {
          emotions.push(dream.emotion);
        }
      }
      setDateEmotions(map);
    } catch {}
  }, []);

  useEffect(() => { loadCalendarData(); loadEmotionData(); }, [loadCalendarData, loadEmotionData]);

  useEffect(() => {
    if (selectedDate) {
      api.getDreamsByDate(selectedDate)
        .then(data => setDreamsByDate(data.dreams))
        .catch(() => {
          setToast({ message: '加载日期梦境失败', type: 'error' });
          setDreamsByDate([]);
        });
    }
  }, [selectedDate]);

  const changeMonth = (delta: number) => {
    setFading(true);
    setTimeout(() => {
      let m = currentMonth + delta;
      let y = currentYear;
      if (m < 1) { m = 12; y--; }
      else if (m > 12) { m = 1; y++; }
      setCurrentMonth(m);
      setCurrentYear(y);
      const newDate = formatDate(y, m, 1);
      setSelectedDate(newDate);
      setFading(false);
    }, 250);
  };

  const goToday = () => {
    const d = new Date();
    setFading(true);
    setTimeout(() => {
      setCurrentYear(d.getFullYear());
      setCurrentMonth(d.getMonth() + 1);
      setSelectedDate(formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate()));
      setFading(false);
    }, 250);
  };

  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  // Monday=0 ... Sunday=6 (shifted from JS getDay)
  const firstDayJS = new Date(currentYear, currentMonth - 1, 1).getDay();
  const firstDay = firstDayJS === 0 ? 6 : firstDayJS - 1; // convert to Mon=0

  const days = useMemo(() => Array.from({ length: daysInMonth }, (_, i) => i + 1), [daysInMonth]);

  // Previous month trailing days
  const prevMonthDays = new Date(currentYear, currentMonth - 1, 0).getDate();
  const trailingDays = useMemo(() =>
    Array.from({ length: firstDay }, (_, i) => prevMonthDays - firstDay + 1 + i),
    [firstDay, prevMonthDays]
  );

  // Next month leading days
  const totalCells = firstDay + daysInMonth;
  const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  const leadingDays = useMemo(() =>
    Array.from({ length: remainingCells }, (_, i) => i + 1),
    [remainingCells]
  );

  // Count dreams for current month
  const monthDreamCount = useMemo(() => {
    let count = 0;
    for (const date of recordedDates) {
      const [y, m] = date.split('-').map(Number);
      if (y === currentYear && m === currentMonth) count++;
    }
    return count;
  }, [recordedDates, currentYear, currentMonth]);

  const todayStr = formatDate(today.getFullYear(), today.getMonth() + 1, today.getDate());

  // Format selected date for display
  const selectedDateDisplay = useMemo(() => {
    if (!selectedDate) return '';
    const [, m, d] = selectedDate.split('-');
    return `${parseInt(m)}月${parseInt(d)}日`;
  }, [selectedDate]);

  // Format dream time from created_at
  function formatDreamTime(createdAt: string): string {
    try {
      const d = new Date(createdAt);
      const h = d.getHours();
      const min = String(d.getMinutes()).padStart(2, '0');
      if (h >= 0 && h < 5) return `凌晨 ${String(h).padStart(2, '0')}:${min}`;
      if (h >= 5 && h < 8) return `清晨 ${String(h).padStart(2, '0')}:${min}`;
      if (h >= 8 && h < 12) return `上午 ${String(h).padStart(2, '0')}:${min}`;
      if (h >= 12 && h < 14) return `中午 ${String(h).padStart(2, '0')}:${min}`;
      if (h >= 14 && h < 18) return `下午 ${String(h).padStart(2, '0')}:${min}`;
      if (h >= 18 && h < 21) return `傍晚 ${String(h).padStart(2, '0')}:${min}`;
      return `夜晚 ${String(h).padStart(2, '0')}:${min}`;
    } catch {
      return '';
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.mainLayout}>
        {/* Calendar section */}
        <section className={`${styles.calendarSection} ${styles.glassPanel}`}>
          <div className={styles.calendarHeader}>
            <div className={styles.headerLeft}>
              <h1 className={styles.monthTitle}>
                {MONTH_NAMES[currentMonth - 1]}
                <span className={styles.monthTitleYear}>{currentYear}</span>
              </h1>
              <p className={styles.monthSubtitle}>本月记录了 {monthDreamCount} 个梦境</p>
            </div>
            <div className={styles.headerNav}>
              <button onClick={() => changeMonth(-1)} className={styles.navBtn} aria-label="上个月">‹</button>
              <button onClick={goToday} className={styles.todayBtn}>回到今天</button>
              <button onClick={() => changeMonth(1)} className={styles.navBtn} aria-label="下个月">›</button>
            </div>
          </div>

          <div className={styles.calendarBody}>
            <div className={styles.weekHeader}>
              {WEEK_DAYS.map(d => (
                <div key={d} className={styles.weekDay}>{d}</div>
              ))}
            </div>

            <div className={`${styles.daysGrid} ${fading ? styles.daysGridFading : ''}`}>
              {/* Previous month trailing days */}
              {trailingDays.map(day => (
                <div key={`prev-${day}`} className={`${styles.dayCell} ${styles.dayCellOtherMonth}`}>
                  <div className={styles.dayNumber}>{day}</div>
                </div>
              ))}
              {/* Current month days */}
              {days.map(day => {
                const dateStr = formatDate(currentYear, currentMonth, day);
                const isSelected = dateStr === selectedDate;
                const isToday = dateStr === todayStr;
                const hasRecord = recordedDates.includes(dateStr);
                const emotions = dateEmotions.get(dateStr) || [];
                const displayEmotions = emotions.slice(0, 3);

                const cellClass = [
                  styles.dayCell,
                  isSelected ? styles.dayCellSelected : '',
                  isToday ? styles.dayCellToday : '',
                ].filter(Boolean).join(' ');

                return (
                  <div
                    key={dateStr}
                    onClick={() => setSelectedDate(dateStr)}
                    className={cellClass}
                  >
                    <div className={styles.dayNumber}>{day}</div>
                    {hasRecord && (
                      <div className={styles.recordIndicator}>
                        {displayEmotions.length > 0 ? (
                          displayEmotions.map(e => (
                            <div
                              key={e}
                              className={styles.emotionDot}
                              style={{
                                backgroundColor: EMOTION_META[e].color,
                                boxShadow: emotionGlow(EMOTION_META[e].color),
                              }}
                            />
                          ))
                        ) : (
                          <div
                            className={styles.emotionDot}
                            style={{
                              backgroundColor: 'var(--color-primary, #a78bfa)',
                              boxShadow: emotionGlow('#a78bfa'),
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {/* Next month leading days */}
              {leadingDays.map(day => (
                <div key={`next-${day}`} className={`${styles.dayCell} ${styles.dayCellOtherMonth}`}>
                  <div className={styles.dayNumber}>{day}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Side panel (desktop) */}
        <aside className={styles.sidePanel}>
          <div className={`${styles.glassPanel} ${styles.sidePanelHeader}`}>
            <h2 className={styles.sidePanelDate}>{selectedDateDisplay}</h2>
            <p className={styles.sidePanelSubtitle}>
              ✦ {dreamsByDate.length} 个梦境碎片
            </p>
          </div>
          <div className={styles.sidePanelList}>
            {dreamsByDate.length === 0 ? (
              <p className={styles.noDreamsText}>这一天没有梦</p>
            ) : (
              dreamsByDate.map(dream => {
                const meta = EMOTION_META[dream.emotion];
                return (
                  <div
                    key={dream.id}
                    onClick={() => navigate(`/dream/${dream.id}`)}
                    className={`${styles.glassPanelLight} ${styles.dreamCard}`}
                  >
                    <div className={styles.dreamCardTop}>
                      <div className={styles.dreamCardLeft}>
                        <div
                          className={styles.emotionIconCircle}
                          style={{
                            background: `${meta.color}20`,
                            border: `1px solid ${meta.color}50`,
                          }}
                        >
                          {meta.icon}
                        </div>
                        <span className={styles.dreamCardTime}>{formatDreamTime(dream.created_at)}</span>
                      </div>
                    </div>
                    <h3 className={styles.dreamCardTitle}>{dream.title}</h3>
                    <p className={styles.dreamCardPreview}>{dream.content}</p>
                    <div className={styles.dreamCardTags}>
                      <span className={styles.emotionTag}>{meta.label}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      </div>

      {/* Mobile dream section */}
      <div className={`${styles.glassPanelLight} ${styles.mobileDreamSection}`}>
        <h3 className={styles.mobileDreamTitle}>{selectedDateDisplay} 的梦境</h3>
        {dreamsByDate.length === 0 ? (
          <p className={styles.noDreamsText}>这一天没有梦</p>
        ) : (
          dreamsByDate.map(dream => (
            <div
              key={dream.id}
              onClick={() => navigate(`/dream/${dream.id}`)}
              className={styles.mobileDreamItem}
            >
              <div
                className={styles.mobileEmotionBar}
                style={{ backgroundColor: EMOTION_META[dream.emotion].color }}
              />
              <div className={styles.mobileDreamInfo}>
                <div className={styles.mobileDreamItemTitle}>{dream.title}</div>
                <div className={styles.mobileDreamItemMeta}>
                  {EMOTION_META[dream.emotion].icon} {EMOTION_META[dream.emotion].label}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
