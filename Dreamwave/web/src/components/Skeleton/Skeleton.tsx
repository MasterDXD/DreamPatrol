import styles from './Skeleton.module.css';

interface DreamCardSkeletonProps {
  count?: number;
}

export default function DreamCardSkeleton({ count = 3 }: DreamCardSkeletonProps) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.skeleton}>
          <div className={styles.bar} />
          <div className={styles.content}>
            <div className={`${styles.line} ${styles.titleLine}`} />
            <div className={`${styles.line} ${styles.previewLine1}`} />
            <div className={`${styles.line} ${styles.previewLine2}`} />
            <div className={`${styles.line} ${styles.metaLine}`} />
          </div>
        </div>
      ))}
    </>
  );
}
