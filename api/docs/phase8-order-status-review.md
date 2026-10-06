# Phase 8 - 注文状態・配送・レビュー 詳細作業ログ

## 概要

Phase 7 で在庫競合制御を実装した。
Phase 8 では注文の状態遷移管理・配送・支払い・レビュー・監査ログを追加する。

- 状態遷移マップで「許可された遷移のみ通す」バリデーション
- `order_status_histories` で全ての状態変更を履歴として保存
- `shipments`・`payments` を注文に紐付けて作成
- レビュー投稿条件（本人 / completed / 未投稿）を Service + DB UNIQUE 制約で二重保証
- `audit_logs` に注文状態変更を記録するユーティリティ

---

## 注文ステータス遷移

```
               ┌──────────┐
               │ pending  │─────────────────────────┐
               └────┬─────┘                         │
                    │ /pay（簡易決済）               │ /cancel
                    ▼                               ▼
               ┌──────────┐                 ┌─────────────┐
               │   paid   │─────────────────│  cancelled  │
               └────┬─────┘   /cancel       └─────────────┘
                    │ /prepare（出品者）
                    ▼
               ┌──────────────┐
               │  preparing   │
               └──────┬───────┘
                      │ /ship（出品者）
                      ▼
               ┌──────────┐
               │  shipped │
               └────┬─────┘
                    │ /deliver（配送業者 or 管理者）
                    ▼
               ┌───────────┐
               │ delivered │
               └─────┬─────┘
                     │ /receive（購入者）
                     ▼
               ┌───────────┐
               │ completed │（レビュー可）
               └───────────┘
```

**後戻り禁止**：`paid → pending`・`shipped → preparing` など逆方向の遷移はすべて 422 で弾く。

---

## 新規パッケージ

Phase 8 では新規パッケージは不要。Phase 2〜7 までのパッケージで実装できる。

---

## 2. DB（テーブル作成）

### 2-1. migrations/014_create_order_status_histories.sql

```sql
CREATE TABLE order_status_histories (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  from_status VARCHAR(20) NOT NULL,
  to_status VARCHAR(20) NOT NULL,
  changed_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (changed_by) REFERENCES users(id)
);
```

実行：

```bash
mysql market < migrations/014_create_order_status_histories.sql
```

確認：

```bash
mysql market -e "DESCRIBE order_status_histories;"
```

| カラム | 理由 |
|---|---|
| `from_status` | 遷移前のステータス。「いつ誰が何から何に変えたか」を完全に記録するため両方保存 |
| `changed_by` | システム操作（管理者）かユーザー操作かを記録。将来の監査に使える |

**なぜ `order_status_histories` が必要か**：  
`orders.status` は現在値しか持てない。過去に `pending → paid → cancelled` と遷移した場合、`status = 'cancelled'` しか残らず「いつ支払いが完了したか」が追跡できない。履歴テーブルを持つことで遷移の全記録が残る。

---

### 2-2. migrations/015_create_shipments.sql

```sql
CREATE TABLE shipments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL UNIQUE,
  tracking_number VARCHAR(100),
  shipped_at DATETIME,
  delivered_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
```

実行：

```bash
mysql market < migrations/015_create_shipments.sql
```

確認：

```bash
mysql market -e "DESCRIBE shipments;"
```

| カラム | 理由 |
|---|---|
| `order_id UNIQUE` | 1注文に対して配送情報は1件 |
| `tracking_number` | NULLABLEにする理由：発送前の配送レコード作成時はまだ追跡番号がない |
| `delivered_at` | NULL = 未配達。管理者・配送業者が更新する（Phase 8 では省略） |

---

### 2-3. migrations/016_create_payments.sql

```sql
CREATE TABLE payments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL UNIQUE,
  amount BIGINT UNSIGNED NOT NULL,
  method VARCHAR(50) NOT NULL DEFAULT 'card',
  status ENUM('pending', 'completed', 'refunded') NOT NULL DEFAULT 'pending',
  paid_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
```

実行：

```bash
mysql market < migrations/016_create_payments.sql
```

確認：

```bash
mysql market -e "DESCRIBE payments;"
```

**Phase 8 での支払い実装方針**：実際の決済ゲートウェイ（Stripe 等）との連携は対象外。`POST /orders/:id/pay` で payments レコードを作成して `paid_at` をセットする簡略実装とする。

---

### 2-4. migrations/017_create_reviews.sql

```sql
CREATE TABLE reviews (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  reviewer_id INT UNSIGNED NOT NULL,
  rating TINYINT UNSIGNED NOT NULL,
  comment TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (order_id, product_id, reviewer_id),
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (reviewer_id) REFERENCES users(id)
);
```

実行：

```bash
mysql market < migrations/017_create_reviews.sql
```

確認：

```bash
mysql market -e "DESCRIBE reviews;"
```

| 制約 | 理由 |
|---|---|
| `UNIQUE(order_id, product_id, reviewer_id)` | 1注文につき同一商品へのレビューは1件のみ。DB 制約で二重投稿を防ぐ |
| `CHECK(rating BETWEEN 1 AND 5)` | 不正な評価値をDB側で弾く。アプリ側バリデーションの二重保護 |

**`UNIQUE` の複合キーに `reviewer_id` を含める理由**：`UNIQUE(order_id, product_id)` だけにすると「同じ注文の同じ商品に対して購入者と出品者が別々にレビューできてしまう」。`reviewer_id` を加えることで「1ユーザーが1注文の1商品に1件だけ」を正確に表現できる。

---

### 2-5. migrations/018_create_audit_logs.sql

```sql
CREATE TABLE audit_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50) NOT NULL,
  target_id INT UNSIGNED NOT NULL,
  detail JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

実行：

```bash
mysql market < migrations/018_create_audit_logs.sql
```

確認：

```bash
mysql market -e "DESCRIBE audit_logs;"
```

| カラム | 例 |
|---|---|
| `action` | `'order_status_changed'`・`'review_posted'` |
| `target_type` | `'orders'`・`'products'` |
| `target_id` | 対象レコードの id |
| `detail JSON` | `{"from":"pending","to":"paid"}` など自由形式の補足情報 |

---

## 3. OpenAPI（仕様追加）

### 3-1. 注文状態遷移エンドポイント定義追加

`openapi.yaml` の `paths:` に追記：

```yaml
  /orders/{orderId}/pay:
    post:
      summary: 決済（pending → paid）
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
        '422':
          $ref: '#/components/responses/UnprocessableEntity'

  /orders/{orderId}/prepare:
    post:
      summary: 発送準備（paid → preparing、出品者のみ）
      security:
        - BearerAuth: []
      parameters:
        - $ref: '#/components/parameters/OrderId'
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
        '422':
          $ref: '#/components/responses/UnprocessableEntity'

  /orders/{orderId}/ship:
    post:
      summary: 発送登録（preparing → shipped、出品者のみ）
      security:
        - BearerAuth: []
      parameters:
        - $ref: '#/components/parameters/OrderId'
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                tracking_number:
                  type: string
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
        '422':
          $ref: '#/components/responses/UnprocessableEntity'

  /orders/{orderId}/deliver:
    post:
      summary: 配達完了（shipped → delivered）
      security:
        - BearerAuth: []
      parameters:
        - $ref: '#/components/parameters/OrderId'
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'

  /orders/{orderId}/receive:
    post:
      summary: 受取確認（delivered → completed、購入者のみ）
      security:
        - BearerAuth: []
      parameters:
        - $ref: '#/components/parameters/OrderId'
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
        '422':
          $ref: '#/components/responses/UnprocessableEntity'

  /orders/{orderId}/cancel:
    post:
      summary: キャンセル（pending → cancelled、paid → refund_pending）
      security:
        - BearerAuth: []
      parameters:
        - $ref: '#/components/parameters/OrderId'
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
        '422':
          $ref: '#/components/responses/UnprocessableEntity'
```

### 3-2. レビューエンドポイント追加

```yaml
  /products/{productId}/reviews:
    post:
      summary: レビュー投稿（completed 注文の購入者のみ）
      security:
        - BearerAuth: []
      parameters:
        - name: productId
          in: path
          required: true
          schema:
            type: integer
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [order_id, rating]
              properties:
                order_id:
                  type: integer
                rating:
                  type: integer
                  minimum: 1
                  maximum: 5
                comment:
                  type: string
      responses:
        '201':
          description: 投稿成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Review'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '409':
          $ref: '#/components/responses/Conflict'
        '422':
          $ref: '#/components/responses/UnprocessableEntity'

    get:
      summary: レビュー一覧取得
      parameters:
        - name: productId
          in: path
          required: true
          schema:
            type: integer
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
                      $ref: '#/components/schemas/Review'
                  total:
                    type: integer
                  avg_rating:
                    type: number
                    format: float
```

### 3-3. Review スキーマ・OrderId パラメータ追加

`components/schemas:` に追記：

```yaml
    Review:
      type: object
      properties:
        id:
          type: integer
        order_id:
          type: integer
        product_id:
          type: integer
        reviewer_id:
          type: integer
        rating:
          type: integer
          minimum: 1
          maximum: 5
        comment:
          type: string
          nullable: true
        created_at:
          type: string
          format: date-time
```

`components/parameters:` を追加（重複定義を避ける）：

```yaml
  parameters:
    OrderId:
      name: orderId
      in: path
      required: true
      schema:
        type: integer
```

---

## 4. API実装（注文状態）

### 4-1. 状態遷移マップ定義

`src/services/orderStatusService.ts` を作成（冒頭に遷移マップを定義）：

```typescript
import { pool } from '../db/connection.js';
import { orderRepository } from '../repositories/orderRepository.js';
import { ForbiddenError, NotFoundError, UnprocessableEntityError } from '../errors/AppError.js';
import { recordAuditLog } from '../utils/auditLog.js';

type OrderStatus =
  | 'pending' | 'paid' | 'preparing' | 'shipped'
  | 'delivered' | 'completed' | 'cancelled' | 'refund_pending';

// 各ステータスから遷移可能なステータスのマップ
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['preparing', 'refund_pending'],
  preparing: ['shipped'],
  shipped: ['delivered'],
  delivered: ['completed'],
  completed: [],  // 終端
  cancelled: [],  // 終端
  refund_pending: [],  // 終端
};

function assertTransition(from: string, to: OrderStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from as OrderStatus] ?? [];
  if (!allowed.includes(to)) {
    throw new UnprocessableEntityError(
      `ステータス「${from}」から「${to}」への遷移は許可されていません`
    );
  }
}
```

**状態遷移マップを定数で持つ理由**：`if/switch` の分岐を全エンドポイントに散在させると、遷移ルールの変更時に全箇所を修正する必要がある。マップを1箇所に集約することで変更が容易になる。

---

### 4-2. schemas/ - 注文状態変更バリデーション

`src/schemas/orderStatusSchema.ts` を作成：

```typescript
import { z } from 'zod';

export const orderParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const shipOrderSchema = z.object({
  tracking_number: z.string().max(100).optional(),
});
```

---

### 4-3. repositories/ - orderStatusRepository

`src/repositories/orderStatusRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';
import type { PoolConnection } from 'mysql2/promise';

export const orderStatusRepository = {
  // 状態更新 + 履歴記録をトランザクション内で実行
  async transitionStatus(
    orderId: number,
    toStatus: string,
    changedBy: number,
    fromStatus: string
  ) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE orders SET status = ? WHERE id = ?`,
        [toStatus, orderId]
      );
      await conn.query(
        `INSERT INTO order_status_histories (order_id, from_status, to_status, changed_by)
         VALUES (?, ?, ?, ?)`,
        [orderId, fromStatus, toStatus, changedBy]
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  },

  async findHistoriesByOrderId(orderId: number) {
    const [rows] = await pool.query(
      `SELECT id, order_id, from_status, to_status, changed_by, created_at
       FROM order_status_histories
       WHERE order_id = ?
       ORDER BY created_at ASC`,
      [orderId]
    ) as any[];
    return rows;
  },
};
```

---

### 4-4. repositories/ - shipmentRepository・paymentRepository

`src/repositories/shipmentRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';
import type { PoolConnection } from 'mysql2/promise';

export const shipmentRepository = {
  async create(conn: PoolConnection, orderId: number, trackingNumber?: string) {
    await conn.query(
      `INSERT INTO shipments (order_id, tracking_number, shipped_at)
       VALUES (?, ?, NOW())`,
      [orderId, trackingNumber ?? null]
    );
  },

  async markDelivered(orderId: number) {
    await pool.query(
      `UPDATE shipments SET delivered_at = NOW() WHERE order_id = ?`,
      [orderId]
    );
  },

  async findByOrderId(orderId: number) {
    const [rows] = await pool.query(
      `SELECT * FROM shipments WHERE order_id = ?`,
      [orderId]
    ) as any[];
    return rows[0] ?? null;
  },
};
```

`src/repositories/paymentRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';

export const paymentRepository = {
  async create(orderId: number, amount: number) {
    await pool.query(
      `INSERT INTO payments (order_id, amount, status, paid_at)
       VALUES (?, ?, 'completed', NOW())`,
      [orderId, amount]
    );
  },

  async findByOrderId(orderId: number) {
    const [rows] = await pool.query(
      `SELECT * FROM payments WHERE order_id = ?`,
      [orderId]
    ) as any[];
    return rows[0] ?? null;
  },
};
```

---

### 4-5. utils/ - auditLog ユーティリティ

`src/utils/auditLog.ts` を作成：

```typescript
import { pool } from '../db/connection.js';

export async function recordAuditLog(
  userId: number,
  action: string,
  targetType: string,
  targetId: number,
  detail?: Record<string, unknown>
) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, detail)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, action, targetType, targetId, detail ? JSON.stringify(detail) : null]
    );
  } catch (err) {
    // 監査ログ記録の失敗はビジネス処理を止めない（fire-and-forget）
    console.error('[audit_log] 記録失敗:', err);
  }
}
```

**`try/catch` で握りつぶす理由**：監査ログの保存に失敗しても、注文状態変更そのものは成功している。ログ記録の失敗でユーザーにエラーを返すのは過剰。ただし `console.error` で記録し、運用監視で検知できるようにする。

---

### 4-6. services/ - orderStatusService（状態遷移ロジック）

`src/services/orderStatusService.ts` に続けて実装（4-1 の続き）：

```typescript
export const orderStatusService = {
  // 注文の取得（所有者チェック付き）
  async getOrder(orderId: number) {
    const rows = await orderRepository.findById(orderId);
    if (rows.length === 0) throw new NotFoundError('注文が見つかりません');
    return rows[0]; // flat な1行目（status, buyer_id などを使う）
  },

  // 決済（pending → paid）
  async pay(orderId: number, requesterId: number) {
    const order = await this.getOrder(orderId);
    if (order.buyer_id !== requesterId) throw new ForbiddenError('この注文を操作する権限がありません');
    assertTransition(order.status, 'paid');

    await orderStatusRepository.transitionStatus(orderId, 'paid', requesterId, order.status);
    await paymentRepository.create(orderId, order.total_amount);
    await recordAuditLog(requesterId, 'order_status_changed', 'orders', orderId, {
      from: order.status, to: 'paid',
    });

    const rows = await orderRepository.findById(orderId);
    return groupByOrderId(rows)!;
  },

  // 発送準備（paid → preparing、出品者のみ）
  async prepare(orderId: number, requesterId: number) {
    const order = await this.getOrder(orderId);
    assertTransition(order.status, 'preparing');
    await assertSeller(orderId, requesterId);

    await orderStatusRepository.transitionStatus(orderId, 'preparing', requesterId, order.status);
    await recordAuditLog(requesterId, 'order_status_changed', 'orders', orderId, {
      from: order.status, to: 'preparing',
    });

    const rows = await orderRepository.findById(orderId);
    return groupByOrderId(rows)!;
  },

  // 発送（preparing → shipped、出品者のみ、shipments レコード作成）
  async ship(orderId: number, requesterId: number, trackingNumber?: string) {
    const order = await this.getOrder(orderId);
    assertTransition(order.status, 'shipped');
    await assertSeller(orderId, requesterId);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`UPDATE orders SET status = 'shipped' WHERE id = ?`, [orderId]);
      await conn.query(
        `INSERT INTO order_status_histories (order_id, from_status, to_status, changed_by)
         VALUES (?, ?, 'shipped', ?)`,
        [orderId, order.status, requesterId]
      );
      await shipmentRepository.create(conn, orderId, trackingNumber);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await recordAuditLog(requesterId, 'order_status_changed', 'orders', orderId, {
      from: order.status, to: 'shipped', tracking_number: trackingNumber,
    });

    const rows = await orderRepository.findById(orderId);
    return groupByOrderId(rows)!;
  },

  // 配達完了（shipped → delivered）
  async deliver(orderId: number, requesterId: number) {
    const order = await this.getOrder(orderId);
    assertTransition(order.status, 'delivered');

    await orderStatusRepository.transitionStatus(orderId, 'delivered', requesterId, order.status);
    await shipmentRepository.markDelivered(orderId);
    await recordAuditLog(requesterId, 'order_status_changed', 'orders', orderId, {
      from: order.status, to: 'delivered',
    });

    const rows = await orderRepository.findById(orderId);
    return groupByOrderId(rows)!;
  },

  // 受取確認（delivered → completed、購入者のみ）
  async receive(orderId: number, requesterId: number) {
    const order = await this.getOrder(orderId);
    if (order.buyer_id !== requesterId) throw new ForbiddenError('この注文を操作する権限がありません');
    assertTransition(order.status, 'completed');

    await orderStatusRepository.transitionStatus(orderId, 'completed', requesterId, order.status);
    await recordAuditLog(requesterId, 'order_status_changed', 'orders', orderId, {
      from: order.status, to: 'completed',
    });

    const rows = await orderRepository.findById(orderId);
    return groupByOrderId(rows)!;
  },

  // キャンセル（pending → cancelled、paid → refund_pending）
  async cancel(orderId: number, requesterId: number) {
    const order = await this.getOrder(orderId);
    if (order.buyer_id !== requesterId) throw new ForbiddenError('この注文を操作する権限がありません');

    const toStatus: 'cancelled' | 'refund_pending' =
      order.status === 'paid' ? 'refund_pending' : 'cancelled';
    assertTransition(order.status, toStatus);

    await orderStatusRepository.transitionStatus(orderId, toStatus, requesterId, order.status);

    // cancelled の場合は在庫を戻す
    if (toStatus === 'cancelled') {
      await restoreStock(orderId);
    }

    await recordAuditLog(requesterId, 'order_status_changed', 'orders', orderId, {
      from: order.status, to: toStatus,
    });

    const rows = await orderRepository.findById(orderId);
    return groupByOrderId(rows)!;
  },
};

// 出品者チェックヘルパー
async function assertSeller(orderId: number, requesterId: number) {
  const [rows] = await pool.query(
    `SELECT DISTINCT seller_id FROM order_items WHERE order_id = ?`,
    [orderId]
  ) as any[];
  const sellerIds: number[] = rows.map((r: any) => r.seller_id);
  if (!sellerIds.includes(requesterId)) {
    throw new ForbiddenError('出品者のみ実行できます');
  }
}

// キャンセル時の在庫復元ヘルパー
async function restoreStock(orderId: number) {
  const [items] = await pool.query(
    `SELECT product_id, quantity FROM order_items WHERE order_id = ?`,
    [orderId]
  ) as any[];
  for (const item of items as Array<{ product_id: number; quantity: number }>) {
    await pool.query(
      `UPDATE products SET stock = stock + ?, version = version + 1 WHERE id = ?`,
      [item.quantity, item.product_id]
    );
  }
}

// orderRepository の groupByOrderId を再利用（import して使う）
function groupByOrderId(rows: any[]) {
  if (rows.length === 0) return null;
  const order = {
    id: rows[0].id, buyer_id: rows[0].buyer_id, status: rows[0].status,
    subtotal: rows[0].subtotal, shipping_fee: rows[0].shipping_fee,
    total_amount: rows[0].total_amount, created_at: rows[0].created_at,
    items: rows.map((r: any) => ({
      id: r.item_id, product_id: r.product_id, seller_id: r.seller_id,
      product_name: r.product_name, unit_price: r.unit_price,
      quantity: r.quantity, subtotal: r.item_subtotal,
    })),
  };
  return order;
}
```

**`groupByOrderId` の重複について**：`orderService.ts` と `orderStatusService.ts` に同じヘルパーを書くのは DRY 原則に反する。実際は `src/utils/orderUtils.ts` に切り出して両ファイルから import する。ここでは説明のため inline で示している。

**キャンセル時の在庫復元**：キャンセルで在庫を戻すとき `version` を+1 することで、同時購入中のトランザクションが持っていた古い `version` を無効化する（楽観的ロックの副作用として競合を誘発し、在庫の二重確保を防ぐ）。

---

### 4-7. controllers/ - orderStatusController

`src/controllers/orderStatusController.ts` を作成：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { orderStatusService } from '../services/orderStatusService.js';
import { orderParamsSchema, shipOrderSchema } from '../schemas/orderStatusSchema.js';

export const orderStatusController = {
  async pay(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = orderParamsSchema.parse(req.params);
      const order = await orderStatusService.pay(id, req.user!.id);
      res.json(order);
    } catch (e) { next(e); }
  },

  async prepare(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = orderParamsSchema.parse(req.params);
      const order = await orderStatusService.prepare(id, req.user!.id);
      res.json(order);
    } catch (e) { next(e); }
  },

  async ship(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = orderParamsSchema.parse(req.params);
      const { tracking_number} = shipOrderSchema.parse(req.body);
      const order = await orderStatusService.ship(id, req.user!.id, tracking_number);
      res.json(order);
    } catch (e) { next(e); }
  },

  async deliver(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = orderParamsSchema.parse(req.params);
      const order = await orderStatusService.deliver(id, req.user!.id);
      res.json(order);
    } catch (e) { next(e); }
  },

  async receive(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = orderParamsSchema.parse(req.params);
      const order = await orderStatusService.receive(id, req.user!.id);
      res.json(order);
    } catch (e) { next(e); }
  },

  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = orderParamsSchema.parse(req.params);
      const order = await orderStatusService.cancel(id, req.user!.id);
      res.json(order);
    } catch (e) { next(e); }
  },
};
```

---

### 4-8. routes/ - 注文状態ルート追加

`src/routes/orderDetailRoutes.ts` を更新：

```typescript
import { Router } from 'express';
import { orderController } from '../controllers/orderController.js';
import { orderStatusController } from '../controllers/orderStatusController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

router.get('/:id', authenticate, orderController.show);
router.post('/:id/pay', authenticate, orderStatusController.pay);
router.post('/:id/prepare', authenticate, orderStatusController.prepare);
router.post('/:id/ship', authenticate, orderStatusController.ship);
router.post('/:id/deliver', authenticate, orderStatusController.deliver);
router.post('/:id/receive', authenticate, orderStatusController.receive);
router.post('/:id/cancel', authenticate, orderStatusController.cancel);

export default router;
```

---

### 4-9. 動作確認（注文状態）

```bash
# ログイン（seller）
SELLER_TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"seller@example.com","password":"password123"}' | jq -r .token)

# ログイン（buyer）
BUYER_TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com","password":"password123"}' | jq -r .token)

# 注文作成（Phase 6 確認済み）
curl -X POST http://localhost:3000/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -d '{"idempotency_key":"status-test-001","items":[{"product_id":2,"quantity":1}]}'
# → {"id":X,"status":"pending",...}

ORDER_ID=X  # 上記 id を設定

# 決済（pending → paid）
curl -X POST http://localhost:3000/api/v1/orders/$ORDER_ID/pay \
  -H "Authorization: Bearer $BUYER_TOKEN"
# → {"status":"paid",...}

# 発送準備（paid → preparing、seller のみ）
curl -X POST http://localhost:3000/api/v1/orders/$ORDER_ID/prepare \
  -H "Authorization: Bearer $SELLER_TOKEN"
# → {"status":"preparing",...}

# 発送（preparing → shipped）
curl -X POST http://localhost:3000/api/v1/orders/$ORDER_ID/ship \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -d '{"tracking_number":"YM1234567890"}'
# → {"status":"shipped",...}

# 配達完了（shipped → delivered）
curl -X POST http://localhost:3000/api/v1/orders/$ORDER_ID/deliver \
  -H "Authorization: Bearer $SELLER_TOKEN"
# → {"status":"delivered",...}

# 受取確認（delivered → completed、buyer のみ）
curl -X POST http://localhost:3000/api/v1/orders/$ORDER_ID/receive \
  -H "Authorization: Bearer $BUYER_TOKEN"
# → {"status":"completed",...}

# 不正な遷移確認（completed → cancelled は 422）
curl -X POST http://localhost:3000/api/v1/orders/$ORDER_ID/cancel \
  -H "Authorization: Bearer $BUYER_TOKEN"
# → {"error":"ステータス「completed」から「cancelled」への遷移は許可されていません"}

# 状態変更履歴確認
mysql market -e "SELECT * FROM order_status_histories WHERE order_id = $ORDER_ID;"

# 監査ログ確認
mysql market -e "SELECT * FROM audit_logs WHERE target_id = $ORDER_ID AND target_type = 'orders';"

# 配送情報確認
mysql market -e "SELECT * FROM shipments WHERE order_id = $ORDER_ID;"
```

---

## 5. API実装（レビュー）

### 5-1. schemas/ - レビューバリデーション定義

`src/schemas/reviewSchema.ts` を作成：

```typescript
import { z } from 'zod';

export const createReviewSchema = z.object({
  order_id: z.number().int().positive(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

export const getReviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const productParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
```

---

### 5-2. repositories/ - reviewRepository

`src/repositories/reviewRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';

export const reviewRepository = {
  async create(data: {
    orderId: number;
    productId: number;
    reviewerId: number;
    rating: number;
    comment?: string;
  }) {
    const [result] = await pool.query(
      `INSERT INTO reviews (order_id, product_id, reviewer_id, rating, comment)
       VALUES (?, ?, ?, ?, ?)`,
      [data.orderId, data.productId, data.reviewerId, data.rating, data.comment ?? null]
    ) as any[];
    return result.insertId as number;
  },

  async findById(id: number) {
    const [rows] = await pool.query(
      `SELECT id, order_id, product_id, reviewer_id, rating, comment, created_at
       FROM reviews WHERE id = ?`,
      [id]
    ) as any[];
    return rows[0] ?? null;
  },

  // 同一注文・同一商品・同一ユーザーのレビューが既に存在するか
  async existsByOrderProductReviewer(orderId: number, productId: number, reviewerId: number) {
    const [rows] = await pool.query(
      `SELECT id FROM reviews
       WHERE order_id = ? AND product_id = ? AND reviewer_id = ?`,
      [orderId, productId, reviewerId]
    ) as any[];
    return rows.length > 0;
  },

  async findByProductId(productId: number, limit: number, offset: number) {
    const [rows] = await pool.query(
      `SELECT id, order_id, product_id, reviewer_id, rating, comment, created_at
       FROM reviews WHERE product_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [productId, limit, offset]
    ) as any[];
    return rows;
  },

  async countAndAvgByProductId(productId: number) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as total, AVG(rating) as avg_rating
       FROM reviews WHERE product_id = ?`,
      [productId]
    ) as any[];
    return {
      total: rows[0].total as number,
      avg_rating: rows[0].avg_rating ? Number(rows[0].avg_rating.toFixed(1)) : null,
    };
  },

  // 対象の order_item（注文に商品が含まれるか確認用）
  async findOrderItem(orderId: number, productId: number, buyerId: number) {
    const [rows] = await pool.query(
      `SELECT oi.id
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.order_id = ? AND oi.product_id = ? AND o.buyer_id = ?`,
      [orderId, productId, buyerId]
    ) as any[];
    return rows[0] ?? null;
  },

  // 注文ステータスの取得（completed か確認用）
  async findOrderStatus(orderId: number) {
    const [rows] = await pool.query(
      `SELECT status FROM orders WHERE id = ?`,
      [orderId]
    ) as any[];
    return rows[0]?.status as string | undefined;
  },
};
```

---

### 5-3. services/ - reviewService

`src/services/reviewService.ts` を作成：

```typescript
import { reviewRepository } from '../repositories/reviewRepository.js';
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  UnprocessableEntityError,
} from '../errors/AppError.js';
import { recordAuditLog } from '../utils/auditLog.js';

export const reviewService = {
  async createReview(
    productId: number,
    reviewerId: number,
    orderId: number,
    rating: number,
    comment?: string
  ) {
    // 条件1：注文が存在し、かつ購入者本人の注文か確認
    const orderItem = await reviewRepository.findOrderItem(orderId, productId, reviewerId);
    if (!orderItem) {
      throw new ForbiddenError('この注文でこの商品を購入していません');
    }

    // 条件2：注文が completed 状態か確認
    const orderStatus = await reviewRepository.findOrderStatus(orderId);
    if (orderStatus !== 'completed') {
      throw new UnprocessableEntityError(
        'レビューは注文が完了（completed）になってから投稿できます'
      );
    }

    // 条件3：既にレビュー済みでないか確認（DB UNIQUE 制約の前にアプリ側でも確認）
    const alreadyReviewed = await reviewRepository.existsByOrderProductReviewer(
      orderId, productId, reviewerId
    );
    if (alreadyReviewed) {
      throw new ConflictError('この注文の商品には既にレビューを投稿しています');
    }

    // INSERT（DB の UNIQUE 制約が二重投稿の最終防壁）
    const id = await reviewRepository.create({ orderId, productId, reviewerId, rating, comment });

    await recordAuditLog(reviewerId, 'review_posted', 'products', productId, {
      order_id: orderId, rating,
    });

    return reviewRepository.findById(id);
  },

  async getReviews(productId: number, limit: number, offset: number) {
    const [data, { total, avg_rating }] = await Promise.all([
      reviewRepository.findByProductId(productId, limit, offset),
      reviewRepository.countAndAvgByProductId(productId),
    ]);
    return { data, total, avg_rating };
  },
};
```

**アプリ側チェックと DB 制約の二重防護**：

| 防護層 | 手段 | 役割 |
|---|---|---|
| Service（アプリ） | `existsByOrderProductReviewer` で事前確認 | ユーザーフレンドリーなエラーメッセージを返す |
| DB | `UNIQUE(order_id, product_id, reviewer_id)` | 並行リクエストによる競合を最終的に防ぐ |

アプリ側だけでは並行リクエストで同時に「存在しない」と判定され二重投稿されうる。DB 制約だけでは「Duplicate entry エラー」をアプリが解釈してユーザー向けメッセージに変換する処理が必要になる。両方持つことで安全性とUXを両立できる。

---

### 5-4. controllers/ - reviewController

`src/controllers/reviewController.ts` を作成：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { reviewService } from '../services/reviewService.js';
import {
  createReviewSchema,
  getReviewsQuerySchema,
  productParamsSchema,
} from '../schemas/reviewSchema.js';

export const reviewController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = productParamsSchema.parse(req.params);
      const body = createReviewSchema.parse(req.body);
      const review = await reviewService.createReview(
        id, req.user!.id, body.order_id, body.rating, body.comment
      );
      res.status(201).json(review);
    } catch (e) { next(e); }
  },

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = productParamsSchema.parse(req.params);
      const query = getReviewsQuerySchema.parse(req.query);
      const result = await reviewService.getReviews(id, query.limit, query.offset);
      res.json(result);
    } catch (e) { next(e); }
  },
};
```

---

### 5-5. routes/ - レビュールート追加

`src/routes/reviewRoutes.ts` を作成：

```typescript
import { Router } from 'express';
import { reviewController } from '../controllers/reviewController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router({ mergeParams: true }); // productId を params から受け取る

router.post('/', authenticate, reviewController.create);
router.get('/', reviewController.list);  // レビュー一覧は認証不要

export default router;
```

`src/app.ts` にルーター登録を追記：

```typescript
import reviewRoutes from './routes/reviewRoutes.js';

// /api/v1/products/:id/reviews に reviewRoutes をマウント
app.use('/api/v1/products/:id/reviews', reviewRoutes);
```

**`mergeParams: true` の役割**：`/products/:id/reviews` のように親ルーターのパスパラメータ（`:id`）を子ルーターで `req.params.id` として参照するために必要。省略すると子ルーターでは `req.params.id` が `undefined` になる。

---

### 5-6. 動作確認（レビュー）

```bash
# completed 状態の注文を前提（ORDER_ID は 4-9 で作成・遷移済みのもの）

# レビュー投稿（buyer のみ）
curl -X POST http://localhost:3000/api/v1/products/2/reviews \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -d "{\"order_id\":$ORDER_ID,\"rating\":5,\"comment\":\"非常に良い商品でした\"}"
# → {"id":1,"rating":5,"comment":"非常に良い商品でした",...}

# 二重投稿確認（409）
curl -X POST http://localhost:3000/api/v1/products/2/reviews \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -d "{\"order_id\":$ORDER_ID,\"rating\":3,\"comment\":\"再投稿テスト\"}"
# → {"error":"この注文の商品には既にレビューを投稿しています"}

# completed 前の注文へのレビュー（422）
# → {"error":"レビューは注文が完了（completed）になってから投稿できます"}

# レビュー一覧取得（認証不要）
curl http://localhost:3000/api/v1/products/2/reviews
# → {"data":[{"id":1,"rating":5,...}],"total":1,"avg_rating":5.0}

# DB 直接確認
mysql market -e "SELECT * FROM reviews;"
mysql market -e "SELECT * FROM audit_logs WHERE action = 'review_posted';"
```

---

## 6. Flutter連携

### 6-1. 注文ステータス表示 UI

`lib/features/order/ui/order_detail_screen.dart`：

```dart
import 'package:flutter/material.dart';
import '../data/order_repository.dart';
import '../data/order.dart';

class OrderDetailScreen extends StatefulWidget {
  final int orderId;
  const OrderDetailScreen({super.key, required this.orderId});
  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  final _repo = OrderRepository();
  Order? _order;
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final order = await _repo.getOrderById(widget.orderId);
      setState(() { _order = order; _isLoading = false; });
    } catch (e) {
      setState(() { _error = '注文情報の取得に失敗しました'; _isLoading = false; });
    }
  }

  // ステータスの日本語ラベル
  String _statusLabel(String status) => const {
    'pending': '支払い待ち',
    'paid': '支払い済み',
    'preparing': '発送準備中',
    'shipped': '発送済み',
    'delivered': '配達済み',
    'completed': '取引完了',
    'cancelled': 'キャンセル',
    'refund_pending': '返金手続き中',
  }[status] ?? status;

  Color _statusColor(String status) {
    switch (status) {
      case 'completed': return Colors.green;
      case 'cancelled': return Colors.red;
      case 'refund_pending': return Colors.orange;
      default: return Colors.blue;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_error != null) return Scaffold(body: Center(child: Text(_error!)));

    final order = _order!;
    return Scaffold(
      appBar: AppBar(title: Text('注文 #${order.id}')),
      body: Column(
        children: [
          // ステータスバッジ
          Container(
            width: double.infinity,
            color: _statusColor(order.status).withOpacity(0.1),
            padding: const EdgeInsets.all(16),
            child: Text(
              _statusLabel(order.status),
              style: TextStyle(
                color: _statusColor(order.status),
                fontSize: 18,
                fontWeight: FontWeight.bold,
              ),
              textAlign: TextAlign.center,
            ),
          ),
          // 商品一覧
          Expanded(
            child: ListView.builder(
              itemCount: order.items.length,
              itemBuilder: (context, i) {
                final item = order.items[i];
                return ListTile(
                  title: Text(item.productName),
                  subtitle: Text('¥${item.unitPrice} × ${item.quantity}'),
                  trailing: Text('¥${item.subtotal}'),
                );
              },
            ),
          ),
          // 合計金額
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                  const Text('合計'),
                  Text('¥${order.totalAmount}',
                      style: const TextStyle(fontWeight: FontWeight.bold)),
                ]),
                const SizedBox(height: 8),
                // 受取確認ボタン（delivered のときのみ表示）
                if (order.status == 'delivered')
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: _receive,
                      child: const Text('受取確認'),
                    ),
                  ),
                // キャンセルボタン（pending / paid のときのみ表示）
                if (order.status == 'pending' || order.status == 'paid')
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      onPressed: _cancel,
                      style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
                      child: const Text('注文をキャンセル'),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _receive() async {
    try {
      await _repo.updateOrderStatus(widget.orderId, 'receive');
      await _load(); // 再取得してUI更新
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('受取確認が完了しました')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('操作に失敗しました')),
        );
      }
    }
  }

  Future<void> _cancel() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('注文キャンセル'),
        content: const Text('この注文をキャンセルしますか？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('戻る')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('キャンセルする'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await _repo.updateOrderStatus(widget.orderId, 'cancel');
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('キャンセルに失敗しました')),
        );
      }
    }
  }
}
```

`lib/features/order/data/order_repository.dart` に追記：

```dart
  // 注文状態変更（action: 'pay' | 'prepare' | 'ship' | 'deliver' | 'receive' | 'cancel'）
  Future<Order> updateOrderStatus(int orderId, String action,
      {Map<String, dynamic>? body}) async {
    final response = await dio.post(
      '/orders/$orderId/$action',
      data: body,
    );
    return Order.fromJson(response.data as Map<String, dynamic>);
  }
```

---

### 6-2. レビュー投稿フォーム

`lib/features/review/ui/review_form_screen.dart`：

```dart
import 'package:flutter/material.dart';
import '../data/review_repository.dart';

class ReviewFormScreen extends StatefulWidget {
  final int productId;
  final int orderId;
  const ReviewFormScreen({super.key, required this.productId, required this.orderId});
  @override
  State<ReviewFormScreen> createState() => _ReviewFormScreenState();
}

class _ReviewFormScreenState extends State<ReviewFormScreen> {
  final _repo = ReviewRepository();
  int _rating = 5;
  final _commentController = TextEditingController();
  bool _isLoading = false;
  String? _error;

  Future<void> _submit() async {
    setState(() { _isLoading = true; _error = null; });
    try {
      await _repo.createReview(
        productId: widget.productId,
        orderId: widget.orderId,
        rating: _rating,
        comment: _commentController.text.isEmpty ? null : _commentController.text,
      );
      if (mounted) Navigator.pop(context, true); // 投稿成功を呼び出し元に伝える
    } catch (e) {
      setState(() { _error = 'レビューの投稿に失敗しました'; _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('レビューを投稿')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('評価'),
            Row(
              children: List.generate(5, (i) {
                final star = i + 1;
                return IconButton(
                  icon: Icon(
                    star <= _rating ? Icons.star : Icons.star_border,
                    color: Colors.amber,
                  ),
                  onPressed: () => setState(() => _rating = star),
                );
              }),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _commentController,
              decoration: const InputDecoration(
                labelText: 'コメント（任意）',
                border: OutlineInputBorder(),
              ),
              maxLines: 4,
              maxLength: 1000,
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: const TextStyle(color: Colors.red)),
              ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : ElevatedButton(onPressed: _submit, child: const Text('投稿する')),
            ),
          ],
        ),
      ),
    );
  }
}
```

`lib/features/review/data/review_repository.dart`：

```dart
import '../../../core/api/dio_client.dart';

class ReviewRepository {
  Future<Map<String, dynamic>> createReview({
    required int productId,
    required int orderId,
    required int rating,
    String? comment,
  }) async {
    final response = await dio.post('/products/$productId/reviews', data: {
      'order_id': orderId,
      'rating': rating,
      if (comment != null) 'comment': comment,
    });
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getReviews(int productId, {int limit = 20, int offset = 0}) async {
    final response = await dio.get('/products/$productId/reviews', queryParameters: {
      'limit': limit, 'offset': offset,
    });
    return response.data as Map<String, dynamic>;
  }
}
```

---

## 確認チェックリスト

Phase 8 完了の判断基準：

```
[ ] migrations/014〜018 が全て実行済みで対象テーブルが存在する
[ ] ALLOWED_TRANSITIONS マップで状態遷移が管理されている
[ ] 不正な遷移（completed → cancelled など）に 422 が返る
[ ] pending → paid → preparing → shipped → delivered → completed の正常遷移が通る
[ ] pending → cancelled で在庫が復元される
[ ] 状態変更のたびに order_status_histories にレコードが INSERT される
[ ] /ship で shipments レコードが作成され tracking_number が保存される
[ ] /pay で payments レコードが作成される
[ ] 状態変更のたびに audit_logs にレコードが INSERT される
[ ] 出品者でないユーザーが /prepare・/ship を呼ぶと 403 が返る
[ ] 購入者でないユーザーが /receive・/cancel を呼ぶと 403 が返る
[ ] POST /products/:id/reviews で completed 注文の購入者がレビューを投稿できる
[ ] completed でない注文へのレビュー投稿が 422 を返す
[ ] 二重投稿が 409 を返す（アプリ側チェック + DB UNIQUE 制約）
[ ] GET /products/:id/reviews でレビュー一覧と avg_rating が返る
[ ] Flutter の注文詳細画面でステータスが日本語表示される
[ ] Flutter の delivered 状態で受取確認ボタンが表示される
[ ] Flutter のレビュー投稿フォームで評価・コメントを送信できる
[ ] openapi.yaml に全ての状態遷移エンドポイントとレビューエンドポイントが定義されている
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|---|---|
| 状態遷移マップ | 許可される遷移を定数で管理する設計。`if/switch` の散在を防ぎ、遷移ルール変更時の修正箇所を1箇所にまとめる |
| 後戻り禁止の意味 | `completed → pending` のような逆遷移を許すと注文金額の水増しや在庫操作が可能になる。遷移バリデーションはセキュリティ要件でもある |
| 履歴テーブルの設計 | 現在値テーブル（orders.status）と履歴テーブル（order_status_histories）の役割分担。「今の状態」と「どう変化したか」は別の概念 |
| 監査ログと業務ログの違い | `order_status_histories` は「何が変わったか」の業務ログ、`audit_logs` は「誰がいつ何を操作したか」のセキュリティ監査ログ。用途が異なるため別テーブルにする |
| レビューの多重防護 | アプリ側の事前チェック（UXのため）と DB 制約（並行処理での最終防壁）の両方を持つことで安全性と使いやすさを両立する |
| fire-and-forget ログ | 監査ログの書き込み失敗でビジネス処理を中断しない設計。ログは補助的な記録であり、失敗しても注文・レビューの整合性は保たれている |
| `mergeParams: true` | 親ルーターのパスパラメータを子ルーターで参照するための Express 設定。ネストしたリソース（`/products/:id/reviews`）でよく使うパターン |
