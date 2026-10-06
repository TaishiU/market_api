# Phase 9 - 管理画面・分析 詳細作業ログ

## 概要

Phase 8 で注文の状態遷移・レビューを実装した。
Phase 9 では売上分析 SQL・集計テーブル・管理画面 API・通知機能を追加する。

- `GROUP BY` / `HAVING` / サブクエリ / CTE（共通テーブル式）を段階的に学ぶ
- ウィンドウ関数（`RANK` / `DENSE_RANK` / `SUM OVER`）で売上ランキングを集計する
- `daily_sales_summary` 集計テーブルをバッチで更新しダッシュボードに使う
- 管理者ロールチェック Middleware を実装する
- 通知テーブルを追加し、注文状態変更時に通知を生成する

---

## 2. SQL 実践（mysql コンソールで確認）

実装前に SQL 構文を理解するため、まず mysql コンソールで直接実行して結果を確認する。

### 2-1. GROUP BY + SUM（月別売上集計）

```sql
-- 月別の売上合計・注文件数
SELECT
  DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
  COUNT(DISTINCT o.id) AS order_count,
  SUM(o.total_amount) AS total_sales
FROM orders o
WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
GROUP BY order_month
ORDER BY order_month DESC;
```

```bash
mysql market -e "
SELECT DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
       COUNT(DISTINCT o.id) AS order_count,
       SUM(o.total_amount) AS total_sales
FROM orders o
WHERE o.status IN ('completed','shipped','delivered','paid','preparing')
GROUP BY order_month
ORDER BY order_month DESC;"
```

**`GROUP BY` の仕組み**：`SELECT` に集計関数（`SUM` / `COUNT` / `AVG`）と非集計列が混在する場合、非集計列をすべて `GROUP BY` に列挙する必要がある。`DATE_FORMAT(o.created_at, '%Y-%m')` は日時を `'2025-09'` 形式の文字列に変換する MySQL 関数。

---

### 2-2. HAVING（条件付きグループ絞り込み）

```sql
-- 売上 5 万円以上の月のみ
SELECT
  DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
  SUM(o.total_amount) AS total_sales
FROM orders o
WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
GROUP BY order_month
HAVING total_sales >= 50000
ORDER BY total_sales DESC;
```

**`WHERE` vs `HAVING`**：

| 句 | 適用タイミング | 対象 |
|---|---|---|
| `WHERE` | GROUP BY の前 | 個々の行 |
| `HAVING` | GROUP BY の後 | 集計結果 |

`WHERE total_sales >= 50000` と書いてもエラーになる。`total_sales` は集計後の値であり、行レベルには存在しないため `HAVING` が必要。

---

### 2-3. サブクエリ（平均以上の売上月）

```sql
-- 月別売上が全月平均を上回る月
SELECT
  order_month,
  total_sales
FROM (
  SELECT
    DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
    SUM(o.total_amount) AS total_sales
  FROM orders o
  WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
  GROUP BY order_month
) AS monthly
WHERE total_sales > (
  SELECT AVG(sub.total_sales)
  FROM (
    SELECT SUM(o2.total_amount) AS total_sales
    FROM orders o2
    WHERE o2.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
    GROUP BY DATE_FORMAT(o2.created_at, '%Y-%m')
  ) AS sub
)
ORDER BY total_sales DESC;
```

**サブクエリの種類**：

| 種類 | 位置 | 例 |
|---|---|---|
| インラインビュー | `FROM` 句 | `FROM (SELECT ...) AS alias` |
| スカラーサブクエリ | `WHERE` 句 | `WHERE x > (SELECT AVG(...))` |
| 相関サブクエリ | `WHERE` 句（外側の行を参照） | `WHERE EXISTS (SELECT 1 FROM ... WHERE t.id = outer.id)` |

サブクエリはCTEで書き直すとより読みやすくなる（2-4 参照）。

---

### 2-4. CTE（複数段階集計）

**CTE（Common Table Expression）**：`WITH` 句で一時的な名前付き結果セットを定義し、後続のクエリから参照する。サブクエリと同等だが可読性が高い。

```sql
-- 2-3 のサブクエリをCTEで書き直す
WITH monthly_sales AS (
  SELECT
    DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
    SUM(o.total_amount) AS total_sales
  FROM orders o
  WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
  GROUP BY order_month
),
avg_sales AS (
  SELECT AVG(total_sales) AS avg_monthly
  FROM monthly_sales
)
SELECT
  ms.order_month,
  ms.total_sales,
  ROUND(ms.total_sales / as2.avg_monthly * 100, 1) AS pct_of_avg
FROM monthly_sales ms
CROSS JOIN avg_sales as2
WHERE ms.total_sales > as2.avg_monthly
ORDER BY ms.total_sales DESC;
```

**CTEを複数定義する**：

```sql
-- 出品者月別売上 → ランキング → 上位3位まで絞り込みの3段階CTE
WITH monthly AS (
  SELECT
    oi.seller_id,
    DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
    SUM(oi.subtotal) AS sales
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
  GROUP BY oi.seller_id, order_month
),
ranked AS (
  SELECT
    seller_id,
    order_month,
    sales,
    RANK() OVER (PARTITION BY order_month ORDER BY sales DESC) AS rank
  FROM monthly
)
SELECT seller_id, order_month, sales, rank
FROM ranked
WHERE rank <= 3
ORDER BY order_month DESC, rank;
```

---

### 2-5. ウィンドウ関数 SUM OVER（累計売上）

```sql
-- 出品者ごとの月別売上と累計売上
SELECT
  oi.seller_id,
  DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
  SUM(oi.subtotal) AS monthly_sales,
  SUM(SUM(oi.subtotal)) OVER (
    PARTITION BY oi.seller_id
    ORDER BY DATE_FORMAT(o.created_at, '%Y-%m')
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS cumulative_sales
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
GROUP BY oi.seller_id, order_month
ORDER BY oi.seller_id, order_month;
```

**ウィンドウ関数とは**：`GROUP BY` がグループを1行に集約するのに対して、ウィンドウ関数は行を減らさずに集計値を各行に付与する。`OVER (...)` が「ウィンドウ（集計範囲）」を定義する。

```
通常の SUM（GROUP BY）:
seller_id=1, 2025-07 → sales=50000          ← 1行にまとまる
seller_id=1, 2025-08 → sales=80000          ← 1行にまとまる

SUM OVER（ウィンドウ関数）:
seller_id=1, 2025-07 → monthly=50000, cumulative=50000   ← 行を保持したまま累計を付与
seller_id=1, 2025-08 → monthly=80000, cumulative=130000
```

**`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`**：「先頭行から現在行まで」の範囲。累計計算に使う。`ORDER BY` を指定するとデフォルトでこの範囲になるため、省略しても同じ結果になる（明示するとより意図が明確になる）。

---

### 2-6. RANK() OVER（出品者売上ランキング）

```sql
-- 月ごとの出品者売上ランキング
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
WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
GROUP BY oi.seller_id, order_month
ORDER BY order_month DESC, rank;
```

**`RANK` vs `DENSE_RANK` vs `ROW_NUMBER`**：

| 関数 | 同順位の扱い | 次の順位 | 例（売上: 100, 100, 80） |
|---|---|---|---|
| `RANK()` | 同順位あり | 飛び番 | 1, 1, 3 |
| `DENSE_RANK()` | 同順位あり | 連番 | 1, 1, 2 |
| `ROW_NUMBER()` | 同順位なし（行番号） | 連番 | 1, 2, 3 |

`RANK` は「2位が2人いたら次は4位」。`DENSE_RANK` は「2位が2人いても次は3位」。一般的な売上ランキングには `RANK` か `DENSE_RANK` を使う。

---

### 2-7. DENSE_RANK() OVER PARTITION BY（カテゴリ内商品ランキング）

```sql
-- カテゴリ内での商品売上ランキング
SELECT
  p.category_id,
  c.name AS category_name,
  oi.product_id,
  oi.product_name,
  SUM(oi.subtotal) AS total_sales,
  DENSE_RANK() OVER (
    PARTITION BY p.category_id
    ORDER BY SUM(oi.subtotal) DESC
  ) AS rank_in_category
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN categories c ON c.id = p.category_id
WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
GROUP BY p.category_id, c.name, oi.product_id, oi.product_name
ORDER BY p.category_id, rank_in_category;
```

**`PARTITION BY` の役割**：`GROUP BY` がクエリ全体をグループ化するのに対して、`PARTITION BY` はウィンドウ関数の集計範囲のみを区切る。`PARTITION BY p.category_id` とすると「カテゴリ内での順位」になり、カテゴリをまたいだ全体ランキングにならない。

---

### 2-8. 各クエリの EXPLAIN 確認

```bash
# 月別集計クエリの実行計画確認
mysql market -e "
EXPLAIN SELECT DATE_FORMAT(o.created_at,'%Y-%m') AS order_month,
               SUM(o.total_amount) AS total_sales
FROM orders o
WHERE o.status IN ('completed','shipped','delivered')
GROUP BY order_month;"
```

`type: ALL`（フルスキャン）が出た場合はインデックスを追加する（3-4 参照）。

---

## 3. DB（テーブル・View・インデックス）

### 3-1. migrations/019_create_notifications.sql

```sql
CREATE TABLE notifications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_user_read ON notifications (user_id, is_read);
```

実行：

```bash
mysql market < migrations/019_create_notifications.sql
```

確認：

```bash
mysql market -e "DESCRIBE notifications;"
```

| カラム | 理由 |
|---|---|
| `type` | `'order_paid'`・`'order_shipped'`・`'review_received'` など通知の種別 |
| `is_read TINYINT(1)` | MySQL に BOOLEAN はなく `TINYINT(1)` で代用（0=未読・1=既読） |
| `idx_notifications_user_read` | `WHERE user_id = ? AND is_read = 0` の未読一覧取得を高速化 |

---

### 3-2. migrations/020_create_daily_sales_summary.sql

```sql
CREATE TABLE daily_sales_summary (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  summary_date DATE NOT NULL,
  total_sales BIGINT UNSIGNED NOT NULL DEFAULT 0,
  order_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE (summary_date)
);
```

実行：

```bash
mysql market < migrations/020_create_daily_sales_summary.sql
```

確認：

```bash
mysql market -e "DESCRIBE daily_sales_summary;"
```

**なぜ集計テーブルが必要か**：

```
管理画面が開くたびに orders + order_items を JOIN して全期間を GROUP BY
→ 注文が100万件になると数秒かかる

集計テーブルの戦略：
  夜間バッチ（3-5）で前日分を集計 → daily_sales_summary に 1 行 INSERT/UPDATE
  管理画面は daily_sales_summary を SELECT するだけ → 1ms 以下
```

リアルタイム性が必要な「今日の売上」だけ `orders` を直接集計し、過去分は集計テーブルから取得するハイブリッド方式が現実的。

---

### 3-3. migrations/021_create_sales_views.sql

```sql
-- 月別・出品者別売上 View
CREATE OR REPLACE VIEW monthly_seller_sales AS
SELECT
  oi.seller_id,
  DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
  SUM(oi.subtotal) AS total_sales,
  COUNT(DISTINCT o.id) AS order_count
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
GROUP BY oi.seller_id, order_month;

-- カテゴリ別売上 View
CREATE OR REPLACE VIEW category_sales_summary AS
SELECT
  p.category_id,
  c.name AS category_name,
  SUM(oi.subtotal) AS total_sales,
  COUNT(DISTINCT o.id) AS order_count,
  COUNT(DISTINCT oi.product_id) AS product_count
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN categories c ON c.id = p.category_id
WHERE o.status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
GROUP BY p.category_id, c.name;
```

実行：

```bash
mysql market < migrations/021_create_sales_views.sql
```

確認：

```bash
mysql market -e "SHOW FULL TABLES WHERE Table_type = 'VIEW';"
mysql market -e "SELECT * FROM monthly_seller_sales LIMIT 5;"
mysql market -e "SELECT * FROM category_sales_summary;"
```

**View とは**：SELECT 文に名前を付けてテーブルのように扱える仮想テーブル。View 自体はデータを持たず、参照のたびに定義の SELECT が実行される。複雑な JOIN を毎回書く代わりに `SELECT * FROM monthly_seller_sales` で済む。ただしインデックスを持てないため、大規模データでは集計テーブル（`daily_sales_summary`）の方がパフォーマンスが良い。

---

### 3-4. migrations/022_add_aggregation_indexes.sql

```sql
-- orders: status + created_at の複合インデックス（集計クエリの WHERE + GROUP BY 用）
CREATE INDEX idx_orders_status_created
  ON orders (status, created_at);

-- order_items: seller_id インデックス（出品者別集計用）
CREATE INDEX idx_order_items_seller_id
  ON order_items (seller_id);

-- order_items: product_id インデックス（商品別集計用、FK で既にある場合は省略）
CREATE INDEX idx_order_items_product_id
  ON order_items (product_id);
```

実行：

```bash
mysql market < migrations/022_add_aggregation_indexes.sql
```

インデックス追加後に 2-8 の EXPLAIN を再実行し `type: ALL → type: ref` に改善されることを確認する：

```bash
mysql market -e "
EXPLAIN SELECT DATE_FORMAT(o.created_at,'%Y-%m') AS order_month,
               SUM(o.total_amount) AS total_sales
FROM orders o
WHERE o.status IN ('completed','shipped','delivered')
GROUP BY order_month;"
# key: idx_orders_status_created が使われていれば成功
```

---

### 3-5. シードデータ（admin ユーザー）

管理画面 API を確認するため admin ユーザーを作成する。

`seeds/admin_user.ts` を作成：

```typescript
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/connection.js';

const hash = await bcrypt.hash('adminpass123', 10);
await pool.query(
  `INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')
   ON DUPLICATE KEY UPDATE role = 'admin'`,
  ['admin@example.com', hash]
);
console.log('Admin user seeded');
process.exit(0);
```

実行：

```bash
npx tsx seeds/admin_user.ts
```

確認：

```bash
mysql market -e "SELECT id, email, role FROM users;"
```

---

## 4. バッチスクリプト（日次集計）

`scripts/daily-summary.ts` を作成：

```typescript
import 'dotenv/config';
import { pool } from '../src/db/connection.js';

// デフォルト：前日の日付。引数で上書き可能（例: npx tsx scripts/daily-summary.ts 2025-09-01）
const targetDate = process.argv[2] ?? (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
})();

console.log(`集計対象日: ${targetDate}`);

const [rows] = await pool.query(
  `SELECT
     COUNT(DISTINCT id) AS order_count,
     COALESCE(SUM(total_amount), 0) AS total_sales
   FROM orders
   WHERE status IN ('completed', 'shipped', 'delivered', 'paid', 'preparing')
     AND DATE(created_at) = ?`,
  [targetDate]
) as any[];

const { order_count, total_sales } = rows[0];

// INSERT ... ON DUPLICATE KEY UPDATE で冪等に実行できる（再実行しても結果が同じ）
await pool.query(
  `INSERT INTO daily_sales_summary (summary_date, total_sales, order_count)
   VALUES (?, ?, ?)
   ON DUPLICATE KEY UPDATE
     total_sales = VALUES(total_sales),
     order_count = VALUES(order_count)`,
  [targetDate, total_sales, order_count]
);

console.log(`  → 注文数: ${order_count}, 売上: ${total_sales}`);
await pool.end();
```

実行（前日分を集計）：

```bash
npx tsx scripts/daily-summary.ts
```

特定日を指定して実行（過去分の補完）：

```bash
npx tsx scripts/daily-summary.ts 2025-09-01
```

確認：

```bash
mysql market -e "SELECT * FROM daily_sales_summary ORDER BY summary_date DESC LIMIT 10;"
```

**冪等性（べきとうせい）**：`ON DUPLICATE KEY UPDATE` により同じ日付で何度実行しても同じ結果になる。バッチ失敗後に再実行しても二重カウントされない。

**本番での実行方法**：cron ジョブ（`0 2 * * * node dist/scripts/daily-summary.js`）で毎日深夜2時に自動実行する。Phase 10 の運用フェーズで設定する。

---

## 5. OpenAPI（仕様追加）

### 5-1. 管理画面エンドポイント定義追加

`openapi.yaml` の `paths:` に追記：

```yaml
  /admin/dashboard:
    get:
      summary: 売上ダッシュボード（管理者のみ）
      security:
        - BearerAuth: []
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DashboardSummary'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'

  /admin/orders:
    get:
      summary: 注文一覧（管理者のみ、フィルタ・ページング）
      security:
        - BearerAuth: []
      parameters:
        - name: status
          in: query
          schema:
            type: string
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
        - name: offset
          in: query
          schema:
            type: integer
            default: 0
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/Order'
                  total:
                    type: integer

  /admin/users:
    get:
      summary: ユーザー一覧（管理者のみ）
      security:
        - BearerAuth: []
      parameters:
        - name: role
          in: query
          schema:
            type: string
        - name: status
          in: query
          schema:
            type: string
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
        - name: offset
          in: query
          schema:
            type: integer
            default: 0
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/User'
                  total:
                    type: integer
```

### 5-2. 通知エンドポイント追加

```yaml
  /me/notifications:
    get:
      summary: 通知一覧取得
      security:
        - BearerAuth: []
      parameters:
        - name: unread_only
          in: query
          schema:
            type: boolean
            default: false
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/Notification'
                  unread_count:
                    type: integer

  /me/notifications/{notificationId}/read:
    post:
      summary: 通知を既読にする
      security:
        - BearerAuth: []
      parameters:
        - name: notificationId
          in: path
          required: true
          schema:
            type: integer
      responses:
        '200':
          description: 成功
```

### 5-3. DashboardSummary・Notification スキーマ追加

`components/schemas:` に追記：

```yaml
    DashboardSummary:
      type: object
      properties:
        today:
          type: object
          properties:
            total_sales:
              type: integer
            order_count:
              type: integer
            new_users:
              type: integer
        this_month:
          type: object
          properties:
            total_sales:
              type: integer
            order_count:
              type: integer
        monthly_trends:
          type: array
          items:
            type: object
            properties:
              order_month:
                type: string
              total_sales:
                type: integer
              order_count:
                type: integer
        top_sellers:
          type: array
          items:
            type: object
            properties:
              seller_id:
                type: integer
              monthly_sales:
                type: integer
              rank:
                type: integer
        category_sales:
          type: array
          items:
            type: object
            properties:
              category_id:
                type: integer
              category_name:
                type: string
              total_sales:
                type: integer

    Notification:
      type: object
      properties:
        id:
          type: integer
        type:
          type: string
        message:
          type: string
        is_read:
          type: boolean
        created_at:
          type: string
          format: date-time
```

---

## 6. API実装

### 6-1. middlewares/ - adminOnly Middleware

`src/middlewares/adminOnly.ts` を作成：

```typescript
import { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../errors/AppError.js';

// authenticate の後に使用する
// authenticate が req.user をセット済みであることが前提
export function adminOnly(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    return next(new ForbiddenError('管理者権限が必要です'));
  }
  next();
}
```

**`authenticate` との使用順序**：`adminOnly` は `req.user` が存在することを前提にしているため、必ず `authenticate` の後に使う。

```typescript
router.get('/admin/dashboard', authenticate, adminOnly, adminController.dashboard);
//                              ↑ 認証（誰？）  ↑ 認可（管理者？）
```

---

### 6-2. repositories/ - adminRepository

`src/repositories/adminRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';

export const adminRepository = {
  // 今日の売上・注文数（直接集計）
  async getTodaySummary() {
    const [rows] = await pool.query(
      `SELECT
         COALESCE(SUM(total_amount), 0) AS total_sales,
         COUNT(*) AS order_count
       FROM orders
       WHERE status IN ('completed','shipped','delivered','paid','preparing')
         AND DATE(created_at) = CURDATE()`
    ) as any[];
    return rows[0] as { total_sales: number; order_count: number };
  },

  // 今月の売上（直接集計）
  async getThisMonthSummary() {
    const [rows] = await pool.query(
      `SELECT
         COALESCE(SUM(total_amount), 0) AS total_sales,
         COUNT(*) AS order_count
       FROM orders
       WHERE status IN ('completed','shipped','delivered','paid','preparing')
         AND DATE_FORMAT(created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')`
    ) as any[];
    return rows[0] as { total_sales: number; order_count: number };
  },

  // 今日の新規ユーザー数
  async getNewUsersToday() {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS new_users FROM users WHERE DATE(created_at) = CURDATE()`
    ) as any[];
    return rows[0].new_users as number;
  },

  // 月別売上トレンド（過去6か月、daily_sales_summary + 今日の直接集計を合算）
  async getMonthlyTrends(months = 6) {
    const [rows] = await pool.query(
      `SELECT
         DATE_FORMAT(o.created_at, '%Y-%m') AS order_month,
         SUM(o.total_amount) AS total_sales,
         COUNT(DISTINCT o.id) AS order_count
       FROM orders o
       WHERE o.status IN ('completed','shipped','delivered','paid','preparing')
         AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
       GROUP BY order_month
       ORDER BY order_month DESC`,
      [months]
    ) as any[];
    return rows;
  },

  // 今月の出品者売上ランキング上位5
  async getTopSellers(limit = 5) {
    const [rows] = await pool.query(
      `SELECT
         oi.seller_id,
         SUM(oi.subtotal) AS monthly_sales,
         RANK() OVER (ORDER BY SUM(oi.subtotal) DESC) AS rank
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status IN ('completed','shipped','delivered','paid','preparing')
         AND DATE_FORMAT(o.created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')
       GROUP BY oi.seller_id
       ORDER BY rank
       LIMIT ?`,
      [limit]
    ) as any[];
    return rows;
  },

  // カテゴリ別売上（View から取得）
  async getCategorySales() {
    const [rows] = await pool.query(
      `SELECT category_id, category_name, total_sales, order_count
       FROM category_sales_summary
       ORDER BY total_sales DESC`
    ) as any[];
    return rows;
  },

  // 管理者用注文一覧（全ユーザー・フィルタ可）
  async findAllOrders(filters: { status?: string }, limit: number, offset: number) {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters.status) {
      conditions.push('o.status = ?');
      values.push(filters.status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT o.id, o.buyer_id, o.status,
              o.subtotal, o.shipping_fee, o.total_amount, o.created_at
       FROM orders o
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    ) as any[];

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM orders o ${where}`,
      values
    ) as any[];

    return { data: rows, total: countRows[0].total as number };
  },

  // 管理者用ユーザー一覧
  async findAllUsers(
    filters: { role?: string; status?: string },
    limit: number,
    offset: number
  ) {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters.role) { conditions.push('role = ?'); values.push(filters.role); }
    if (filters.status) { conditions.push('status = ?'); values.push(filters.status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT id, email, role, status, created_at FROM users
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    ) as any[];

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM users ${where}`,
      values
    ) as any[];

    return { data: rows, total: countRows[0].total as number };
  },
};
```

---

### 6-3. repositories/ - notificationRepository

`src/repositories/notificationRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';

export const notificationRepository = {
  async create(userId: number, type: string, message: string) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)`,
      [userId, type, message]
    );
  },

  async findByUserId(userId: number, unreadOnly: boolean) {
    const where = unreadOnly ? 'AND is_read = 0' : '';
    const [rows] = await pool.query(
      `SELECT id, user_id, type, message, is_read, created_at
       FROM notifications
       WHERE user_id = ? ${where}
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    ) as any[];
    return rows;
  },

  async countUnread(userId: number) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0`,
      [userId]
    ) as any[];
    return rows[0].cnt as number;
  },

  async markRead(id: number, userId: number) {
    await pool.query(
      `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
  },
};
```

---

### 6-4. services/ - adminService・notificationService

`src/services/adminService.ts` を作成：

```typescript
import { adminRepository } from '../repositories/adminRepository.js';

export const adminService = {
  async getDashboard() {
    const [today, thisMonth, newUsers, monthlyTrends, topSellers, categorySales] =
      await Promise.all([
        adminRepository.getTodaySummary(),
        adminRepository.getThisMonthSummary(),
        adminRepository.getNewUsersToday(),
        adminRepository.getMonthlyTrends(6),
        adminRepository.getTopSellers(5),
        adminRepository.getCategorySales(),
      ]);

    return {
      today: { ...today, new_users: newUsers },
      this_month: thisMonth,
      monthly_trends: monthlyTrends,
      top_sellers: topSellers,
      category_sales: categorySales,
    };
  },

  async getOrders(filters: { status?: string }, limit: number, offset: number) {
    return adminRepository.findAllOrders(filters, limit, offset);
  },

  async getUsers(
    filters: { role?: string; status?: string },
    limit: number,
    offset: number
  ) {
    return adminRepository.findAllUsers(filters, limit, offset);
  },
};
```

`src/services/notificationService.ts` を作成：

```typescript
import { notificationRepository } from '../repositories/notificationRepository.js';

export const notificationService = {
  // 通知作成（他のサービスから呼ぶ）
  async notify(userId: number, type: string, message: string) {
    try {
      await notificationRepository.create(userId, type, message);
    } catch (err) {
      // 通知失敗はビジネス処理を止めない（audit_log と同じ fire-and-forget）
      console.error('[notification] 作成失敗:', err);
    }
  },

  async getNotifications(userId: number, unreadOnly: boolean) {
    const [data, unreadCount] = await Promise.all([
      notificationRepository.findByUserId(userId, unreadOnly),
      notificationRepository.countUnread(userId),
    ]);
    return { data, unread_count: unreadCount };
  },

  async markRead(notificationId: number, userId: number) {
    await notificationRepository.markRead(notificationId, userId);
  },
};
```

**注文状態変更時に通知を生成する**：Phase 8 の `orderStatusService.ts` に `notificationService.notify` 呼び出しを追記する：

```typescript
// src/services/orderStatusService.ts の各メソッドに追記

// pay() の末尾
import { notificationService } from './notificationService.js';

// pay(): 出品者に「支払い完了」通知
const sellerId = (await pool.query(
  `SELECT DISTINCT seller_id FROM order_items WHERE order_id = ?`, [orderId]
) as any[])[0][0]?.seller_id;
if (sellerId) {
  await notificationService.notify(sellerId, 'order_paid', `注文 #${orderId} の支払いが完了しました`);
}

// ship(): 購入者に「発送」通知
await notificationService.notify(order.buyer_id, 'order_shipped', `注文 #${orderId} が発送されました`);

// receive(): 出品者に「受取完了」通知
if (sellerId) {
  await notificationService.notify(sellerId, 'order_completed', `注文 #${orderId} の取引が完了しました`);
}
```

---

### 6-5. schemas/ - 管理画面バリデーション

`src/schemas/adminSchema.ts` を作成：

```typescript
import { z } from 'zod';

export const adminOrdersQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminUsersQuerySchema = z.object({
  role: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const notificationParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const notificationsQuerySchema = z.object({
  unread_only: z.coerce.boolean().default(false),
});
```

---

### 6-6. controllers/ - adminController・notificationController

`src/controllers/adminController.ts` を作成：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { adminService } from '../services/adminService.js';
import { adminOrdersQuerySchema, adminUsersQuerySchema } from '../schemas/adminSchema.js';

export const adminController = {
  async dashboard(_req: Request, res: Response, next: NextFunction) {
    try {
      const result = await adminService.getDashboard();
      res.json(result);
    } catch (e) { next(e); }
  },

  async orders(req: Request, res: Response, next: NextFunction) {
    try {
      const query = adminOrdersQuerySchema.parse(req.query);
      const result = await adminService.getOrders(
        { status: query.status },
        query.limit,
        query.offset
      );
      res.json(result);
    } catch (e) { next(e); }
  },

  async users(req: Request, res: Response, next: NextFunction) {
    try {
      const query = adminUsersQuerySchema.parse(req.query);
      const result = await adminService.getUsers(
        { role: query.role, status: query.status },
        query.limit,
        query.offset
      );
      res.json(result);
    } catch (e) { next(e); }
  },
};
```

`src/controllers/notificationController.ts` を作成：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { notificationService } from '../services/notificationService.js';
import { notificationParamsSchema, notificationsQuerySchema } from '../schemas/adminSchema.js';

export const notificationController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const query = notificationsQuerySchema.parse(req.query);
      const result = await notificationService.getNotifications(
        req.user!.id,
        query.unread_only
      );
      res.json(result);
    } catch (e) { next(e); }
  },

  async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = notificationParamsSchema.parse(req.params);
      await notificationService.markRead(id, req.user!.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
};
```

---

### 6-7. routes/ - adminRoutes・notificationRoutes

`src/routes/adminRoutes.ts` を作成：

```typescript
import { Router } from 'express';
import { adminController } from '../controllers/adminController.js';
import { authenticate } from '../middlewares/authenticate.js';
import { adminOnly } from '../middlewares/adminOnly.js';

const router = Router();

// 全エンドポイントに authenticate + adminOnly を適用
router.use(authenticate, adminOnly);

router.get('/dashboard', adminController.dashboard);
router.get('/orders', adminController.orders);
router.get('/users', adminController.users);

export default router;
```

`src/routes/userRoutes.ts` に通知ルートを追記：

```typescript
import { notificationController } from '../controllers/notificationController.js';

router.get('/me/notifications', authenticate, notificationController.list);
router.post('/me/notifications/:id/read', authenticate, notificationController.markRead);
```

`src/app.ts` に管理画面ルーターを追加：

```typescript
import adminRoutes from './routes/adminRoutes.js';

app.use('/api/v1/admin', adminRoutes);
```

---

### 6-8. 動作確認

```bash
# admin ログイン
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"adminpass123"}' | jq -r .token)

# ダッシュボード
curl http://localhost:3000/api/v1/admin/dashboard \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# 注文一覧（全ステータス）
curl "http://localhost:3000/api/v1/admin/orders?limit=5" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 注文一覧（completed のみ）
curl "http://localhost:3000/api/v1/admin/orders?status=completed" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# ユーザー一覧
curl "http://localhost:3000/api/v1/admin/users?role=buyer" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 管理者以外でアクセス（403確認）
BUYER_TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com","password":"password123"}' | jq -r .token)
curl http://localhost:3000/api/v1/admin/dashboard \
  -H "Authorization: Bearer $BUYER_TOKEN"
# → {"error":"管理者権限が必要です"}

# 通知一覧（注文状態変更後に確認）
curl http://localhost:3000/api/v1/me/notifications \
  -H "Authorization: Bearer $BUYER_TOKEN"

# 未読のみ
curl "http://localhost:3000/api/v1/me/notifications?unread_only=true" \
  -H "Authorization: Bearer $BUYER_TOKEN"

# 既読に変更
curl -X POST http://localhost:3000/api/v1/me/notifications/1/read \
  -H "Authorization: Bearer $BUYER_TOKEN"

# DB で集計テーブル・View を確認
mysql market -e "SELECT * FROM daily_sales_summary ORDER BY summary_date DESC;"
mysql market -e "SELECT * FROM monthly_seller_sales LIMIT 10;"
mysql market -e "SELECT * FROM category_sales_summary;"
mysql market -e "SELECT * FROM notifications LIMIT 5;"
```

---

## 7. Flutter連携

### 7-1. 通知バッジ付きアイコン

`lib/features/notification/data/notification_repository.dart`：

```dart
import '../../../core/api/dio_client.dart';

class NotificationRepository {
  Future<Map<String, dynamic>> getNotifications({bool unreadOnly = false}) async {
    final response = await dio.get('/me/notifications', queryParameters: {
      'unread_only': unreadOnly,
    });
    return response.data as Map<String, dynamic>;
  }

  Future<void> markRead(int id) async {
    await dio.post('/me/notifications/$id/read');
  }
}
```

`lib/features/notification/ui/notification_screen.dart`：

```dart
import 'package:flutter/material.dart';
import '../data/notification_repository.dart';

class NotificationScreen extends StatefulWidget {
  const NotificationScreen({super.key});
  @override
  State<NotificationScreen> createState() => _NotificationScreenState();
}

class _NotificationScreenState extends State<NotificationScreen> {
  final _repo = NotificationRepository();
  List<dynamic> _notifications = [];
  int _unreadCount = 0;
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await _repo.getNotifications();
      setState(() {
        _notifications = result['data'] as List;
        _unreadCount = result['unread_count'] as int;
        _isLoading = false;
      });
    } catch (e) {
      setState(() => _isLoading = false);
    }
  }

  Future<void> _markRead(int id, int index) async {
    await _repo.markRead(id);
    setState(() {
      (_notifications[index] as Map)['is_read'] = true;
      if (_unreadCount > 0) _unreadCount--;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('通知 ($_unreadCount 件未読)'),
      ),
      body: _isLoading
        ? const Center(child: CircularProgressIndicator())
        : ListView.builder(
            itemCount: _notifications.length,
            itemBuilder: (context, i) {
              final n = _notifications[i] as Map;
              final isRead = n['is_read'] == true || n['is_read'] == 1;
              return ListTile(
                leading: Icon(
                  Icons.notifications,
                  color: isRead ? Colors.grey : Colors.blue,
                ),
                title: Text(
                  n['message'] as String,
                  style: TextStyle(
                    fontWeight: isRead ? FontWeight.normal : FontWeight.bold,
                  ),
                ),
                subtitle: Text((n['created_at'] as String).substring(0, 10)),
                onTap: isRead ? null : () => _markRead(n['id'] as int, i),
              );
            },
          ),
    );
  }
}
```

---

### 7-2. 管理者ダッシュボード画面

```bash
# pubspec.yaml に追加
flutter pub add fl_chart
```

`lib/features/admin/data/admin_repository.dart`：

```dart
import '../../../core/api/dio_client.dart';

class AdminRepository {
  Future<Map<String, dynamic>> getDashboard() async {
    final response = await dio.get('/admin/dashboard');
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getOrders({String? status, int limit = 20, int offset = 0}) async {
    final response = await dio.get('/admin/orders', queryParameters: {
      if (status != null) 'status': status,
      'limit': limit, 'offset': offset,
    });
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getUsers({String? role, int limit = 20, int offset = 0}) async {
    final response = await dio.get('/admin/users', queryParameters: {
      if (role != null) 'role': role,
      'limit': limit, 'offset': offset,
    });
    return response.data as Map<String, dynamic>;
  }
}
```

`lib/features/admin/ui/admin_dashboard_screen.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:fl_chart/fl_chart.dart';
import '../data/admin_repository.dart';

class AdminDashboardScreen extends StatefulWidget {
  const AdminDashboardScreen({super.key});
  @override
  State<AdminDashboardScreen> createState() => _AdminDashboardScreenState();
}

class _AdminDashboardScreenState extends State<AdminDashboardScreen> {
  final _repo = AdminRepository();
  Map<String, dynamic>? _data;
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = await _repo.getDashboard();
      setState(() { _data = data; _isLoading = false; });
    } catch (e) {
      setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    if (_data == null) return const Center(child: Text('データの取得に失敗しました'));

    final today = _data!['today'] as Map;
    final thisMonth = _data!['this_month'] as Map;
    final trends = _data!['monthly_trends'] as List;
    final categories = _data!['category_sales'] as List;

    return Scaffold(
      appBar: AppBar(title: const Text('管理ダッシュボード')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // KPI カード
            Row(children: [
              _kpiCard('今日の売上', '¥${today['total_sales']}'),
              const SizedBox(width: 8),
              _kpiCard('今月の売上', '¥${thisMonth['total_sales']}'),
            ]),
            Row(children: [
              _kpiCard('今日の注文数', '${today['order_count']}件'),
              const SizedBox(width: 8),
              _kpiCard('新規ユーザー', '${today['new_users']}人'),
            ]),
            const SizedBox(height: 24),
            // 月別売上棒グラフ
            const Text('月別売上推移（過去6か月）',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            SizedBox(
              height: 200,
              child: BarChart(
                BarChartData(
                  barGroups: List.generate(trends.length, (i) {
                    final t = trends[trends.length - 1 - i] as Map;
                    return BarChartGroupData(
                      x: i,
                      barRods: [BarChartRodData(
                        toY: (t['total_sales'] as num).toDouble(),
                        color: Colors.blue,
                        width: 16,
                      )],
                    );
                  }),
                  titlesData: FlTitlesData(
                    bottomTitles: AxisTitles(
                      sideTitles: SideTitles(
                        showTitles: true,
                        getTitlesWidget: (value, meta) {
                          final idx = trends.length - 1 - value.toInt();
                          if (idx < 0 || idx >= trends.length) return const SizedBox.shrink();
                          final month = (trends[idx] as Map)['order_month'] as String;
                          return Text(month.substring(5), // MM 部分のみ表示
                              style: const TextStyle(fontSize: 10));
                        },
                      ),
                    ),
                    leftTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                    topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                    rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                  ),
                  borderData: FlBorderData(show: false),
                ),
              ),
            ),
            const SizedBox(height: 24),
            // カテゴリ別売上
            const Text('カテゴリ別売上',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            ...categories.map((c) {
              final cat = c as Map;
              return ListTile(
                title: Text(cat['category_name'] as String),
                trailing: Text('¥${cat['total_sales']}'),
              );
            }),
          ],
        ),
      ),
    );
  }

  Widget _kpiCard(String label, String value) => Expanded(
    child: Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(fontSize: 12, color: Colors.grey)),
            Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    ),
  );
}
```

---

### 7-3. 注文管理・ユーザー管理画面（簡略版）

`lib/features/admin/ui/admin_orders_screen.dart`：

```dart
import 'package:flutter/material.dart';
import '../data/admin_repository.dart';

class AdminOrdersScreen extends StatefulWidget {
  const AdminOrdersScreen({super.key});
  @override
  State<AdminOrdersScreen> createState() => _AdminOrdersScreenState();
}

class _AdminOrdersScreenState extends State<AdminOrdersScreen> {
  final _repo = AdminRepository();
  List<dynamic> _orders = [];
  bool _isLoading = true;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final result = await _repo.getOrders();
      setState(() { _orders = result['data'] as List; _isLoading = false; });
    } catch (e) { setState(() => _isLoading = false); }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    return Scaffold(
      appBar: AppBar(title: Text('注文管理（${_orders.length}件）')),
      body: ListView.builder(
        itemCount: _orders.length,
        itemBuilder: (context, i) {
          final o = _orders[i] as Map;
          return ListTile(
            title: Text('注文 #${o['id']} - ${o['status']}'),
            subtitle: Text('¥${o['total_amount']} · ${(o['created_at'] as String).substring(0, 10)}'),
          );
        },
      ),
    );
  }
}
```

---

## 確認チェックリスト

Phase 9 完了の判断基準：

```
[ ] migrations/019〜022 が全て実行済みで対象テーブル・View が存在する
[ ] mysql コンソールで GROUP BY / HAVING / サブクエリ / CTE / ウィンドウ関数クエリを実行し結果を確認した
[ ] RANK() と DENSE_RANK() の違いを同順位データで確認した
[ ] SUM OVER PARTITION BY で累計売上が正しく計算されることを確認した
[ ] 022 のインデックス追加後に EXPLAIN で type が改善されたことを確認した
[ ] monthly_seller_sales View・category_sales_summary View が正しい集計値を返す
[ ] npx tsx scripts/daily-summary.ts を実行して daily_sales_summary にレコードが作成された
[ ] ON DUPLICATE KEY UPDATE で再実行しても重複しないことを確認した
[ ] seeds/admin_user.ts を実行して admin ユーザーが作成された
[ ] GET /admin/dashboard が今日/今月の売上・月別トレンド・ランキング・カテゴリ売上を返す
[ ] GET /admin/orders でページング・ステータスフィルタが機能する
[ ] GET /admin/users でページング・ロールフィルタが機能する
[ ] buyer ロールで /admin/* にアクセスすると 403 が返る
[ ] 注文状態変更後に notifications テーブルにレコードが作成される
[ ] GET /me/notifications で通知一覧が取得できる
[ ] POST /me/notifications/:id/read で既読フラグが更新される
[ ] Flutter のダッシュボード画面で月別売上棒グラフが表示される
[ ] Flutter の通知一覧で未読件数バッジが表示される
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|---|---|
| `GROUP BY` と `HAVING` の使い分け | `WHERE` は行を絞り込む（集計前）、`HAVING` はグループを絞り込む（集計後）。集計関数の結果に条件を付けるには `HAVING` しか使えない |
| サブクエリ vs CTE | 機能は同等。CTE は `WITH` で名前をつけるため複数段階の集計でも読みやすい。同じ集計を複数回参照する場合は CTE の方が意図が明確 |
| ウィンドウ関数の本質 | `GROUP BY` は行を集約する。ウィンドウ関数は行を保持したまま集計値を付与する。`OVER (PARTITION BY ... ORDER BY ...)` でウィンドウ（集計範囲）を定義する |
| `RANK` vs `DENSE_RANK` | 同順位があるときの次順位の付け方の違い。順位飛びを許すか連番にするかは要件次第 |
| 集計テーブルのトレードオフ | リアルタイム集計は常に最新だがコスト高。集計テーブルは高速だが更新ラグがある。ダッシュボードの「今日の売上」はリアルタイム、「過去月の売上」は集計テーブルというハイブリッドが現実的 |
| View の限界 | View はデータを持たないため参照のたびにクエリが実行される。複雑な集計 View を大量データに対して呼ぶとパフォーマンスが落ちる。集計テーブル + バッチ更新の方がスループットが高い |
| 冪等バッチの設計 | `ON DUPLICATE KEY UPDATE` で再実行しても結果が変わらないバッチを書く。失敗時の再実行・過去分の補完が安全にできる |
| 管理者権限の実装 | `authenticate`（誰か？）と `adminOnly`（管理者か？）を分離して組み合わせる。機能を分けることで Middleware の再利用性が上がる |
| 通知の非同期性 | 通知の書き込み失敗でビジネス処理（注文状態変更）を止めない設計。`fire-and-forget` パターンは副作用的な処理（通知・監査ログ）に適用する |
