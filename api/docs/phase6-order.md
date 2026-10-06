# Phase 6 - 注文・価格確定 詳細作業ログ

## 概要

Phase 5 でカートに商品を追加する機能を実装した。
Phase 6 では注文確定機能を追加する。

- クライアントから送られた価格を使わない（サーバーが必ず DB から最新価格を取得して計算）
- `order_items` に注文時点の価格（`unit_price`）・商品名（`product_name`）をコピーして保存
- トランザクション内で在庫確認 → 注文作成 → 在庫減算を原子的に実行
- `idempotency_key` で通信失敗時の二重注文を防止

---

## なぜクライアント送信価格を信用しないか

```
悪意あるユーザーが改ざんしたリクエスト例：
POST /orders
{ "items": [{ "product_id": 1, "quantity": 1, "price": 1 }] }

→ サーバーが受け取った price をそのまま使うと 1 円で注文が成立してしまう
```

対策：price はリクエストボディに含めさせない。注文処理の中でサーバーが DB から `SELECT price FROM products WHERE id = ?` して計算する。

---

## なぜ order_items に価格をコピーするか

```
注文後に出品者が価格を変更したとする：

products.price    = 5000 → 変更後 8000
order_items.unit_price = 5000 → 変更されない（注文時点の値をコピー済み）

products を JOIN して価格を動的に取得する設計だと、
過去の注文金額が現在の商品価格で上書きされてしまう。
```

`product_name` も同様の理由でコピーする。商品名変更・商品削除後も注文履歴に正確な情報を残すため。

---

## 新規パッケージ

Phase 6 では新規パッケージは不要。Phase 2〜5 までのパッケージで実装できる。

---

## 2. DB（テーブル作成）

### 2-1. migrations/011_create_orders.sql

```sql
CREATE TABLE orders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  buyer_id INT UNSIGNED NOT NULL,
  status ENUM('pending', 'paid', 'preparing', 'shipped', 'delivered', 'completed', 'cancelled')
    NOT NULL DEFAULT 'pending',
  subtotal BIGINT UNSIGNED NOT NULL,
  shipping_fee BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_amount BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE (idempotency_key),
  FOREIGN KEY (buyer_id) REFERENCES users(id)
);
```

実行：

```bash
mysql market < migrations/011_create_orders.sql
```

確認：

```bash
mysql market -e "SHOW TABLES;"
# → orders が表示されれば成功

mysql market -e "DESCRIBE orders;"
```

| カラム | 理由 |
|---|---|
| `status ENUM` | 取りうる遷移を制限。後続フェーズ（Phase 8）で状態遷移バリデーションを追加する |
| `subtotal` | 商品代金の合計（送料除く）。BIGINT で整数管理 |
| `shipping_fee` | 送料。Phase 6 では固定値（0）で実装し、Phase 8 以降で動的計算に切り替える |
| `total_amount` | `subtotal + shipping_fee`。JOIN なしで合計金額を取得できるように非正規化して保存 |
| `idempotency_key UNIQUE` | 同じキーの注文は2件目をINSERTしない。DB制約でも二重注文を防ぐ |

**`total_amount` を非正規化して保存する理由**：  
`total_amount = subtotal + shipping_fee` は計算で求められるが、注文後に `shipping_fee` ポリシーが変わっても過去の注文金額が変わらないよう、確定時点の値を直接保存する。

---

### 2-2. migrations/012_create_order_items.sql

```sql
CREATE TABLE order_items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  seller_id INT UNSIGNED NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  unit_price BIGINT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  subtotal BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (seller_id) REFERENCES users(id)
);
```

実行：

```bash
mysql market < migrations/012_create_order_items.sql
```

確認：

```bash
mysql market -e "DESCRIBE order_items;"
```

| カラム | 理由 |
|---|---|
| `product_name` | 注文時点の商品名をコピー。商品名変更・削除後も注文履歴に表示できる |
| `unit_price` | 注文時点の単価をコピー。商品価格変更後も過去の注文金額が変わらない |
| `seller_id` | 明細ごとに出品者を持つ（将来の複数出品者対応）。products の seller_id から注文時点にコピー |
| `subtotal` | `unit_price × quantity` を保存。商品価格変更後も明細金額が変わらないよう非正規化 |

**`order_items` に `created_at` が不要な理由**：注文日時は `orders.created_at` で管理する。明細行に個別の日時は不要。

---

## 3. OpenAPI（仕様追加）

### 3-1. OrderPreview・Order・OrderItem スキーマ追加

`openapi.yaml` の `components/schemas:` に追記：

```yaml
    OrderItemInput:
      type: object
      required: [product_id, quantity]
      properties:
        product_id:
          type: integer
        quantity:
          type: integer
          minimum: 1

    OrderPreviewItem:
      type: object
      properties:
        product_id:
          type: integer
        product_name:
          type: string
        unit_price:
          type: integer
        quantity:
          type: integer
        subtotal:
          type: integer

    OrderPreview:
      type: object
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/OrderPreviewItem'
        subtotal:
          type: integer
        shipping_fee:
          type: integer
        total_amount:
          type: integer

    OrderItem:
      type: object
      properties:
        id:
          type: integer
        product_id:
          type: integer
        seller_id:
          type: integer
        product_name:
          type: string
        unit_price:
          type: integer
        quantity:
          type: integer
        subtotal:
          type: integer

    Order:
      type: object
      properties:
        id:
          type: integer
        buyer_id:
          type: integer
        status:
          type: string
          enum: [pending, paid, preparing, shipped, delivered, completed, cancelled]
        subtotal:
          type: integer
        shipping_fee:
          type: integer
        total_amount:
          type: integer
        created_at:
          type: string
          format: date-time
        items:
          type: array
          items:
            $ref: '#/components/schemas/OrderItem'
```

### 3-2. エンドポイント定義追加

`openapi.yaml` の `paths:` に追記：

```yaml
  /orders/preview:
    post:
      summary: 注文内容確認（価格・合計のサーバー計算）
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [items]
              properties:
                items:
                  type: array
                  items:
                    $ref: '#/components/schemas/OrderItemInput'
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderPreview'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          $ref: '#/components/responses/NotFound'
        '422':
          $ref: '#/components/responses/UnprocessableEntity'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /orders:
    post:
      summary: 注文確定
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [idempotency_key, items]
              properties:
                idempotency_key:
                  type: string
                  maxLength: 64
                items:
                  type: array
                  items:
                    $ref: '#/components/schemas/OrderItemInput'
      responses:
        '201':
          description: 注文作成成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          $ref: '#/components/responses/NotFound'
        '422':
          $ref: '#/components/responses/UnprocessableEntity'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /me/orders:
    get:
      summary: 購入履歴一覧
      security:
        - BearerAuth: []
      parameters:
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
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /orders/{orderId}:
    get:
      summary: 注文詳細取得
      security:
        - BearerAuth: []
      parameters:
        - name: orderId
          in: path
          required: true
          schema:
            type: integer
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

### 3-3. UnprocessableEntity レスポンス追加

`components/responses:` に追記：

```yaml
    UnprocessableEntity:
      description: 業務ルール違反（在庫不足など）
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string

    Forbidden:
      description: 権限なし
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
```

**422 と 400 の使い分け**：

| コード | 意味 | 例 |
|---|---|---|
| 400 Bad Request | リクエスト形式・バリデーションエラー | `quantity` が数値でない |
| 422 Unprocessable Entity | 形式は正しいが業務ルール違反 | 在庫不足・販売停止商品の注文 |

---

## 4. API実装

### 4-1. errors/ - 在庫不足エラー追加

`src/errors/AppError.ts` に追記：

```typescript
export class UnprocessableEntityError extends AppError {
  constructor(message: string) {
    super(422, message);
  }
}
```

---

### 4-2. schemas/ - 注文バリデーション定義

`src/schemas/orderSchema.ts` を作成：

```typescript
import { z } from 'zod';

const orderItemInputSchema = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().int().min(1),
});

export const orderPreviewSchema = z.object({
  items: z.array(orderItemInputSchema).min(1),
});

export const createOrderSchema = z.object({
  idempotency_key: z.string().min(1).max(64),
  items: z.array(orderItemInputSchema).min(1),
});

export const getOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const getOrderParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
```

---

### 4-3. repositories/ - orderRepository

`src/repositories/orderRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';
import type { PoolConnection } from 'mysql2/promise';

export const orderRepository = {
  // idempotency_key で既存注文を検索（二重注文チェックに使用）
  async findByIdempotencyKey(key: string) {
    const [rows] = await pool.query(
      `SELECT id FROM orders WHERE idempotency_key = ?`,
      [key]
    ) as any[];
    return rows[0] ?? null;
  },

  // 注文作成（トランザクション内で使用するため connection を受け取る）
  async createOrder(
    conn: PoolConnection,
    data: {
      buyerId: number;
      subtotal: number;
      shippingFee: number;
      totalAmount: number;
      idempotencyKey: string;
    }
  ) {
    const [result] = await conn.query(
      `INSERT INTO orders (buyer_id, subtotal, shipping_fee, total_amount, idempotency_key)
       VALUES (?, ?, ?, ?, ?)`,
      [data.buyerId, data.subtotal, data.shippingFee, data.totalAmount, data.idempotencyKey]
    ) as any[];
    return result.insertId as number;
  },

  // 注文明細一括作成（トランザクション内で使用）
  async createOrderItems(
    conn: PoolConnection,
    items: Array<{
      orderId: number;
      productId: number;
      sellerId: number;
      productName: string;
      unitPrice: number;
      quantity: number;
      subtotal: number;
    }>
  ) {
    const rows = items.map(i => [
      i.orderId, i.productId, i.sellerId,
      i.productName, i.unitPrice, i.quantity, i.subtotal,
    ]);
    await conn.query(
      `INSERT INTO order_items
         (order_id, product_id, seller_id, product_name, unit_price, quantity, subtotal)
       VALUES ?`,
      [rows]
    );
  },

  // 注文一覧取得（購入履歴）
  async findByBuyerId(buyerId: number, limit: number, offset: number) {
    const [rows] = await pool.query(
      `SELECT
         o.id, o.buyer_id, o.status,
         o.subtotal, o.shipping_fee, o.total_amount, o.created_at,
         oi.id AS item_id,
         oi.product_id,
         oi.seller_id,
         oi.product_name,
         oi.unit_price,
         oi.quantity,
         oi.subtotal AS item_subtotal
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.buyer_id = ?
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [buyerId, limit, offset]
    ) as any[];
    return rows;
  },

  async countByBuyerId(buyerId: number) {
    const [rows] = await pool.query(
      `SELECT COUNT(DISTINCT id) as total FROM orders WHERE buyer_id = ?`,
      [buyerId]
    ) as any[];
    return rows[0].total as number;
  },

  // 注文詳細取得
  async findById(orderId: number) {
    const [rows] = await pool.query(
      `SELECT
         o.id, o.buyer_id, o.status,
         o.subtotal, o.shipping_fee, o.total_amount, o.created_at,
         oi.id AS item_id,
         oi.product_id,
         oi.seller_id,
         oi.product_name,
         oi.unit_price,
         oi.quantity,
         oi.subtotal AS item_subtotal
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = ?`,
      [orderId]
    ) as any[];
    return rows;
  },
};
```

**JOIN 結果を注文オブジェクトに変換するヘルパー**

JOIN すると1注文が明細行数分フラットに展開される。Service 層で1注文1オブジェクトに集約する：

```
order_id=1 の結果（2明細ある場合）：
row[0]: { id:1, status:'pending', ..., item_id:1, product_name:'iPhone', ... }
row[1]: { id:1, status:'pending', ..., item_id:2, product_name:'iPad',   ... }

↓ groupByOrderId() で変換

{ id:1, status:'pending', ..., items: [{ id:1, product_name:'iPhone' }, { id:2, product_name:'iPad' }] }
```

---

### 4-4. repositories/ - productRepository に在庫取得メソッド追加

`src/repositories/productRepository.ts` に追記：

```typescript
  // 複数商品の価格・在庫・出品者を一括取得（注文時のサーバー計算用）
  async findByIds(ids: number[]) {
    if (ids.length === 0) return [];
    // IN 句のプレースホルダーを動的生成
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT id, seller_id, name, price, stock, status FROM products WHERE id IN (${placeholders})`,
      ids
    ) as any[];
    return rows as Array<{
      id: number; seller_id: number; name: string;
      price: number; stock: number; status: string;
    }>;
  },

  // 在庫減算（トランザクション内で使用）
  async decrementStock(conn: PoolConnection, productId: number, quantity: number) {
    const [result] = await conn.query(
      `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`,
      [quantity, productId, quantity]
    ) as any[];
    return result.affectedRows as number; // 0 = 在庫不足
  },
```

**`AND stock >= ?` の役割**：`WHERE id = ? AND stock >= ?` を付けることで、在庫が足りない場合は UPDATE が0行になる（在庫不足を検知できる）。`SELECT` で確認してから別の `UPDATE` を実行する分割パターンは並行リクエストで競合が起きる（Phase 7で詳細）。Phase 6 では原子的 UPDATE で実装し、Phase 7 でロックと楽観的ロックを追加する。

---

### 4-5. services/ - orderService

`src/services/orderService.ts` を作成：

```typescript
import { pool } from '../db/connection.js';
import { orderRepository } from '../repositories/orderRepository.js';
import { productRepository } from '../repositories/productRepository.js';
import {
  NotFoundError,
  ForbiddenError,
  UnprocessableEntityError,
} from '../errors/AppError.js';

type ItemInput = { product_id: number; quantity: number };

// JOIN 結果を1注文オブジェクトに集約するヘルパー
function groupByOrderId(rows: any[]) {
  if (rows.length === 0) return null;
  const order = {
    id: rows[0].id,
    buyer_id: rows[0].buyer_id,
    status: rows[0].status,
    subtotal: rows[0].subtotal,
    shipping_fee: rows[0].shipping_fee,
    total_amount: rows[0].total_amount,
    created_at: rows[0].created_at,
    items: rows.map(r => ({
      id: r.item_id,
      product_id: r.product_id,
      seller_id: r.seller_id,
      product_name: r.product_name,
      unit_price: r.unit_price,
      quantity: r.quantity,
      subtotal: r.item_subtotal,
    })),
  };
  return order;
}

// 複数注文の JOIN 結果を注文配列に集約するヘルパー
function groupAllByOrderId(rows: any[]) {
  const map = new Map<number, ReturnType<typeof groupByOrderId>>();
  for (const r of rows) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        id: r.id, buyer_id: r.buyer_id, status: r.status,
        subtotal: r.subtotal, shipping_fee: r.shipping_fee,
        total_amount: r.total_amount, created_at: r.created_at,
        items: [],
      });
    }
    map.get(r.id)!.items.push({
      id: r.item_id,
      product_id: r.product_id,
      seller_id: r.seller_id,
      product_name: r.product_name,
      unit_price: r.unit_price,
      quantity: r.quantity,
      subtotal: r.item_subtotal,
    });
  }
  return Array.from(map.values());
}

export const orderService = {
  // 注文内容確認（価格はサーバーが DB から取得して計算）
  async preview(items: ItemInput[]) {
    const productIds = items.map(i => i.product_id);
    const products = await productRepository.findByIds(productIds);

    // 送られてきた product_id が全て存在・販売中か確認
    const productMap = new Map(products.map(p => [p.id, p]));
    for (const item of items) {
      const product = productMap.get(item.product_id);
      if (!product) throw new NotFoundError(`商品 ID:${item.product_id} が見つかりません`);
      if (product.status !== 'published') {
        throw new UnprocessableEntityError(`商品「${product.name}」は現在販売停止中です`);
      }
      if (product.stock < item.quantity) {
        throw new UnprocessableEntityError(`商品「${product.name}」の在庫が不足しています`);
      }
    }

    const previewItems = items.map(item => {
      const product = productMap.get(item.product_id)!;
      return {
        product_id: product.id,
        product_name: product.name,
        unit_price: product.price,
        quantity: item.quantity,
        subtotal: product.price * item.quantity,
      };
    });

    const subtotal = previewItems.reduce((sum, i) => sum + i.subtotal, 0);
    const shippingFee = 0; // Phase 6 では固定0円
    const totalAmount = subtotal + shippingFee;

    return { items: previewItems, subtotal, shipping_fee: shippingFee, total_amount: totalAmount };
  },

  // 注文確定（トランザクション内で在庫確認→注文作成→在庫減算）
  async createOrder(buyerId: number, idempotencyKey: string, items: ItemInput[]) {
    // 同じ idempotency_key の注文が既にある場合は既存注文を返す（冪等性）
    const existing = await orderRepository.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      const rows = await orderRepository.findById(existing.id);
      return groupByOrderId(rows)!;
    }

    // DB から最新価格・在庫を取得（クライアント送信価格は一切使わない）
    const productIds = items.map(i => i.product_id);
    const products = await productRepository.findByIds(productIds);
    const productMap = new Map(products.map(p => [p.id, p]));

    for (const item of items) {
      const product = productMap.get(item.product_id);
      if (!product) throw new NotFoundError(`商品 ID:${item.product_id} が見つかりません`);
      if (product.status !== 'published') {
        throw new UnprocessableEntityError(`商品「${product.name}」は現在販売停止中です`);
      }
      if (product.stock < item.quantity) {
        throw new UnprocessableEntityError(`商品「${product.name}」の在庫が不足しています`);
      }
    }

    const orderItemsData = items.map(item => {
      const product = productMap.get(item.product_id)!;
      return {
        productId: product.id,
        sellerId: product.seller_id,
        productName: product.name,  // 注文時点の商品名をコピー
        unitPrice: product.price, // 注文時点の価格をコピー（DB から取得した値）
        quantity: item.quantity,
        subtotal: product.price * item.quantity,
      };
    });

    const subtotal = orderItemsData.reduce((sum, i) => sum + i.subtotal, 0);
    const shippingFee = 0;
    const totalAmount = subtotal + shippingFee;

    // トランザクション開始
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. orders テーブルに INSERT
      const orderId = await orderRepository.createOrder(conn, {
        buyerId,
        subtotal,
        shippingFee,
        totalAmount,
        idempotencyKey,
      });

      // 2. order_items テーブルに一括 INSERT
      await orderRepository.createOrderItems(
        conn,
        orderItemsData.map(i => ({ orderId, ...i }))
      );

      // 3. 在庫を減算（原子的 UPDATE：stock が足りなければ affectedRows = 0）
      for (const item of items) {
        const affected = await productRepository.decrementStock(conn, item.product_id, item.quantity);
        if (affected === 0) {
          // COMMIT 前に在庫不足を検知 → ROLLBACK して注文を取り消す
          await conn.rollback();
          const product = productMap.get(item.product_id)!;
          throw new UnprocessableEntityError(`商品「${product.name}」の在庫が不足しています`);
        }
      }

      await conn.commit();

      const rows = await orderRepository.findById(orderId);
      return groupByOrderId(rows)!;
    } catch (error) {
      // エラー発生時は ROLLBACK（COMMIT 前の変更をすべて取り消す）
      await conn.rollback();
      throw error;
    } finally {
      // 必ず接続をプールに返す（返さないとコネクションリークが起きる）
      conn.release();
    }
  },

  async getMyOrders(buyerId: number, limit: number, offset: number) {
    const [rows, total] = await Promise.all([
      orderRepository.findByBuyerId(buyerId, limit, offset),
      orderRepository.countByBuyerId(buyerId),
    ]);
    return { data: groupAllByOrderId(rows), total };
  },

  async getOrderById(orderId: number, requesterId: number) {
    const rows = await orderRepository.findById(orderId);
    if (rows.length === 0) throw new NotFoundError('注文が見つかりません');

    const order = groupByOrderId(rows)!;
    // 自分の注文以外は 403
    if (order.buyer_id !== requesterId) throw new ForbiddenError('この注文にアクセスする権限がありません');
    return order;
  },
};
```

**トランザクションの役割**：

```
トランザクションなし（危険）：
  orders INSERT → 成功
  order_items INSERT → サーバークラッシュ
  → orders レコードがあるのに明細が空という不整合状態になる

トランザクションあり（安全）：
  BEGIN
  orders INSERT     → 成功
  order_items INSERT → サーバークラッシュ
  → 自動 ROLLBACK → orders も消える → 整合性が保たれる
```

**`conn.release()` を `finally` で呼ぶ理由**：  
`try` ブロックで例外が投げられても `finally` は必ず実行される。`release()` を忘れると接続がプールに戻らず、一定時間後に接続が枯渇して新しいリクエストが処理できなくなる（コネクションリーク）。

**`preview` と `createOrder` で同じバリデーションを繰り返す理由**：  
preview 後に price が変わる・在庫が減るケースがある。`createOrder` 時に改めて DB から最新値を取得してバリデーションし直すことで、preview の結果を信頼しない設計を維持する。

---

### 4-6. controllers/ - orderController

`src/controllers/orderController.ts` を作成：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { orderService } from '../services/orderService.js';
import {
  orderPreviewSchema,
  createOrderSchema,
  getOrdersQuerySchema,
  getOrderParamsSchema,
} from '../schemas/orderSchema.js';

export const orderController = {
  async preview(req: Request, res: Response, next: NextFunction) {
    try {
      const body = orderPreviewSchema.parse(req.body);
      const result = await orderService.preview(body.items);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const body = createOrderSchema.parse(req.body);
      const order = await orderService.createOrder(
        req.user!.id,
        body.idempotency_key,
        body.items
      );
      res.status(201).json(order);
    } catch (error) {
      next(error);
    }
  },

  async myOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const query = getOrdersQuerySchema.parse(req.query);
      const result = await orderService.getMyOrders(req.user!.id, query.limit, query.offset);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  async show(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = getOrderParamsSchema.parse(req.params);
      const order = await orderService.getOrderById(id, req.user!.id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  },
};
```

---

### 4-7. routes/ - 注文ルーター定義

`src/routes/orderRoutes.ts` を作成：

```typescript
import { Router } from 'express';
import { orderController } from '../controllers/orderController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

router.post('/preview', authenticate, orderController.preview);
router.post('/', authenticate, orderController.create);

export default router;
```

`src/routes/userRoutes.ts` に購入履歴ルートを追記：

```typescript
import { orderController } from '../controllers/orderController.js';

router.get('/me/orders', authenticate, orderController.myOrders);
```

`src/routes/orderDetailRoutes.ts` を作成：

```typescript
import { Router } from 'express';
import { orderController } from '../controllers/orderController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

router.get('/:id', authenticate, orderController.show);

export default router;
```

---

### 4-8. app.ts にルーター登録

```typescript
import orderRoutes from './routes/orderRoutes.js';
import orderDetailRoutes from './routes/orderDetailRoutes.js';

app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/orders', orderDetailRoutes);
```

**`/me/orders` を `userRoutes` に入れる理由**：`/me/*` 系エンドポイントは「認証済み自分のリソース」を表す命名規則で統一している。`/orders` ルーターは `/orders/preview`・`POST /orders`・`GET /orders/:id` を担当する。

---

### 4-9. 動作確認

```bash
# ログインしてトークン取得
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"seller@example.com","password":"password123"}' | jq -r .token)

# 注文内容確認（preview）
curl -X POST http://localhost:3000/api/v1/orders/preview \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"items":[{"product_id":1,"quantity":1}]}'
# → {"items":[{"product_id":1,"product_name":"iPhone 14","unit_price":80000,...}],"subtotal":80000,...}

# 注文確定
curl -X POST http://localhost:3000/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"idempotency_key":"test-key-001","items":[{"product_id":1,"quantity":1}]}'
# → {"id":1,"status":"pending","subtotal":80000,...}

# 同じ idempotency_key で再送（冪等性確認）
curl -X POST http://localhost:3000/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"idempotency_key":"test-key-001","items":[{"product_id":1,"quantity":1}]}'
# → 同じ注文オブジェクトが返る（2件目は作成されない）

# 購入履歴
curl http://localhost:3000/api/v1/me/orders \
  -H "Authorization: Bearer $TOKEN"
# → {"data":[{"id":1,...}],"total":1}

# 注文詳細
curl http://localhost:3000/api/v1/orders/1 \
  -H "Authorization: Bearer $TOKEN"
# → {"id":1,"status":"pending","items":[...],...}

# 在庫確認（減算されていること）
mysql market -e "SELECT id, name, stock FROM products WHERE id = 1;"
# stock が 1 → 0 になっていること確認
```

---

## 5. Flutter連携

### 5-1. Order モデル定義

`lib/features/order/data/order.dart`：

```dart
class OrderItem {
  final int id;
  final int productId;
  final int sellerId;
  final String productName;
  final int unitPrice;
  final int quantity;
  final int subtotal;

  OrderItem({
    required this.id,
    required this.productId,
    required this.sellerId,
    required this.productName,
    required this.unitPrice,
    required this.quantity,
    required this.subtotal,
  });

  factory OrderItem.fromJson(Map<String, dynamic> json) => OrderItem(
    id: json['id'],
    productId: json['product_id'],
    sellerId: json['seller_id'],
    productName: json['product_name'],
    unitPrice: json['unit_price'],
    quantity: json['quantity'],
    subtotal: json['subtotal'],
  );
}

class Order {
  final int id;
  final int buyerId;
  final String status;
  final int subtotal;
  final int shippingFee;
  final int totalAmount;
  final String createdAt;
  final List<OrderItem> items;

  Order({
    required this.id,
    required this.buyerId,
    required this.status,
    required this.subtotal,
    required this.shippingFee,
    required this.totalAmount,
    required this.createdAt,
    required this.items,
  });

  factory Order.fromJson(Map<String, dynamic> json) => Order(
    id: json['id'],
    buyerId: json['buyer_id'],
    status: json['status'],
    subtotal: json['subtotal'],
    shippingFee: json['shipping_fee'],
    totalAmount: json['total_amount'],
    createdAt: json['created_at'],
    items: (json['items'] as List)
        .map((e) => OrderItem.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}
```

---

### 5-2. OrderRepository（Flutter）

`lib/features/order/data/order_repository.dart`：

```dart
import 'package:uuid/uuid.dart';
import '../../../core/api/dio_client.dart';
import 'order.dart';

// pubspec.yaml に追加: uuid: ^4.0.0
const _uuid = Uuid();

class OrderRepository {
  // 注文内容確認（preview）
  Future<Map<String, dynamic>> preview(List<Map<String, dynamic>> items) async {
    final response = await dio.post('/orders/preview', data: {'items': items});
    return response.data as Map<String, dynamic>;
  }

  // 注文確定（idempotency_key は呼び出し元で生成して渡す）
  Future<Order> createOrder(String idempotencyKey, List<Map<String, dynamic>> items) async {
    final response = await dio.post('/orders', data: {
      'idempotency_key': idempotencyKey,
      'items': items,
    });
    return Order.fromJson(response.data as Map<String, dynamic>);
  }

  // 購入履歴
  Future<Map<String, dynamic>> getMyOrders({int limit = 20, int offset = 0}) async {
    final response = await dio.get('/me/orders', queryParameters: {
      'limit': limit, 'offset': offset,
    });
    return response.data as Map<String, dynamic>;
  }

  // 注文詳細
  Future<Order> getOrderById(int id) async {
    final response = await dio.get('/orders/$id');
    return Order.fromJson(response.data as Map<String, dynamic>);
  }
}
```

**`uuid` パッケージを使う理由**：`idempotency_key` は Flutter 側で注文リクエストの前に生成する。UUID v4（ランダム）を使うことで各注文に一意なキーを割り当て、通信失敗時に同じキーで再送してもサーバー側で同一リクエストとして認識できる。

---

### 5-3. 注文確認画面（preview）

`lib/features/order/ui/order_preview_screen.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';
import '../data/order_repository.dart';
import 'order_complete_screen.dart';

class OrderPreviewScreen extends StatefulWidget {
  final List<Map<String, dynamic>> items; // [{'product_id': 1, 'quantity': 1}, ...]

  const OrderPreviewScreen({super.key, required this.items});
  @override
  State<OrderPreviewScreen> createState() => _OrderPreviewScreenState();
}

class _OrderPreviewScreenState extends State<OrderPreviewScreen> {
  final _repo = OrderRepository();
  Map<String, dynamic>? _preview;
  bool _isLoading = true;
  bool _isOrdering = false;
  String? _error;

  // 注文前に生成した idempotency_key をこの画面のライフサイクルに紐づける
  // ページが再描画されても同じキーを使い続ける（通信失敗時の再送に備える）
  final _idempotencyKey = const Uuid().v4();

  @override
  void initState() {
    super.initState();
    _loadPreview();
  }

  Future<void> _loadPreview() async {
    try {
      final preview = await _repo.preview(widget.items);
      setState(() { _preview = preview; _isLoading = false; });
    } catch (e) {
      setState(() { _error = '内容の取得に失敗しました'; _isLoading = false; });
    }
  }

  Future<void> _confirmOrder() async {
    if (_preview == null) return;
    setState(() { _isOrdering = true; });
    try {
      final order = await _repo.createOrder(_idempotencyKey, widget.items);
      if (mounted) {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(builder: (_) => OrderCompleteScreen(order: order)),
        );
      }
    } catch (e) {
      setState(() { _error = '注文に失敗しました。もう一度お試しください。'; _isOrdering = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Scaffold(body: Center(child: CircularProgressIndicator()));

    return Scaffold(
      appBar: AppBar(title: const Text('注文確認')),
      body: Column(
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(8),
              child: Text(_error!, style: const TextStyle(color: Colors.red)),
            ),
          if (_preview != null) ...[
            Expanded(
              child: ListView.builder(
                itemCount: (_preview!['items'] as List).length,
                itemBuilder: (context, i) {
                  final item = (_preview!['items'] as List)[i] as Map<String, dynamic>;
                  return ListTile(
                    title: Text(item['product_name'] as String),
                    subtitle: Text('¥${item['unit_price']} × ${item['quantity']}'),
                    trailing: Text('¥${item['subtotal']}'),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                    const Text('小計'),
                    Text('¥${_preview!['subtotal']}'),
                  ]),
                  Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                    const Text('送料'),
                    Text('¥${_preview!['shipping_fee']}'),
                  ]),
                  const Divider(),
                  Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                    const Text('合計', style: TextStyle(fontWeight: FontWeight.bold)),
                    Text('¥${_preview!['total_amount']}',
                        style: const TextStyle(fontWeight: FontWeight.bold)),
                  ]),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: _isOrdering
                      ? const Center(child: CircularProgressIndicator())
                      : ElevatedButton(onPressed: _confirmOrder, child: const Text('注文を確定する')),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
```

**なぜ `_idempotencyKey` を `initState` より前（フィールドの宣言時）に生成するか**：  
`initState` は `build` より先に呼ばれるが、`StatefulWidget` が再生成されても `State` オブジェクトは使い回されるため `_idempotencyKey` は変わらない。注文確定ボタンを押して失敗 → リトライしても同じキーが送られる。これにより「ユーザーが2回タップ」や「通信失敗後の再送」で注文が2件作られるのを防ぐ。

---

### 5-4. 注文完了画面

`lib/features/order/ui/order_complete_screen.dart`：

```dart
import 'package:flutter/material.dart';
import '../data/order.dart';

class OrderCompleteScreen extends StatelessWidget {
  final Order order;

  const OrderCompleteScreen({super.key, required this.order});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('注文完了')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.check_circle, color: Colors.green, size: 64),
            const SizedBox(height: 16),
            Text('注文 #${order.id} が確定しました',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            Text('合計：¥${order.totalAmount}'),
            Text('ステータス：${order.status}'),
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () =>
                    Navigator.pushNamedAndRemoveUntil(context, '/products', (r) => false),
                child: const Text('ショッピングを続ける'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
```

---

### 5-5. 購入履歴画面

`lib/features/order/ui/order_history_screen.dart`：

```dart
import 'package:flutter/material.dart';
import '../data/order_repository.dart';
import '../data/order.dart';

class OrderHistoryScreen extends StatefulWidget {
  const OrderHistoryScreen({super.key});
  @override
  State<OrderHistoryScreen> createState() => _OrderHistoryScreenState();
}

class _OrderHistoryScreenState extends State<OrderHistoryScreen> {
  final _repo = OrderRepository();
  List<Order> _orders = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await _repo.getMyOrders();
      final list = result['data'] as List;
      setState(() {
        _orders = list.map((e) => Order.fromJson(e as Map<String, dynamic>)).toList();
        _isLoading = false;
      });
    } catch (e) {
      setState(() { _error = 'データの取得に失敗しました'; _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!));
    if (_orders.isEmpty) return const Center(child: Text('購入履歴はありません'));

    return ListView.builder(
      itemCount: _orders.length,
      itemBuilder: (context, i) {
        final o = _orders[i];
        return ListTile(
          title: Text('注文 #${o.id}'),
          subtitle: Text('¥${o.totalAmount} · ${o.status}'),
          trailing: Text(o.createdAt.substring(0, 10)), // yyyy-MM-dd
          onTap: () {
            // 注文詳細画面へ遷移（実装省略）
          },
        );
      },
    );
  }
}
```

---

## 確認チェックリスト

Phase 6 完了の判断基準：

```
[ ] migrations/011_create_orders.sql が実行済みで orders テーブルが存在する
[ ] migrations/012_create_order_items.sql が実行済みで order_items テーブルが存在する
[ ] POST /orders/preview がサーバー計算の価格・合計を返す
[ ] POST /orders で注文が作成される（orders + order_items にレコードが挿入される）
[ ] POST /orders 後に対象商品の stock が減算されている
[ ] 在庫不足の商品を注文すると 422 が返る
[ ] 販売停止商品を注文すると 422 が返る
[ ] 同じ idempotency_key で2回 POST /orders を送っても注文が1件しか作成されない
[ ] GET /me/orders で購入履歴が返る
[ ] GET /orders/:id で注文詳細が返る
[ ] GET /orders/:id で他人の注文を取得しようとすると 403 が返る
[ ] トランザクション中にエラーが発生した場合 orders・order_items のどちらも保存されない
[ ] openapi.yaml に /orders/preview・/orders・/me/orders・/orders/{id} が定義されている
[ ] Flutter の注文確認画面でサーバーが計算した価格が表示される
[ ] Flutter で注文確定後に注文完了画面に遷移する
[ ] Flutter の購入履歴画面で注文一覧が表示される
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|---|---|
| クライアント価格を信用しない | リクエストボディの price を使わず、サーバーが DB から取得して計算する理由 |
| スナップショット保存 | `order_items.unit_price`・`product_name` に注文時点の値をコピーする設計。正規化（JOIN で最新値を参照）との違いと使い分け |
| トランザクション | `BEGIN`→処理→`COMMIT` or `ROLLBACK` の流れ。複数テーブルの変更を原子的に行う意味 |
| コネクション管理 | `pool.getConnection()` → `conn.release()` の対応。`finally` で必ず解放する理由（コネクションリーク防止） |
| 冪等性 | 同じ `idempotency_key` のリクエストを何度送っても結果が変わらない設計。通信障害時のリトライに対応できる |
| 原子的 UPDATE | `UPDATE ... WHERE stock >= ?` で在庫確認と減算を1クエリで行う理由。`SELECT` → `UPDATE` の2ステップが危険な理由（Phase 7 で詳細） |
| 422 vs 400 | バリデーションエラー（形式）と業務ルール違反（在庫不足など）のステータスコード使い分け |
