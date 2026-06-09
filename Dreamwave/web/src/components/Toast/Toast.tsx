import { useEffect, useRef } from 'react';
import styles from './Toast.module.css';

export type ToastType = 'success' | 'error' | 'info';

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
}

/* 独立Toast组件，支持success/error/info类型，自动消失 */
export default function Toast({ message, type = 'info', duration = 3000, onClose }: ToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(onClose, duration);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [duration, onClose]);

  const typeClass = styles[type] || styles.info;

  return (
    <div className={`${styles.toast} ${typeClass}`}>
      {message}
    </div>
  );
}
