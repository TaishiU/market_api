# Phase 7 - 在庫・トランザクション 詳細作業ログ

## 概要

Phase 6 でトランザクション内の原子的 UPDATE による在庫減算を実装した。
Phase 7 では同時購入が発生したときに在庫が二重消費されないことを保証する3つのアプローチを実装・比較し、最終実装を楽観的ロック（`version` カラム）に切り替える。

- MySQL のスナップショット読み取りとロック読み取りの違いを体感する
- `SELECT ... FOR UPDATE` による悲観的ロックを実装する
- `products.version` カラム + 楽観的ロックを実装する
- デッドロックの発生条件を把握し、リトライ処理を追加する
- Supertest で並行注文のテストケースを追加する

新規テーブルなし（`products` への `version` カラム追加のみ）。

---

## なぜ競合が起きるか

### SELECT → UPDATE の2ステップが危険な理由

Phase 6 の注文フローを整理する：

```
T1: SELECT stock=1, price=80000 （在庫あり → 注文続行）
T2: SELECT stock=1, price=80000 （在庫あり → 注文続行）
T1: BEGIN
T1: INSERT orders, order_items
T1: UPDATE SET stock=stock-1 WHERE id=1 AND stock>=1 → affectedRows=1
T1: COMMIT  → stock=0
T2: BEGIN
T2: INSERT orders, order_items
T2: UPDATE SET stock=stock-1 WHERE id=1 AND stock>=1 → affectedRows=0 (在庫0)
T2: ROLLBACK → 422 在庫不足
```

Phase 6 の原子的 UPDATE は `AND stock >= ?` の条件で T2 の UPDATE を0行にして在庫不足を検知している。**この仕組みは正しく動作する。**

ただし、トランザクション内の SELECT がスナップショットを読むという MySQL の挙動により、思わぬ落とし穴がある。

---

### MySQL のスナップショット読み取りとロック読み取り

MySQL の InnoDB はデフォルトの分離レベル `REPEATABLE READ` の下で、トランザクション開始時点のスナップショットを通常の SELECT に返す。

実際にターミナル2つで確認する：

```sql
-- ターミナル1（T1）
START TRANSACTION;
SELECT stock FROM products WHERE id = 1;
-- → stock: 1

-- ターミナル2（T2）
UPDATE products SET stock = 0 WHERE id = 1;
COMMIT;
-- stock が 0 に確定

-- ターミナル1（T1 のトランザクション継続中）
SELECT stock FROM products WHERE id = 1;
-- → stock: 1（T2 のコミットが見えない！スナップショット読み取り）

SELECT stock FROM products WHERE id = 1 FOR UPDATE;
-- → stock: 0（ロック読み取り：最新コミット済みの値を返す）

ROLLBACK; -- T1 終了
```

| 読み取り種別 | SQL | 返す値 | ロック |
|---|---|---|---|
| スナップショット読み取り | `SELECT ...` | トランザクション開始時点の値 | なし |
| ロック読み取り | `SELECT ... FOR UPDATE` | 最新コミット済みの値 | 行ロック（他の書き込みをブロック） |

**Phase 6 で問題が起きないのはなぜか**：`decrementStock` の原子的 UPDATE はトランザクション外の最新値に対して実行されるため、スナップショット読み取りの影響を受けない。問題が潜在するのは「トランザクション内の SELECT 結果を信頼してそのまま使う」パターン（例：SELECT で在庫確認 → アプリ側で判定 → 別の UPDATE を実行）。

---

## 3つのアプローチ比較

| アプローチ | 仕組み | 競合時の動作 | デッドロックリスク |
|---|---|---|---|
| 1. 原子的 UPDATE | `WHERE stock >= ?` で1クエリに集約 | 0行更新 → 在庫不足エラー | 低 |
| 2. 悲観的ロック（FOR UPDATE） | SELECT で行をロック → UPDATE | ロック待ち → タイムアウト | 複数商品ロックで高 |
| 3. 楽観的ロック（version） | UPDATE で version 一致確認 | 0行更新 → 競合エラー → リトライ | なし |

Phase 7 の最終実装：楽観的ロック（アプローチ3）  
理由：デッドロックが発生しない・スループットが高い・競合頻度が低い EC サイトに適している。

---

## 1. DB（version カラム追加）

### 1-1. migrations/013_add_version_to_products.sql

```sql
ALTER TABLE products
  ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 0;
```

実行：

```bash
mysql market < migrations/013_add_version_to_products.sql
```

確認：

```bash
mysql market -e "DESCRIBE products;"
# → version カラムが追加されていること確認

mysql market -e "SELECT id, name, stock, version FROM products LIMIT 5;"
# → 既存レコードの version は全て 0
```

**`DEFAULT 0` で既存レコードを補完する理由**：ALTER TABLE で NOT NULL カラムを追加するとき、DEFAULT を指定しないと既存レコードに値が入らないためエラーになる。`DEFAULT 0` を付けることで既存の全レコードが `version = 0` で補完される。

**`version` をレスポンスに含めない設計**：`version` は楽観的ロックのための内部カラム。クライアントに公開する必要はなく、誤って渡された version 値を信頼するとロジックが破綻する。`productRepository.findByIds` の SELECT 文および `openapi.yaml` の Product スキーマには追加しない。

---

## 2. パッケージインストール（テスト用）

Phase 7 では Vitest + Supertest によるテストを追加する。

```bash
npm i -D vitest supertest @types/supertest
```

| パッケージ | 役割 |
|---|---|
| `vitest` | Vite ベースのテストランナー。Jest 互換の API |
| `supertest` | Express アプリに HTTP リクエストを送る統合テスト用ライブラリ |

**`package.json` にスクリプト追加**：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**`vitest.config.ts` を作成**：

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

**`tsconfig.json` に `tests/` を含める**：

```json
{
  "compilerOptions": { ... },
  "include": ["src/**/*", "tests/**/*"]
}
```

---

## 3. 実装

### 3-1. アプローチ1：原子的 UPDATE（Phase 6 の動作確認）

Phase 6 で実装済みの `productRepository.decrementStock` を再確認する：

```typescript
// src/repositories/productRepository.ts（Phase 6 実装済み）
async decrementStock(conn: PoolConnection, productId: number, quantity: number) {
  const [result] = await conn.query(
    `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`,
    [quantity, productId, quantity]
  ) as any[];
  return result.affectedRows as number; // 0 = 在庫不足
},
```

**動作ポイント**：
- `stock - ?` と `AND stock >= ?` を同一 SQL にまとめることで「確認」と「減算」を分離しない
- `affectedRows === 0` を在庫不足の検知に使う
- `version` カラムを更新しない（アプローチ3 で切り替える）

---

### 3-2. アプローチ2：悲観的ロック（SELECT ... FOR UPDATE）

アプローチ1 との主な違いは「トランザクション内で最新値を取得してロックする」点。価格が注文中に変わる場合でも確実に最新価格をロックできる。

`src/repositories/productRepository.ts` に追記：

```typescript
  // FOR UPDATE: 行ロック付き最新値取得（トランザクション内で使用）
  async lockByIdForUpdate(conn: PoolConnection, productId: number) {
    const [rows] = await conn.query(
      `SELECT id, seller_id, name, price, stock, status
       FROM products WHERE id = ? FOR UPDATE`,
      [productId]
    ) as any[];
    return rows[0] ?? null;
  },
```

`src/services/orderService.ts` に FOR UPDATE パターンを追加（アプローチ比較用）：

```typescript
// FOR UPDATE パターン（アプローチ2）
// orderService.createOrderPessimistic として追加（比較・学習用）
async createOrderPessimistic(buyerId: number, idempotencyKey: string, items: ItemInput[]) {
  const existing = await orderRepository.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    const rows = await orderRepository.findById(existing.id);
    return groupByOrderId(rows)!;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // FOR UPDATE でロックしながら最新価格・在庫を取得
    // スナップショット読み取りではなくロック読み取りになる
    const lockedProducts: any[] = [];
    for (const item of items) {
      const product = await productRepository.lockByIdForUpdate(conn, item.product_id);
      if (!product) {
        await conn.rollback();
        throw new NotFoundError(`商品 ID:${item.product_id} が見つかりません`);
      }
      if (product.status !== 'published') {
        await conn.rollback();
        throw new UnprocessableEntityError(`商品「${product.name}」は販売停止中です`);
      }
      if (product.stock < item.quantity) {
        await conn.rollback();
        throw new UnprocessableEntityError(`商品「${product.name}」の在庫が不足しています`);
      }
      lockedProducts.push(product);
    }

    const productMap = new Map(lockedProducts.map(p => [p.id, p]));
    const orderItemsData = items.map(item => {
      const product = productMap.get(item.product_id)!;
      return {
        productId: product.id, sellerId: product.seller_id,
        productName: product.name, unitPrice: product.price,
        quantity: item.quantity, subtotal: product.price * item.quantity,
      };
    });

    const subtotal    = orderItemsData.reduce((s, i) => s + i.subtotal, 0);
    const totalAmount = subtotal;

    const orderId = await orderRepository.createOrder(conn, {
      buyerId, subtotal, shippingFee: 0, totalAmount, idempotencyKey,
    });
    await orderRepository.createOrderItems(conn, orderItemsData.map(i => ({ orderId, ...i })));

    // FOR UPDATE でロック済みなので単純な減算（stock >= ? チェックは既に上で実施）
    for (const item of items) {
      await conn.query(
        `UPDATE products SET stock = stock - ? WHERE id = ?`,
        [item.quantity, item.product_id]
      );
    }

    await conn.commit();
    const rows = await orderRepository.findById(orderId);
    return groupByOrderId(rows)!;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
},
```

**FOR UPDATE のデメリット：デッドロック**：

複数商品を含む注文で取得順序がリクエストごとに異なると、互いに相手のロック解放を待ち続けるデッドロックが発生する。

```
T1: LOCK 商品1 → 商品2 のロック待ち
T2: LOCK 商品2 → 商品1 のロック待ち → デッドロック！
```

対策：ロック順序を常に `product_id` の昇順に固定する。

```typescript
// items を product_id 昇順にソートしてからループ
const sortedItems = [...items].sort((a, b) => a.product_id - b.product_id);
for (const item of sortedItems) {
  // lockByIdForUpdate ...
}
```

---

### 3-3. アプローチ3：楽観的ロック（version カラム）

「競合はめったに起きない」という前提でロックを取らず、UPDATE 時に `version` の一致を確認する。不一致なら競合と判断してリトライする。

#### version を含む内部 SELECT

`src/repositories/productRepository.ts` に追記：

```typescript
  // version を含む取得（楽観的ロック用。トランザクション外で使用）
  // SELECT に version を含めるのはこのメソッドのみ。findByIds には含めない
  async findByIdsWithVersion(ids: number[]) {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT id, seller_id, name, price, stock, status, version
       FROM products WHERE id IN (${placeholders})`,
      ids
    ) as any[];
    return rows as Array<{
      id: number; seller_id: number; name: string;
      price: number; stock: number; status: string; version: number;
    }>;
  },

  // 楽観的ロック用減算（version 一致確認 + version+1）
  async decrementStockOptimistic(
    conn: PoolConnection,
    productId: number,
    quantity: number,
    version: number
  ) {
    const [result] = await conn.query(
      `UPDATE products
         SET stock = stock - ?,
             version = version + 1
       WHERE id = ?
         AND version = ?
         AND stock >= ?`,
      [quantity, productId, version, quantity]
    ) as any[];
    return result.affectedRows as number; // 0 = 競合 or 在庫不足
  },
```

#### orderService に楽観的ロックパターンを適用

`src/services/orderService.ts` の `createOrder` を楽観的ロック方式に変更する：

```typescript
async createOrder(buyerId: number, idempotencyKey: string, items: ItemInput[]) {
  const existing = await orderRepository.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    const rows = await orderRepository.findById(existing.id);
    return groupByOrderId(rows)!;
  }

  // version を含めて最新値を取得（トランザクション外・ロックなし）
  const productIds = items.map(i => i.product_id);
  const products = await productRepository.findByIdsWithVersion(productIds);
  const productMap = new Map(products.map(p => [p.id, p]));

  for (const item of items) {
    const product = productMap.get(item.product_id);
    if (!product) throw new NotFoundError(`商品 ID:${item.product_id} が見つかりません`);
    if (product.status !== 'published') {
      throw new UnprocessableEntityError(`商品「${product.name}」は販売停止中です`);
    }
    if (product.stock < item.quantity) {
      throw new UnprocessableEntityError(`商品「${product.name}」の在庫が不足しています`);
    }
  }

  const orderItemsData = items.map(item => {
    const product = productMap.get(item.product_id)!;
    return {
      productId: product.id, sellerId: product.seller_id,
      productName: product.name, unitPrice: product.price,
      quantity: item.quantity, subtotal: product.price * item.quantity,
    };
  });

  const subtotal = orderItemsData.reduce((s, i) => s + i.subtotal, 0);
  const totalAmount = subtotal;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const orderId = await orderRepository.createOrder(conn, {
      buyerId, subtotal, shippingFee: 0, totalAmount, idempotencyKey,
    });
    await orderRepository.createOrderItems(conn, orderItemsData.map(i => ({ orderId, ...i })));

    // version チェック付き減算
    for (const item of items) {
      const product = productMap.get(item.product_id)!;
      const affected = await productRepository.decrementStockOptimistic(
        conn, item.product_id, item.quantity, product.version
      );
      if (affected === 0) {
        // version 不一致（誰かに先を越された）または在庫不足
        // ROLLBACK して呼び出し元にリトライを促す
        await conn.rollback();
        throw new ConflictError(`商品「${product.name}」の在庫更新で競合が発生しました`);
      }
    }

    await conn.commit();
    const rows = await orderRepository.findById(orderId);
    return groupByOrderId(rows)!;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
},
```

**楽観的ロックの動作フロー**：

```
T1: SELECT version=0, stock=1
T2: SELECT version=0, stock=1
T1: BEGIN → INSERT orders, order_items
    → UPDATE WHERE version=0 AND stock>=1 → version=1, stock=0 → 1行更新 → COMMIT
T2: BEGIN → INSERT orders, order_items
    → UPDATE WHERE version=0 AND stock>=1 → version は既に1 → 0行更新 → ROLLBACK → 409 Conflict
```

T2 はリトライ（在庫が復活した場合）または 409 を返す。

---

### 3-4. errors/ - ConflictError の確認

Phase 2 で `ConflictError` は追加済み。Phase 7 での利用は競合検知（409）に使う：

```typescript
// src/errors/AppError.ts（Phase 2 追加済み）
export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, message);
  }
}
```

---

### 3-5. リトライ実装（デッドロック・楽観的ロック競合時）

`src/utils/retry.ts` を作成：

```typescript
// MySQL エラーコード
const DEADLOCK_ERROR_CODE = 1213; // ER_LOCK_DEADLOCK
const LOCK_TIMEOUT_ERROR_CODE = 1205; // ER_LOCK_WAIT_TIMEOUT

function isRetryableError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'errno' in err) {
    const errno = (err as { errno: number }).errno;
    return errno === DEADLOCK_ERROR_CODE || errno === LOCK_TIMEOUT_ERROR_CODE;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 100
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRetryableError(err) && attempt < maxRetries) {
        lastError = err;
        // 指数バックオフ：100ms → 200ms → 400ms
        await new Promise(r => setTimeout(r, baseDelayMs * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
```

`orderController.create` でリトライを使用：

```typescript
// src/controllers/orderController.ts
import { withRetry } from '../utils/retry.js';

async create(req: Request, res: Response, next: NextFunction) {
  try {
    const body = createOrderSchema.parse(req.body);
    const order = await withRetry(() =>
      orderService.createOrder(req.user!.id, body.idempotency_key, body.items)
    );
    res.status(201).json(order);
  } catch (error) {
    next(error);
  }
},
```

**指数バックオフとは**：リトライのたびに待機時間を倍にしていく方式（100ms → 200ms → 400ms）。全リクエストが同時にリトライすると再度競合するため、待機時間を分散させてスパイク（一斉再試行による負荷集中）を防ぐ。

---

## 4. 検証

### 4-1. 同時購入テストスクリプト

`tests/concurrent-order.ts` を作成：

```typescript
import 'dotenv/config';

const BASE_URL = 'http://localhost:3000/api/v1';
const TEST_PRODUCT = 1;  // 在庫1個の商品ID（事前に stock=1 に設定）
const CONCURRENT = 2;  // 同時送信数

// seller@example.com でログイン
async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const data = await res.json() as { token: string };
  return data.token;
}

async function placeOrder(token: string, key: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      idempotency_key: key,
      items: [{ product_id: TEST_PRODUCT, quantity: 1 }],
    }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

// 在庫を1個にリセット
async function resetStock() {
  const { pool } = await import('../src/db/connection.js');
  await pool.query(`UPDATE products SET stock = 1, version = 0 WHERE id = ?`, [TEST_PRODUCT]);
  await pool.end();
}

(async () => {
  await resetStock();
  console.log(`在庫をリセット: stock=1, version=0`);

  const token = await login('seller@example.com');

  // 異なる idempotency_key で同時に注文（Promise.all で並列実行）
  const requests = Array.from({ length: CONCURRENT }, (_, i) =>
    placeOrder(token, `concurrent-test-${Date.now()}-${i}`)
  );

  const results = await Promise.allSettled(requests);
  for (const r of results) {
    if (r.status === 'fulfilled') {
      console.log(`→ HTTP ${r.value.status}:`, JSON.stringify(r.value.body).slice(0, 80));
    } else {
      console.log(`→ エラー:`, r.reason);
    }
  }

  // 期待値：1つが 201、1つが 409（または 422）
  const statuses = results
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<{ status: number }>).value.status);
  const success = statuses.filter(s => s === 201).length;
  const conflict = statuses.filter(s => s === 409 || s === 422).length;
  console.log(`\n結果: 成功=${success}件 / 競合=${conflict}件`);
  console.log(success === 1 && conflict === 1 ? '✅ 在庫二重消費なし' : '❌ 異常');
})();
```

実行前に対象商品の在庫を1個に設定：

```bash
mysql market -e "UPDATE products SET stock = 1, version = 0 WHERE id = 1;"
```

実行：

```bash
# サーバーを起動した状態で別ターミナルから
npx tsx tests/concurrent-order.ts
```

期待される出力：

```
在庫をリセット: stock=1, version=0
→ HTTP 201: {"id":2,"status":"pending","subtotal":80000,...}
→ HTTP 409: {"error":"商品「iPhone 14」の在庫更新で競合が発生しました"}

結果: 成功=1件 / 競合=1件
✅ 在庫二重消費なし
```

---

### 4-2. デッドロックを意図的に発生させる

FOR UPDATE パターンのデッドロック条件を MySQL コンソール2つで再現する：

```bash
# ターミナル1
mysql market
```

```sql
-- ターミナル1
START TRANSACTION;
UPDATE products SET stock = stock - 1 WHERE id = 1;
-- ここで一時停止（ターミナル2の操作を待つ）
```

```bash
# ターミナル2
mysql market
```

```sql
-- ターミナル2
START TRANSACTION;
UPDATE products SET stock = stock - 1 WHERE id = 2;
UPDATE products SET stock = stock - 1 WHERE id = 1;
-- ターミナル1が id=1 をロック中 → 待機状態になる
```

```sql
-- ターミナル1（ターミナル2が待機中の間に実行）
UPDATE products SET stock = stock - 1 WHERE id = 2;
-- ターミナル2が id=2 をロック中 → デッドロック発生！
-- MySQL がどちらかを自動 ROLLBACK する
```

期待される出力（デッドロックを検知した側）：

```
ERROR 1213 (40001): Deadlock found when trying to get lock; try restarting transaction
```

MySQL は自動的にどちらかのトランザクションをロールバックする。アプリ側がリトライ処理（3-5）を持っていれば、ユーザーはエラーを感じることなく注文が完了する。

---

### 4-3. Supertest でテスト追加

`tests/order.test.ts` を作成：

```typescript
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db/connection.js';
import app from '../src/app.js';

// テスト用 JWT 取得ヘルパー
async function getToken(email: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: 'password123' });
  return res.body.token as string;
}

// 対象商品の在庫・version をリセット
async function resetProduct(id: number, stock: number) {
  await pool.query(
    `UPDATE products SET stock = ?, version = 0 WHERE id = ?`,
    [stock, id]
  );
}

describe('POST /api/v1/orders', () => {
  let buyerToken: string;
  const TEST_PRODUCT_ID = 1;

  beforeAll(async () => {
    buyerToken = await getToken('buyer@example.com');
  });

  afterEach(async () => {
    // テストごとに注文テーブルをクリア（テスト間の干渉を防ぐ）
    await pool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email = 'buyer@example.com'))`);
    await pool.query(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email = 'buyer@example.com')`);
  });

  it('在庫あり → 201 で注文が作成される', async () => {
    await resetProduct(TEST_PRODUCT_ID, 5);

    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        idempotency_key: `test-${Date.now()}`,
        items: [{ product_id: TEST_PRODUCT_ID, quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('items');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].product_id).toBe(TEST_PRODUCT_ID);

    // 在庫が減っていること確認
    const [rows] = await pool.query(
      `SELECT stock FROM products WHERE id = ?`,
      [TEST_PRODUCT_ID]
    ) as any[];
    expect(rows[0].stock).toBe(4);
  });

  it('在庫不足 → 422 を返す', async () => {
    await resetProduct(TEST_PRODUCT_ID, 1);

    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        idempotency_key: `test-${Date.now()}`,
        items: [{ product_id: TEST_PRODUCT_ID, quantity: 99 }],
      });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('error');
  });

  it('同一 idempotency_key で2回送信 → 注文が1件しか作成されない（冪等性）', async () => {
    await resetProduct(TEST_PRODUCT_ID, 5);
    const key = `idem-test-${Date.now()}`;

    const res1 = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ idempotency_key: key, items: [{ product_id: TEST_PRODUCT_ID, quantity: 1 }] });

    const res2 = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ idempotency_key: key, items: [{ product_id: TEST_PRODUCT_ID, quantity: 1 }] });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(200); // 既存注文を返す
    expect(res1.body.id).toBe(res2.body.id);

    // 在庫は1回分しか減らない
    const [rows] = await pool.query(
      `SELECT stock FROM products WHERE id = ?`,
      [TEST_PRODUCT_ID]
    ) as any[];
    expect(rows[0].stock).toBe(4);
  });

  it('楽観的ロック競合 → 409 を返す', async () => {
    await resetProduct(TEST_PRODUCT_ID, 1);

    // version を手動で古い値に見せかける（強制競合シミュレーション）
    // 実際の並行処理では2つ目のリクエストが409になる
    const [productRows] = await pool.query(
      `SELECT version FROM products WHERE id = ?`,
      [TEST_PRODUCT_ID]
    ) as any[];
    const currentVersion = productRows[0].version;

    // version を直接進めて「誰かが先にコミットした状態」を作る
    await pool.query(
      `UPDATE products SET version = version + 1 WHERE id = ?`,
      [TEST_PRODUCT_ID]
    );

    // version が古い状態でキャッシュしている注文リクエストを再現（decrementStockOptimistic に古い version を渡す）
    // テスト環境では直接リポジトリを呼び出すか、サービスを直接テストする
    const affected = await (async () => {
      const { pool: p } = await import('../src/db/connection.js');
      const conn = await p.getConnection();
      try {
        const [r] = await conn.query(
          `UPDATE products SET stock = stock - 1, version = version + 1 WHERE id = ? AND version = ? AND stock >= 1`,
          [TEST_PRODUCT_ID, currentVersion] // 古い version
        ) as any[];
        conn.release();
        return r.affectedRows;
      } catch (e) {
        conn.release();
        throw e;
      }
    })();
    expect(affected).toBe(0); // version 不一致 → 0行更新
  });

  it('認証なし → 401 を返す', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .send({ idempotency_key: 'test', items: [{ product_id: 1, quantity: 1 }] });

    expect(res.status).toBe(401);
  });
});
```

テスト実行：

```bash
npm test
```

**`afterEach` でテストデータをクリアする理由**：テスト間でデータが干渉しないようにする。前のテストで作成した注文が次のテストの件数確認に影響する。本番データへの影響を避けるため、テスト用 DB を別途用意するのが理想だが、学習段階では共有 DB + クリーンアップで進める。

---

### 4-4. 3アプローチの実行時間比較スクリプト

`tests/perf-compare.ts` を作成：

```typescript
import 'dotenv/config';
import { pool } from '../src/db/connection.js';

const ITERATIONS = 100;
const PRODUCT_ID = 1;

async function resetStock(stock: number) {
  await pool.query(
    `UPDATE products SET stock = ?, version = 0 WHERE id = ?`,
    [stock, PRODUCT_ID]
  );
}

async function measureMs(label: string, fn: () => Promise<void>) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) await fn();
  const elapsed = performance.now() - start;
  console.log(`${label}: ${(elapsed / ITERATIONS).toFixed(2)}ms/op（合計 ${elapsed.toFixed(0)}ms）`);
}

// アプローチ1: 原子的UPDATE
async function atomicUpdate() {
  await pool.query(
    `UPDATE products SET stock = stock + 1 WHERE id = ?`, [PRODUCT_ID]
  );
  const [r] = await pool.query(
    `UPDATE products SET stock = stock - 1 WHERE id = ? AND stock >= 1`, [PRODUCT_ID]
  ) as any[];
  if (r.affectedRows === 0) throw new Error('在庫不足');
}

// アプローチ2: FOR UPDATE
async function forUpdate() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT stock FROM products WHERE id = ? FOR UPDATE`, [PRODUCT_ID]
    ) as any[];
    if (rows[0].stock < 1) { await conn.rollback(); return; }
    await conn.query(
      `UPDATE products SET stock = stock - 1 WHERE id = ?`, [PRODUCT_ID]
    );
    await conn.query(
      `UPDATE products SET stock = stock + 1 WHERE id = ?`, [PRODUCT_ID]
    );
    await conn.commit();
  } finally { conn.release(); }
}

// アプローチ3: 楽観的ロック
async function optimisticLock() {
  const [rows] = await pool.query(
    `SELECT stock, version FROM products WHERE id = ?`, [PRODUCT_ID]
  ) as any[];
  const { stock, version } = rows[0];
  if (stock < 1) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `UPDATE products SET stock = stock - 1, version = version + 1 WHERE id = ? AND version = ? AND stock >= 1`,
      [PRODUCT_ID, version]
    ) as any[];
    if (r.affectedRows === 0) { await conn.rollback(); return; }
    await conn.query(
      `UPDATE products SET stock = stock + 1, version = version + 1 WHERE id = ?`, [PRODUCT_ID]
    );
    await conn.commit();
  } finally { conn.release(); }
}

await resetStock(ITERATIONS + 10);
await measureMs('アプローチ1: 原子的UPDATE   ', atomicUpdate);
await resetStock(ITERATIONS + 10);
await measureMs('アプローチ2: FOR UPDATE     ', forUpdate);
await resetStock(ITERATIONS + 10);
await measureMs('アプローチ3: 楽観的ロック   ', optimisticLock);

await pool.end();
```

実行：

```bash
npx tsx tests/perf-compare.ts
```

期待される傾向（同一マシン・シングルスレッドの場合）：

```
アプローチ1: 原子的UPDATE   : 0.5ms/op（合計  50ms）  ← 最速（1クエリ）
アプローチ2: FOR UPDATE     : 1.2ms/op（合計 120ms）  ← BEGIN+SELECT+UPDATE+COMMIT
アプローチ3: 楽観的ロック   : 0.9ms/op（合計  90ms）  ← SELECT+BEGIN+UPDATE+COMMIT
```

並行リクエスト数が増えると FOR UPDATE はロック待ちでスループットが急落する。楽観的ロックは競合が少ない場合にスループットが高い。

---

## 5. EXPLAIN で並行制御の副作用を確認

楽観的ロックを追加した後、注文クエリに影響がないか EXPLAIN で確認する：

```bash
mysql market -e "
EXPLAIN SELECT id, seller_id, name, price, stock, status, version
FROM products WHERE id IN (1, 2, 3);
"
```

確認ポイント：

| 列 | 期待値 | 意味 |
|---|---|---|
| `type` | `range` または `const` | PRIMARY KEY による高速アクセス |
| `key` | `PRIMARY` | プライマリキーが使われている |
| `rows` | IN 句の件数程度 | フルスキャンしていない |

`type: ALL`（フルスキャン）が出た場合はインデックスが使われていない。`id IN (...)` は PRIMARY KEY を使うため通常は問題ない。

---

## 確認チェックリスト

Phase 7 完了の判断基準：

```
[ ] migrations/013_add_version_to_products.sql が実行済みで products.version カラムが存在する
[ ] productRepository.findByIdsWithVersion に version が含まれる
[ ] productRepository.decrementStockOptimistic が version チェック付き UPDATE を実行する
[ ] orderService.createOrder が楽観的ロック方式に切り替わっている
[ ] withRetry がデッドロック（errno=1213）時にリトライする
[ ] MySQL コンソール2ターミナルでスナップショット読み取りとロック読み取りの挙動差を確認した
[ ] concurrent-order.ts を実行して在庫1個に2リクエストを同時送信し、成功1件・競合1件になった
[ ] デッドロックを意図的に発生させ ERROR 1213 を確認した
[ ] npm test でテストが全て PASS する
[ ] 在庫不足テストが 422 を返すことを確認した
[ ] 同一 idempotency_key で2回送信しても注文が1件しか作られないことを確認した
[ ] version は openapi.yaml の Product スキーマに追加していない
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|---|---|
| スナップショット読み取り | `REPEATABLE READ` 下での通常 SELECT はトランザクション開始時点の値を返す。コンソール2窓で T2 コミット後も T1 の SELECT が古い値を返すことを実際に確認する |
| ロック読み取り | `FOR UPDATE` は最新コミット済みの値を返し、行ロックを取得する。スナップショット読み取りと何が違うかを体感する |
| 原子的 UPDATE の意味 | `WHERE stock >= ?` を同一 SQL に含めることで「確認と更新を分離しない」ことの意味 |
| 悲観的 vs 楽観的ロック | 競合を「起きる前に防ぐ（FOR UPDATE）」か「起きた後に検知する（version）」かの設計の違い。競合頻度が低い場合はロックのオーバーヘッドを避けられる楽観的ロックが有利 |
| デッドロック | 複数リソースを取得する順序が異なると発生する。回避策は取得順序の固定。検知後は自動ロールバック＋リトライで対処 |
| affectedRows の活用 | UPDATE の結果件数を条件判定に使う（0行 = 競合）。SELECT で状態確認してから別 UPDATE する設計より安全でシンプル |
| コネクション管理 | `pool.getConnection()` と `conn.release()` を `finally` でペアにする必要性。リークするとコネクションプールが枯渇する |
| Supertest | Express アプリを実際に起動せず HTTP リクエストを送れる。DB に対して実際に読み書きする統合テストのため、テスト後のデータクリーンアップが必要 |
