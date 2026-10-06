import 'dotenv/config';
import { pool } from '../src/db/connection.js';

const TOTAL      = 100_000;
const BATCH      = 1_000;
const SELLER_ID  = 1; // Phase 2 でシード済みのユーザー

const CATEGORY_IDS = [1, 2, 3];
const STATUSES     = ['published', 'published', 'published', 'draft', 'archived'] as const;

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const startTime = Date.now();
console.log(`[${new Date().toISOString()}] 開始: ${TOTAL} 件を ${BATCH} 件ずつ挿入中...`);

// 行ごとに1分ずつずらす（行0が最古、行99999が最新）
// 100000行 = 約69日のタイムラインに分散
const baseTime = new Date();
const MS_PER_MINUTE = 60 * 1_000;

for (let i = 0; i < TOTAL; i += BATCH) {
  const rows: unknown[][] = [];
  for (let j = 0; j < BATCH && i + j < TOTAL; j++) {
    const rowIndex   = i + j;
    const n          = rowIndex + 21;
    const categoryId = CATEGORY_IDS[rand(0, CATEGORY_IDS.length - 1)];
    const status     = STATUSES[rand(0, STATUSES.length - 1)];
    const price      = rand(100, 300_000);
    const stock      = rand(0, 100);
    const createdAt  = new Date(baseTime.getTime() - (TOTAL - 1 - rowIndex) * MS_PER_MINUTE).toISOString().slice(0, 19).replace('T', ' ');
    rows.push([
      SELLER_ID,
      categoryId,
      `テスト商品${n}`,
      `${n} 番目の商品説明文。開発・計測用のサンプルデータです。`,
      price,
      stock,
      status,
      createdAt,
    ]);
  }
  await pool.query(
    `INSERT INTO products (seller_id, category_id, name, description, price, stock, status, created_at) VALUES ?`,
    [rows]
  );
  process.stdout.write(`\r${Math.min(i + BATCH, TOTAL)} / ${TOTAL} 件完了`);
}

const elapsedMs = Date.now() - startTime;
const elapsedSec = (elapsedMs / 1000).toFixed(2);
console.log(`\n[${new Date().toISOString()}] 完了: ${elapsedSec} 秒 (${elapsedMs} ms)`);

await pool.end();
