# Phase 10 - バックアップ・性能改善・運用 詳細作業ログ

## 概要

Phase 9 までで全機能の実装が完了した。
Phase 10 ではデータの保護・性能の定量計測・改善・コンテナ化・CI を扱う。

- `mysqldump` によるバックアップ・リストア・ポイントインタイムリカバリを実習する
- 100万件データで性能のボトルネックを特定し `EXPLAIN ANALYZE` で改善前後を比較する
- N+1 問題・OFFSET ページング・SELECT * の問題を実測して修正する
- Dockerfile + docker-compose でアプリをコンテナ化し再現性のある実行環境を作る
- GitHub Actions でマイグレーション・テストを CI として自動化する

---

## 2. バックアップ

### 2-1. mysqldump フルバックアップ

```bash
# フルバックアップ（スキーマ＋データ）
mysqldump -u root -p \
  --single-transaction \      # InnoDB の一貫性スナップショット（テーブルロック不要）
  --flush-logs \              # バックアップ開始時点でバイナリログを切り替え
  --master-data=2 \           # ダンプ内にバイナリログ位置をコメントで記録
  market > backups/market_$(date +%Y%m%d_%H%M%S).sql

# 確認
ls -lh backups/
wc -l backups/market_*.sql
```

**オプションの意味**：

| オプション | 効果 |
|---|---|
| `--single-transaction` | `START TRANSACTION` でスナップショットを取得。InnoDB では運用中でも一貫したバックアップが取れる |
| `--flush-logs` | バックアップ時点でバイナリログを新しいファイルに切り替え。PITR の起点が明確になる |
| `--master-data=2` | ダンプ先頭に `-- CHANGE MASTER TO MASTER_LOG_FILE=..., MASTER_LOG_POS=...` がコメントとして入る。PITR の開始位置に使う |

---

### 2-2. バックアップスクリプト作成

`scripts/backup.sh` を作成：

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="$(dirname "$0")/../backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/market_${TIMESTAMP}.sql"
RETENTION_DAYS=7

mysqldump -u root -p"${DB_PASSWORD:-root}" \
  --single-transaction \
  --flush-logs \
  --master-data=2 \
  "${DB_NAME:-market}" > "$BACKUP_FILE"

# gzip 圧縮（容量削減）
gzip "$BACKUP_FILE"
echo "バックアップ完了: ${BACKUP_FILE}.gz ($(du -sh "${BACKUP_FILE}.gz" | cut -f1))"

# 古いバックアップを自動削除
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete
echo "保持日数(${RETENTION_DAYS}日)を超えたファイルを削除"
```

実行権限を付与して実行：

```bash
chmod +x scripts/backup.sh
./scripts/backup.sh
ls -lh backups/
```

---

### 2-3. リストア手順

```bash
# 1. リストア先 DB を再作成（本番ではここを慎重に行う）
mysql -u root -p -e "DROP DATABASE IF EXISTS market_restore; CREATE DATABASE market_restore CHARACTER SET utf8mb4;"

# 2. ダンプを展開してリストア
gunzip -c backups/market_YYYYMMDD_HHMMSS.sql.gz | mysql -u root -p market_restore

# 完了確認
mysql -u root -p market_restore -e "SHOW TABLES;"
mysql -u root -p market_restore -e "SELECT COUNT(*) FROM products;"
mysql -u root -p market_restore -e "SELECT COUNT(*) FROM orders;"
```

---

### 2-4. データ整合性確認

```bash
# テーブル件数を本番DBと比較
mysql -u root -p -e "
SELECT 'market(本番)' AS db, COUNT(*) AS products FROM market.products
UNION ALL
SELECT 'market_restore', COUNT(*) FROM market_restore.products;"

# 外部キー参照の孤立チェック（order_items の order_id に対応する orders が存在するか）
mysql -u root -p market_restore -e "
SELECT COUNT(*) AS orphan_order_items
FROM order_items oi
LEFT JOIN orders o ON o.id = oi.order_id
WHERE o.id IS NULL;"
# → 0 件なら整合性OK

# 注文履歴の整合性（購入者が実在するか）
mysql -u root -p market_restore -e "
SELECT COUNT(*) AS orphan_orders
FROM orders o
LEFT JOIN users u ON u.id = o.buyer_id
WHERE u.id IS NULL;"
```

整合性チェック結果を `docs/backup/restore_test_YYYYMMDD.md` に保存する：

```bash
mkdir -p docs/backup
mysql -u root -p market_restore -e "
SELECT 'users' AS tbl, COUNT(*) AS cnt FROM users
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'reviews', COUNT(*) FROM reviews;" > docs/backup/restore_test_$(date +%Y%m%d).md
```

---

### 2-5. バイナリログ・ポイントインタイムリカバリ（PITR）

PITR（Point-in-Time Recovery）：バックアップ取得後に発生した変更をバイナリログから再適用し、特定の時刻・位置まで復元する手法。

**バイナリログが有効か確認**：

```bash
mysql -u root -p -e "SHOW VARIABLES LIKE 'log_bin';"
# ON になっていれば有効
# OFF の場合: /etc/mysql/mysql.conf.d/mysqld.cnf に log_bin = /var/log/mysql/mysql-bin.log を追加
```

**現在のバイナリログファイルと位置を確認**：

```bash
mysql -u root -p -e "SHOW MASTER STATUS\G"
# File: mysql-bin.000003
# Position: 1024
```

**PITR 実習（バックアップ後に誤ってデータを削除し、削除直前まで復元する）**：

```bash
# Step 1: バックアップを取得
mysqldump -u root -p --single-transaction --flush-logs --master-data=2 \
  market > backups/pitr_test.sql

# Step 2: バックアップ後のバイナリログ開始位置を確認
head -30 backups/pitr_test.sql | grep "CHANGE MASTER"
# -- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000004', MASTER_LOG_POS=156;

# Step 3: 誤削除をシミュレート（削除直前の時刻を記録）
DATE_BEFORE=$(date +"%Y-%m-%d %H:%M:%S")
mysql -u root -p market -e "DELETE FROM products WHERE id > 1000;"
mysql -u root -p market -e "SELECT COUNT(*) FROM products;"  # 減った件数を確認

# Step 4: DBを復元
mysql -u root -p -e "DROP DATABASE market; CREATE DATABASE market CHARACTER SET utf8mb4;"
mysql -u root -p market < backups/pitr_test.sql

# Step 5: バックアップ取得後〜削除直前までのバイナリログを再適用
mysqlbinlog \
  --start-position=156 \           # バックアップ時点のバイナリログ位置
  --stop-datetime="$DATE_BEFORE" \ # 削除直前の時刻まで
  /var/log/mysql/mysql-bin.000004 | mysql -u root -p market

# Step 6: 復元確認
mysql -u root -p market -e "SELECT COUNT(*) FROM products;"  # 元の件数に戻っているはず
```

---

## 3. 大量データ生成（100万件）

### 3-1. 商品100万件シードスクリプト

`seeds/seed_large.ts` を作成：

```typescript
import 'dotenv/config';
import { pool } from '../src/db/connection.js';

const PRODUCT_TOTAL = 1_000_000;
const ORDER_TOTAL = 100_000;
const BATCH_SIZE = 1_000;

console.log('=== 大量データ生成開始 ===');

// --- 商品 100万件 ---
console.log(`商品 ${PRODUCT_TOTAL.toLocaleString()} 件を生成中...`);
const productStart = Date.now();

for (let batch = 0; batch < PRODUCT_TOTAL / BATCH_SIZE; batch++) {
  const values = Array.from({ length: BATCH_SIZE }, (_, j) => {
    const n = batch * BATCH_SIZE + j + 1;
    const sid = (n % 100) + 1;       // seller_id: 1-100
    const cid = (n % 10) + 1;       // category_id: 1-10
    const price = (n % 50_000) + 100; // price: 100-50100
    const stock = n % 100;            // stock: 0-99
    return `(${sid},${cid},'大量商品_${n}','説明_${n}',${price},${stock},'published')`;
  }).join(',');

  await pool.query(
    `INSERT INTO products (seller_id,category_id,name,description,price,stock,status) VALUES ${values}`
  );

  if (batch % 100 === 0) {
    const elapsed = ((Date.now() - productStart) / 1000).toFixed(1);
    console.log(`  ${((batch + 1) * BATCH_SIZE).toLocaleString()} / ${PRODUCT_TOTAL.toLocaleString()} (${elapsed}s)`);
  }
}
console.log(`商品生成完了: ${((Date.now() - productStart) / 1000).toFixed(1)}秒`);

// --- 注文 10万件 ---
console.log(`注文 ${ORDER_TOTAL.toLocaleString()} 件を生成中...`);
const orderStart = Date.now();
const statuses = ['pending','paid','preparing','shipped','delivered','completed'] as const;

for (let batch = 0; batch < ORDER_TOTAL / BATCH_SIZE; batch++) {
  const orderValues = Array.from({ length: BATCH_SIZE }, (_, j) => {
    const n = batch * BATCH_SIZE + j + 1;
    const buyerId = (n % 100) + 1;
    const status = statuses[n % statuses.length];
    const subtotal = (n % 10_000) + 500;
    const shipping = 500;
    return `(${buyerId},'${status}',${subtotal},${shipping},${subtotal + shipping})`;
  }).join(',');

  const [result] = await pool.query(
    `INSERT INTO orders (buyer_id,status,subtotal,shipping_fee,total_amount) VALUES ${orderValues}`
  ) as any[];

  const firstOrderId = (result as any).insertId;

  // 各注文に order_items を 1 件付ける
  const itemValues = Array.from({ length: BATCH_SIZE }, (_, j) => {
    const n = batch * BATCH_SIZE + j + 1;
    const orderId = firstOrderId + j;
    const productId = (n % 1_000_000) + 1;
    const sellerId = (productId % 100) + 1;
    const price = (n % 10_000) + 500;
    return `(${orderId},${productId},${sellerId},'商品_${productId}',${price},1,${price})`;
  }).join(',');

  await pool.query(
    `INSERT INTO order_items (order_id,product_id,seller_id,product_name,unit_price,quantity,subtotal) VALUES ${itemValues}`
  );

  if (batch % 100 === 0) {
    console.log(`  ${((batch + 1) * BATCH_SIZE).toLocaleString()} / ${ORDER_TOTAL.toLocaleString()}`);
  }
}
console.log(`注文生成完了: ${((Date.now() - orderStart) / 1000).toFixed(1)}秒`);

await pool.end();
console.log('=== 完了 ===');
```

実行（完了まで数分かかる）：

```bash
npx tsx seeds/seed_large.ts
```

件数確認：

```bash
mysql market -e "
SELECT 'products' AS tbl, COUNT(*) AS cnt FROM products
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items;"
```

---

## 4. slow query log（スロークエリログ）

### 4-1. 有効化・閾値設定

MySQL 設定ファイル（`/etc/mysql/mysql.conf.d/mysqld.cnf` または `my.cnf`）に追記：

```ini
[mysqld]
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 1                   # 1秒以上かかったクエリを記録
log_queries_not_using_indexes = 1     # インデックスを使わないクエリも記録（0件でも）
```

または MySQL コンソールで動的に変更（再起動不要）：

```bash
mysql -u root -p -e "
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 1;
SET GLOBAL log_queries_not_using_indexes = ON;"

# 設定確認
mysql -u root -p -e "SHOW VARIABLES LIKE 'slow%'; SHOW VARIABLES LIKE 'long_query_time';"
```

---

### 4-2. ログ確認・解析

スロークエリを意図的に発生させる：

```bash
# インデックスなしのカラムで検索（フルスキャン）
mysql market -e "SELECT * FROM orders WHERE total_amount > 10000;"

# ログ確認
sudo tail -50 /var/log/mysql/slow.log
```

`mysqldumpslow` で集計：

```bash
# 実行時間の長い順に上位10件
sudo mysqldumpslow -s t -t 10 /var/log/mysql/slow.log

# クエリ頻度の多い順に上位10件
sudo mysqldumpslow -s c -t 10 /var/log/mysql/slow.log
```

出力例の読み方：

```
Count: 15   Time=2.34s (35s)  Lock=0.00s (0s)  Rows=1000000 (15000000)
SELECT * FROM orders WHERE total_amount > N
```

- `Count: 15` → 同じクエリが 15 回実行された
- `Time=2.34s` → 平均 2.34 秒
- `Rows=1000000` → 平均 100 万行スキャン（インデックス未使用の証拠）

---

## 5. EXPLAIN ANALYZE（詳細実行計画）

### 5-1. EXPLAIN vs EXPLAIN ANALYZE の違い

| コマンド | 実際にクエリ実行 | 得られる情報 |
|---|---|---|
| `EXPLAIN` | しない（推定） | 推定行数・インデックス使用有無・結合順序 |
| `EXPLAIN ANALYZE` | する（実測） | 実際の実行時間・実際の行数・ループ回数（MySQL 8.0.18+） |

`EXPLAIN ANALYZE` は実際に実行するため、SELECT 系クエリで使う（UPDATE/DELETE には使わない）。

---

### 5-2. 商品検索の計測

```bash
mkdir -p docs/performance
```

**改善前（インデックスなし状態を想定）**：

```sql
-- インデックスを一時的に無効化してフルスキャンを確認（学習目的）
EXPLAIN ANALYZE
SELECT id, name, price, stock, created_at
FROM products
WHERE status = 'published'
  AND category_id = 3
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
```

出力例：

```
-> Limit: 20 row(s)  (actual time=4231..4231 rows=20 loops=1)
    -> Sort: products.created_at DESC  (actual time=4230..4230 rows=20 loops=1)
        -> Filter: ((products.status = 'published') and (products.category_id = 3))
             (actual time=0.052..3980 rows=99800 loops=1)
            -> Table scan on products  (actual time=0.040..2100 rows=1000000 loops=1)
```

`Table scan on products` → フルスキャン。1,000,000 行を読んでいる。

**インデックス追加（Phase 4 で実施済みだが、大量データで効果を再確認）**：

```sql
-- 既にある場合はスキップ
CREATE INDEX IF NOT EXISTS idx_products_status_category_created
  ON products (status, category_id, created_at DESC);
```

**改善後**：

```sql
EXPLAIN ANALYZE
SELECT id, name, price, stock, created_at
FROM products
WHERE status = 'published'
  AND category_id = 3
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
```

出力例：

```
-> Limit: 20 row(s)  (actual time=0.31..0.32 rows=20 loops=1)
    -> Index range scan on products using idx_products_status_category_created
         (actual time=0.10..0.30 rows=20 loops=1)
```

`Index range scan` → インデックスで 20 行だけ読んで終わり。4231ms → 0.32ms。

計測結果を `docs/performance/01_product_search.md` に保存する（フォーマット例は 7 節参照）。

---

### 5-3. 売上ランキングの計測

```sql
-- 集計テーブルなしの場合（直接 orders + order_items を集計）
EXPLAIN ANALYZE
SELECT
  oi.seller_id,
  DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
  SUM(oi.subtotal) AS monthly_sales,
  RANK() OVER (
    PARTITION BY DATE_FORMAT(o.created_at, '%Y-%m')
    ORDER BY SUM(oi.subtotal) DESC
  ) AS rank
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status IN ('completed','shipped','delivered')
GROUP BY oi.seller_id, order_month
ORDER BY order_month DESC, rank
LIMIT 10;
```

計測結果を `docs/performance/05_sales_ranking.md` に保存。

---

### 5-4. 購入履歴の計測

```sql
EXPLAIN ANALYZE
SELECT o.id, o.status, o.total_amount, o.created_at,
       oi.product_name, oi.unit_price, oi.quantity
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.buyer_id = 1
ORDER BY o.created_at DESC
LIMIT 20 OFFSET 0;
```

---

## 6. 性能改善

### 6-1. SELECT * → 必要カラムのみ

**計測**：

```bash
# SELECT * の実行時間
time mysql market -e "SELECT * FROM products WHERE status = 'published' LIMIT 1000;" > /dev/null

# 必要カラムのみの実行時間
time mysql market -e "SELECT id, name, price, status, created_at FROM products WHERE status = 'published' LIMIT 1000;" > /dev/null
```

**EXPLAIN で比較**：

```sql
-- SELECT * は description（TEXT型）を含むためデータ転送量が大きい
EXPLAIN SELECT * FROM products WHERE status = 'published' LIMIT 1000;
EXPLAIN SELECT id, name, price, status, created_at FROM products WHERE status = 'published' LIMIT 1000;
-- Extra: "Using index" は SELECT * では出ない（インデックス外のカラムを読むため）
```

**コード修正**：`src/repositories/productRepository.ts` の `findAll` クエリで `SELECT *` を使っている箇所を必要カラム列挙に変更する：

```typescript
// Before
const [rows] = await pool.query(
  `SELECT * FROM products WHERE status = ? LIMIT ? OFFSET ?`,
  [status, limit, offset]
);

// After
const [rows] = await pool.query(
  `SELECT id, seller_id, category_id, name, price, stock, status, created_at, updated_at
   FROM products WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  [status, limit, offset]
);
```

---

### 6-2. OFFSET ページング → カーソルページング（比較）

**OFFSET ページングの問題**：

```sql
-- 100万件の products で後半ページを取得する場合
-- OFFSET 0 → 高速
EXPLAIN ANALYZE SELECT id, name, price FROM products WHERE status = 'published' ORDER BY created_at DESC LIMIT 20 OFFSET 0;

-- OFFSET 999980 → 99万9980件スキャンしてから 20 件取得（遅い）
EXPLAIN ANALYZE SELECT id, name, price FROM products WHERE status = 'published' ORDER BY created_at DESC LIMIT 20 OFFSET 999980;
```

**カーソルページングと比較**：

```sql
-- 前回の最後の created_at と id を next_cursor として使う
-- WHERE (created_at, id) < (prev_created_at, prev_id) で絞り込み
EXPLAIN ANALYZE
SELECT id, name, price, created_at
FROM products
WHERE status = 'published'
  AND (created_at, id) < ('2025-01-01 00:00:00', 500001)
ORDER BY created_at DESC, id DESC
LIMIT 20;
-- インデックスを使えば常に O(1) に近い
```

計測結果を `docs/performance/02_pagination_comparison.md` に保存。

---

### 6-3. サブクエリ → JOIN への書き換え比較

```sql
-- サブクエリ版（スカラーサブクエリ：行ごとに実行）
EXPLAIN ANALYZE
SELECT
  o.id,
  o.total_amount,
  (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
FROM orders o
WHERE o.buyer_id = 1
ORDER BY o.created_at DESC
LIMIT 20;

-- JOIN版（一度の結合で集計）
EXPLAIN ANALYZE
SELECT
  o.id,
  o.total_amount,
  COUNT(oi.id) AS item_count
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.buyer_id = 1
GROUP BY o.id, o.total_amount
ORDER BY o.created_at DESC
LIMIT 20;
```

MySQL 8.x のオプティマイザはスカラーサブクエリを自動で JOIN に変換する場合があるが、`EXPLAIN ANALYZE` で `actual time` を比較して確認する。

---

### 6-4. 集計テーブル導入前後の比較

**Phase 9 で実装した `daily_sales_summary` の効果を測定する**：

```bash
# 集計テーブルなし（orders を直接 GROUP BY）
time mysql market -e "
SELECT DATE(created_at) AS day, SUM(total_amount) AS sales, COUNT(*) AS cnt
FROM orders
WHERE status IN ('completed','shipped','delivered')
  AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY day
ORDER BY day DESC;" > /dev/null

# 集計テーブルあり（daily_sales_summary から取得）
time mysql market -e "
SELECT summary_date, total_sales, order_count
FROM daily_sales_summary
WHERE summary_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
ORDER BY summary_date DESC;" > /dev/null
```

計測結果を `docs/performance/06_aggregation_table_comparison.md` に保存。

---

### 6-5. カバリングインデックス

**カバリングインデックスとは**：クエリの `WHERE` / `ORDER BY` / `SELECT` に必要なカラムをすべてインデックスに含めることで、テーブル本体（clustered index）を一切読まずにインデックスだけでクエリを完結させる技術。`EXPLAIN` の `Extra` 列に `Using index` と表示される。

`migrations/023_add_covering_indexes.sql` を作成：

```sql
-- GET /me/products 用カバリングインデックス
-- クエリ: SELECT id, name, price, status, created_at FROM products
--          WHERE seller_id = ? AND status != 'archived'
--          ORDER BY created_at DESC
CREATE INDEX idx_products_seller_covering
  ON products (seller_id, status, created_at DESC, id, name, price);

-- 購入履歴一覧用
-- クエリ: SELECT id, status, total_amount, created_at FROM orders
--          WHERE buyer_id = ? ORDER BY created_at DESC
CREATE INDEX idx_orders_buyer_covering
  ON orders (buyer_id, created_at DESC, id, status, total_amount);
```

実行：

```bash
mysql market < migrations/023_add_covering_indexes.sql
```

効果確認：

```sql
EXPLAIN
SELECT id, name, price, status, created_at
FROM products
WHERE seller_id = 1 AND status != 'archived'
ORDER BY created_at DESC;
-- Extra: Using index → テーブルアクセスなしで完結
```

---

### 6-6. N+1 問題の解消（GET /me/products）

**N+1 問題とは**：1 件の一覧クエリの後、各行に対して N 回のクエリを発行するパターン。商品 100 件の一覧を取得して各商品の画像を 1 件ずつ取得すると 1 + 100 = 101 クエリになる。

**現状の実装（N+1）**：

```typescript
// src/services/productService.ts（Phase 3 時点の実装）
async getMyProducts(sellerId: number) {
  const products = await productRepository.findBySellerId(sellerId);

  // 商品ごとに画像を 1 件ずつ取得 → DBラウンドトリップが N 回発生
  return Promise.all(
    products.map(async p => ({
      ...p,
      images: await productImageRepository.findByProductId(p.id),
    }))
  );
}
```

**修正後（バッチ取得）**：

まず `src/repositories/productImageRepository.ts` に `findByProductIds` を追加：

```typescript
// findByProductId（既存）は1件用。findByProductIds（新規）は複数件用
async findByProductIds(productIds: number[]): Promise<ProductImage[]> {
  if (productIds.length === 0) return [];
  const placeholders = productIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT id, product_id, url, position
     FROM product_images
     WHERE product_id IN (${placeholders})
     ORDER BY product_id, position`,
    productIds
  ) as any[];
  return rows as ProductImage[];
},
```

`src/services/productService.ts` の `getMyProducts` を修正：

```typescript
async getMyProducts(sellerId: number) {
  const products = await productRepository.findBySellerId(sellerId);

  // 全商品のIDをまとめて取得（クエリ 1 回）
  const productIds = products.map(p => p.id);
  const allImages = await productImageRepository.findByProductIds(productIds);

  // product_id をキーに Map を作成
  const imageMap = new Map<number, ProductImage[]>();
  for (const img of allImages) {
    const list = imageMap.get(img.product_id) ?? [];
    list.push(img);
    imageMap.set(img.product_id, list);
  }

  // クエリは計 2 回（findBySellerId + findByProductIds）
  return products.map(p => ({
    ...p,
    images: imageMap.get(p.id) ?? [],
  }));
},
```

**計測で確認**：

```bash
# slow query log の General log を使ってクエリ数を確認
mysql market -e "SET GLOBAL general_log = ON; SET GLOBAL general_log_file = '/tmp/general.log';"

# N+1 版のエンドポイントを呼ぶ
curl http://localhost:3000/api/v1/me/products -H "Authorization: Bearer $SELLER_TOKEN"

# ログでクエリ数を確認
grep -c "SELECT" /tmp/general.log

# バッチ版に切り替えて再計測（2 クエリになるはず）
mysql market -e "SET GLOBAL general_log = OFF;"
```

---

## 7. 計測結果の記録

`docs/performance/` 配下に各計測結果を保存する。

```bash
mkdir -p docs/performance
```

各ファイルのフォーマット（例：`docs/performance/01_product_search.md`）：

```markdown
# 商品検索 性能計測

## 環境
- MySQL 8.4
- 商品数: 1,000,000 件
- 計測日: 2025-09-19

## クエリ
```sql
SELECT id, name, price, stock, created_at
FROM products
WHERE status = 'published' AND category_id = 3
ORDER BY created_at DESC
LIMIT 20;
```

## 計測結果

| 状態 | type | key | rows | actual time |
|---|---|---|---|---|
| インデックスなし | ALL | NULL | 1,000,000 | 4,231ms |
| インデックスあり | range | idx_products_status_category_created | 20 | 0.32ms |

## 改善率: 13,200 倍

## インデックス定義
```sql
CREATE INDEX idx_products_status_category_created
  ON products (status, category_id, created_at DESC);
```
```

```bash
# 全計測ファイルの一覧
ls docs/performance/
# 01_product_search.md
# 02_pagination_comparison.md
# 03_order_history.md
# 04_n_plus_one.md
# 05_sales_ranking.md
# 06_aggregation_table_comparison.md
```

---

## 8. コンテナ化（Docker）

### 8-1. Dockerfile

プロジェクトルートに `Dockerfile` を作成：

```dockerfile
# ビルドステージ
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 実行ステージ（開発依存を除外して軽量化）
FROM node:22-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
EXPOSE 3000
CMD ["node", "dist/app.js"]
```

`package.json` に `build` スクリプトが必要：

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/app.js",
    "dev": "npx tsx src/app.ts",
    "test": "vitest run"
  }
}
```

`.dockerignore` を作成：

```
node_modules
dist
backups
seeds
*.log
.env
.env.*
```

---

### 8-2. docker-compose.yml

```yaml
services:
  db:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: market
      MYSQL_CHARACTER_SET_SERVER: utf8mb4
      MYSQL_COLLATION_SERVER: utf8mb4_unicode_ci
    ports:
      - "3306:3306"
    volumes:
      - db_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-proot"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  migrate:
    image: mysql:8.4
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./migrations:/migrations
    environment:
      MYSQL_PWD: root
    command: >
      sh -c "for f in /migrations/*.sql; do
               echo \"Running $$f...\";
               mysql -h db -u root market < $$f;
             done && echo 'All migrations done'"
    restart: "no"

  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      DB_HOST: db
      DB_PORT: "3306"
      DB_USER: root
      DB_PASSWORD: root
      DB_NAME: market
      JWT_SECRET: changeme_in_production
      NODE_ENV: production
    depends_on:
      migrate:
        condition: service_completed_successfully

volumes:
  db_data:
```

---

### 8-3. 動作確認

```bash
# コンテナビルドと起動
docker compose up --build

# 別ターミナルで動作確認
curl http://localhost:3000/api/v1/products

# ログ確認
docker compose logs api
docker compose logs db

# コンテナ停止（DB データは volumes に保持される）
docker compose down

# DB データも含めて完全削除
docker compose down -v
```

**マルチステージビルドの効果確認**：

```bash
# イメージサイズ比較
docker images | grep market-api

# builder ステージのみのサイズ（node_modules 込み）vs runner ステージのサイズ
docker build --target builder -t market-api:builder .
docker build --target runner -t market-api:runner .
docker images | grep market-api
```

---

## 9. GitHub Actions CI

### 9-1. マイグレーション + テスト自動実行

`.github/workflows/ci.yml` を作成：

```bash
mkdir -p .github/workflows
```

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      mysql:
        image: mysql:8.4
        env:
          MYSQL_ROOT_PASSWORD: root
          MYSQL_DATABASE: market_test
          MYSQL_CHARACTER_SET_SERVER: utf8mb4
        ports:
          - 3306:3306
        options: >-
          --health-cmd="mysqladmin ping -u root -proot"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=10

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run migrations
        run: |
          for f in migrations/*.sql; do
            echo "Running $f..."
            mysql -h 127.0.0.1 -P 3306 -u root -proot market_test < "$f"
          done

      - name: Run tests
        env:
          DB_HOST: 127.0.0.1
          DB_PORT: 3306
          DB_USER: root
          DB_PASSWORD: root
          DB_NAME: market_test
          JWT_SECRET: test_secret
          NODE_ENV: test
        run: npm test

      - name: Type check
        run: npx tsc --noEmit
```

---

### 9-2. テスト用の DB 設定切り替え

テスト環境では本番DBを汚さないよう、`DB_NAME` 環境変数でDB名を切り替える。

`src/db/connection.ts` が環境変数を読んでいることを確認：

```typescript
import mysql from 'mysql2/promise';
import 'dotenv/config';

export const pool = mysql.createPool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'market',
  waitForConnections: true,
  connectionLimit: 10,
});
```

テスト実行時に `.env.test` を読ませる場合は `vitest.config.ts` に設定：

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DB_NAME: 'market_test',
      // .env.test が存在する場合は dotenv で読む
    },
  },
});
```

---

## 10. 環境変数管理

`.env.example` を作成（実際の値は含めず、必要なキーのみ列挙）：

```bash
# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=market

# Auth
JWT_SECRET=change_me_to_a_random_string_at_least_32_chars
JWT_EXPIRES_IN=7d

# App
PORT=3000
NODE_ENV=development
```

環境ごとのファイル管理：

```
.env              # ローカル開発（.gitignore に追加済み）
.env.example      # Git 管理（実際の値なし）
.env.test         # テスト環境（.gitignore に追加済み）
```

`.gitignore` に追記：

```
.env
.env.*
!.env.example
```

---

## 11. Flutter 環境切り替え

本番 URL と開発 URL を環境ごとに切り替える。

`lib/core/config/app_config.dart` を作成：

```dart
enum AppEnv { development, production }

class AppConfig {
  static AppEnv env = AppEnv.development;

  static String get baseUrl {
    switch (env) {
      case AppEnv.development:
        return 'http://localhost:3000/api/v1';
      case AppEnv.production:
        return 'https://api.market.example.com/api/v1';
    }
  }
}
```

`lib/core/api/dio_client.dart` で使用：

```dart
final dio = Dio(BaseOptions(
  baseUrl: AppConfig.baseUrl,
  connectTimeout: const Duration(seconds: 10),
  receiveTimeout: const Duration(seconds: 10),
));
```

Flutter のビルド時に環境を切り替える：

```bash
# 開発ビルド
flutter run --dart-define=ENV=development

# 本番ビルド
flutter build apk --dart-define=ENV=production
```

```dart
// main.dart
void main() {
  const env = String.fromEnvironment('ENV', defaultValue: 'development');
  AppConfig.env = env == 'production' ? AppEnv.production : AppEnv.development;
  runApp(const MyApp());
}
```

---

## 確認チェックリスト

Phase 10 完了の判断基準：

```
[ ] mysqldump でバックアップが取得でき、ファイルサイズが妥当か確認した
[ ] scripts/backup.sh を実行してバックアップが自動化できた
[ ] バックアップから market_restore DB にリストアし、件数が一致した
[ ] 外部キー孤立チェック SQL を実行して 0 件（整合性OK）を確認した
[ ] バイナリログが有効な状態で PITR を実習し、削除直前まで復元できた
[ ] seeds/seed_large.ts を実行して商品100万件・注文10万件を生成した
[ ] slow query log を有効化し、フルスキャンクエリがログに記録されることを確認した
[ ] mysqldumpslow で頻出スロークエリを特定できた
[ ] EXPLAIN と EXPLAIN ANALYZE の出力の違いを確認した
[ ] 商品検索で インデックス前後の actual time を EXPLAIN ANALYZE で比較・記録した
[ ] SELECT * と必要カラムのみで実行時間を比較した
[ ] OFFSET 0 と OFFSET 999980 で実行時間の差を測定した
[ ] カーソルページングと OFFSET ページングの性能差を計測した
[ ] サブクエリ版と JOIN 版のクエリを EXPLAIN ANALYZE で比較した
[ ] daily_sales_summary 使用前後の管理ダッシュボードレスポンス時間を計測した
[ ] migrations/023 のカバリングインデックス追加後に EXPLAIN で Using index を確認した
[ ] GET /me/products の N+1 を修正し、クエリ数が N+1 → 2 に減ったことを確認した
[ ] docs/performance/ に計測結果 Markdown を保存した
[ ] docker compose up --build でコンテナが起動し、API が疎通した
[ ] docker compose down -v 後に再起動してマイグレーションが再実行されることを確認した
[ ] .github/workflows/ci.yml を push して GitHub Actions が通った
[ ] CI ログでマイグレーション実行 → テスト通過 → 型チェック通過を確認した
[ ] .env.example に必要な全キーが記載されている
[ ] .env が .gitignore に含まれており、git status に表示されないことを確認した
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|---|---|
| `--single-transaction` の意味 | InnoDB の MVCC スナップショットを使ってバックアップ開始時点の一貫した状態を取得する。MyISAM は使えない |
| PITR の仕組み | フルバックアップ（特定時点の状態）＋バイナリログ（それ以降の変更履歴）の組み合わせで任意の時点に復元できる |
| `EXPLAIN ANALYZE` の `actual time` | `X..Y` の `X` が最初の行を返すまでの時間、`Y` が全行を返し終えるまでの時間（単位 ms） |
| `Using index`（カバリングインデックス）の意味 | テーブル本体を読まずインデックスだけでクエリが完結している状態。I/O が大幅に減る |
| N+1 問題が起きる条件 | ORM や手書きコードで「1 件の一覧 + N 件の詳細」を別クエリで取る場合に発生。`IN (...)` のバッチ取得か `JOIN` で 1〜2 クエリに抑える |
| OFFSET ページングがスケールしない理由 | MySQL は `OFFSET n` の行を読み飛ばせず先頭からスキャンする。100 万行目は 100 万行スキャン後にようやく取得できる |
| カーソルページングの前提 | `WHERE (created_at, id) < (prev_created_at, prev_id)` の複合条件が使える。複合インデックスが必要。前ページへの戻りは実装が複雑になる |
| マルチステージビルド | ビルド時の依存（TypeScript コンパイラ等）を最終イメージに含めない。`node_modules` の devDependencies を除外してイメージを軽量化できる |
| `service_healthy` / `service_completed_successfully` | docker-compose の `depends_on` 条件。`healthy` はヘルスチェック通過、`completed_successfully` は終了コード 0 で完了 |
| CI でのテスト DB 分離 | テストは本番 DB を汚さないよう専用 DB（`market_test`）を使う。GitHub Actions の `services` でコンテナを立ち上げ環境変数で切り替える |
