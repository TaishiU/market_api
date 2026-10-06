import express from 'express';
import 'dotenv/config';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import productRoutes from './routes/productRoutes.js';
import devRoutes from './routes/devRoutes.js';
import { errorHandler } from './middlewares/errorHandler.js';

if(!process.env.JWT_SECRET) throw new Error('環境変数 JWT_SECRET が設定されていません');

const app = express();
const PORT = process.env.PORT;

app.use(express.json());

if (process.env.NODE_ENV !== 'production') {
  app.use('/dev', devRoutes);
}

// ルーター登録
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', userRoutes);
app.use('/api/v1/products', productRoutes);

// エラーハンドラーは必ず最後に登録
app.use(errorHandler);

// "npm run dev" でサーバー起動
app.listen(PORT, ()=> {
    console.log(`Server running on http://localhost:${PORT}`);
});