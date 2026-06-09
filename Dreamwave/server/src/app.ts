import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import dreamRoutes from './routes/dreams';
import adminRoutes from './routes/admin';
import tagRoutes from './routes/tags';
import aiRoutes from './routes/ai';

const app = express();

// 速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 100, // 每个IP最多100次请求
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试', code: 'RATE_LIMIT' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // 认证接口：开发环境放宽，生产环境可调回 10
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过多，请稍后再试', code: 'AUTH_RATE_LIMIT' },
});

// 中间件
app.use(helmet());
app.use(limiter);
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174').split(',');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 请求日志
app.use((req, _res, next) => {
  console.log(`[API] ${req.method} ${req.path}`);
  next();
});

// 路由
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/dreams', dreamRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'dreamwave', timestamp: new Date().toISOString() });
});

// 404处理
app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 错误处理
app.use(errorHandler);

export default app;
