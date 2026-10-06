# Phase 5 - お気に入り・カート 詳細作業ログ

## 概要

Phase 4 で構築した商品検索機能に続き、お気に入り登録とカート機能を追加する。

- `favorites` テーブルの UNIQUE(user_id, product_id) 制約で DB 側でも重複を防ぐ
- お気に入り登録は冪等設計（INSERT IGNORE で重複時も 200 を返す）
- カートはユーザー 1 人に 1 つ（carts.user_id UNIQUE）、初回アクセス時に自動作成（findOrCreate）
- カート内商品の価格は現在の `products.price` を JOIN して表示（注文確定時の価格コピーは Phase 6）

---

## 1. 新規パッケージ

Phase 5 では新規パッケージは不要。Phase 2〜4 までのパッケージで実装できる。

---

## 2. DB（テーブル作成）

### 2-1. migrations/008_create_favorites.sql

```sql
CREATE TABLE favorites (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, product_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
```

実行：

```bash
mysql market < migrations/008_create_favorites.sql
```

確認：

```bash
mysql market -e "SHOW TABLES;"
mysql market -e "DESCRIBE favorites;"
```

| カラム / 制約 | 理由 |
|---|---|
| `INT UNSIGNED` | 通常の `INT` は負の値も格納できる（-2,147,483,648〜2,147,483,647）。`UNSIGNED` を付けると負の値を排除し、正の値の範囲が 0〜4,294,967,295 に倍増する。ID・外部キーは負になり得ないため `UNSIGNED` が適切。また参照先テーブル（users・products）の主キーも `INT UNSIGNED` であるため、型を合わせないと FOREIGN KEY 制約が設定できない |
| `UNIQUE(user_id, product_id)` | 同一ユーザーが同じ商品を二重登録できないことを DB 側でも保証。アプリ側のチェックだけでは並行リクエストで抜けられる |
| `ON DELETE CASCADE (user_id)` | ユーザー退会時に関連お気に入りも自動削除 |
| `ON DELETE CASCADE (product_id)` | 商品が物理削除された場合にお気に入りも自動削除（Phase 3 では論理削除のため発火しないが、将来の物理削除に備えた設定） |

---

### 2-2. migrations/009_create_carts.sql

```sql
CREATE TABLE carts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

実行：

```bash
mysql market < migrations/009_create_carts.sql
```

確認：

```bash
mysql market -e "DESCRIBE carts;"
```

| カラム / 制約 | 理由 |
|---|---|
| `user_id UNIQUE` | ユーザー 1 人に対してカートは 1 つ。DB 制約で複数カートの誤作成を防ぐ |
| `ON DELETE CASCADE` | ユーザー退会時にカートも自動削除。cart_items は carts の CASCADE で連鎖削除される |

---

### 2-3. migrations/010_create_cart_items.sql

```sql
CREATE TABLE cart_items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  cart_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (cart_id, product_id),
  FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
```

実行：

```bash
mysql market < migrations/010_create_cart_items.sql
```

確認：

```bash
mysql market -e "DESCRIBE cart_items;"
```

| カラム / 制約 | 理由 |
|---|---|
| `UNIQUE(cart_id, product_id)` | 同じ商品をカートに二重追加させない。追加時は `ON DUPLICATE KEY UPDATE` で数量加算する |
| `quantity INT UNSIGNED` | 0 以下の数量を DB 側でも弾く |
| `ON DELETE CASCADE (cart_id)` | カート削除時に cart_items も自動削除 |

**マイグレーション番号の整理：**

| ファイル | Phase |
|---|---|
| 001_create_categories | 1 |
| 002_create_products | 1 |
| 003_create_users | 2 |
| 004_add_seller_id_to_products | 2 |
| 005_create_product_images | 3 |
| 006_add_product_indexes | 4 |
| 007_add_fulltext_index | 4 |
| 008_create_favorites | **5** |
| 009_create_carts | **5** |
| 010_create_cart_items | **5** |

---

## 3. OpenAPI（仕様更新）

`openapi.yaml` の `tags:` セクションに追記：

```yaml
  - name: Favorites
    description: お気に入り登録・一覧
  - name: Cart
    description: カート
```

### 3-1. お気に入りエンドポイント追加

`openapi.yaml` の `paths:` セクションに追記：

```yaml
  /products/{productId}/favorite:
    post:
      tags: [Favorites]
      summary: お気に入り登録（冪等：すでに登録済みでも 200）
      security:
        - BearerAuth: []
      parameters:
        - name: productId
          in: path
          required: true
          schema:
            type: integer
      responses:
        '200':
          description: 登録成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Favorite'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'
    delete:
      tags: [Favorites]
      summary: お気に入り削除
      security:
        - BearerAuth: []
      parameters:
        - name: productId
          in: path
          required: true
          schema:
            type: integer
      responses:
        '204':
          description: 削除成功
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /me/favorites:
    get:
      tags: [Favorites]
      summary: お気に入り一覧取得
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
                      $ref: '#/components/schemas/Favorite'
                  total:
                    type: integer
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

### 3-2. カートエンドポイント追加

```yaml
  /cart:
    get:
      tags: [Cart]
      summary: カート取得（商品の現在価格を表示）
      security:
        - BearerAuth: []
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Cart'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /cart/items:
    post:
      tags: [Cart]
      summary: カートに商品追加（すでに入っている場合は数量加算）
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AddCartItemRequest'
      responses:
        '200':
          description: 追加成功（追加後のカート全体を返す）
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Cart'
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

  /cart/items/{itemId}:
    patch:
      tags: [Cart]
      summary: カートアイテムの数量変更
      security:
        - BearerAuth: []
      parameters:
        - name: itemId
          in: path
          required: true
          schema:
            type: integer
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UpdateCartItemRequest'
      responses:
        '200':
          description: 更新成功（更新後のカート全体を返す）
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Cart'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'
    delete:
      tags: [Cart]
      summary: カートからアイテム削除
      security:
        - BearerAuth: []
      parameters:
        - name: itemId
          in: path
          required: true
          schema:
            type: integer
      responses:
        '204':
          description: 削除成功
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

### 3-3. 新スキーマ・新レスポンス追加

`components/schemas:` に追記：

```yaml
    Favorite:
      type: object
      properties:
        id:
          type: integer
        product_id:
          type: integer
        product:
          $ref: '#/components/schemas/ProductSummary'
        created_at:
          type: string
          format: date-time

    CartItem:
      type: object
      properties:
        id:
          type: integer
        product_id:
          type: integer
        quantity:
          type: integer
        product_name:
          type: string
        unit_price:
          type: integer
          description: 現在の販売価格（products.price）。注文確定時に order_items.unit_price にコピーされる
        subtotal:
          type: integer
          description: unit_price × quantity
        product_status:
          type: string
          enum: [draft, published, archived]

    Cart:
      type: object
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/CartItem'
        total_amount:
          type: integer
          description: カート内全アイテムの合計金額（items[].subtotal の合計）

    AddCartItemRequest:
      type: object
      required: [product_id]
      properties:
        product_id:
          type: integer
        quantity:
          type: integer
          minimum: 1
          maximum: 99
          default: 1

    UpdateCartItemRequest:
      type: object
      required: [quantity]
      properties:
        quantity:
          type: integer
          minimum: 1
          maximum: 99
```

`components/responses:` の `Conflict` の後・`InternalServerError` の前に追記：

```yaml
    UnprocessableEntity:
      description: 業務ルール違反（販売停止商品の追加など）
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
```

**`CartItem.unit_price` は現在価格であることの意味**：

```
cart_items テーブル
  → price カラムを持たない
  → GET /cart 時に products.price を JOIN して取得（常に最新価格）

出品者が price を 90000 → 80000 に変更
  → 次回 GET /cart で 80000 が返る（カートがリアルタイムに反映）

注文確定（Phase 6）
  → サーバーが products.price を取得して order_items.unit_price にコピー
  → 以後は order_items.unit_price が変わらない（注文時点の価格を保存）
```

---

## 4. API実装

### 4-1. errors/ - 業務エラークラス追加

`src/errors/AppError.ts` に追記：

```typescript
export class UnprocessableEntityError extends AppError {
  constructor(message = 'Unprocessable Entity') {
    super(422, message);
  }
}
```

既存の `if (err instanceof AppError)` チェックがこのクラスも自動的にハンドリングするため、`errorHandler.ts` の変更は不要。

**422 Unprocessable Entity の使い分け**：

| コード | 意味 | 例 |
|---|---|---|
| 400 Bad Request | 入力の形式・型が不正 | 数値フィールドに文字列を送った |
| 422 Unprocessable Entity | 形式は正しいが業務ルールで処理できない | 販売停止商品をカートに追加しようとした |

---

### 4-2. schemas/ - バリデーション定義

`src/schemas/favoriteSchema.ts` を作成：

```typescript
import { z } from 'zod';

export const favoriteParamsSchema = z.object({
  id: z.coerce.number().int().positive(), // URL の :id は商品 ID
});

export const getFavoritesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
```

`src/schemas/cartSchema.ts` を作成：

```typescript
import { z } from 'zod';

export const addCartItemSchema = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99).default(1),
});

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(1).max(99),
});

export const cartItemParamsSchema = z.object({
  id: z.coerce.number().int().positive(), // URL の :id はカートアイテム ID
});
```

---

### 4-3. repositories/ - favoriteRepository 新規作成

`src/repositories/favoriteRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';

export const favoriteRepository = {
  // お気に入り登録（INSERT IGNORE で重複を無視）
  async add(userId: number, productId: number) {
    await pool.query(
      `INSERT IGNORE INTO favorites (user_id, product_id) VALUES (?, ?)`,
      [userId, productId]
    );
    // INSERT IGNORE は成功・重複どちらでも同じレコードを返す
    return this.findByUserAndProduct(userId, productId);
  },

  // お気に入り削除（冪等：未登録でも正常終了）
  async remove(userId: number, productId: number) {
    await pool.query(
      `DELETE FROM favorites WHERE user_id = ? AND product_id = ?`,
      [userId, productId]
    );
  },

  // お気に入り一覧取得（商品情報を JOIN）
  async findByUserId(userId: number, limit: number, offset: number) {
    const [rows] = await pool.query(
      `SELECT f.id, f.product_id, f.created_at,
              p.seller_id, p.category_id, p.name, p.price, p.stock, p.status,
              p.created_at AS product_created_at
       FROM favorites f
       JOIN products p ON p.id = f.product_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    ) as any[];
    return rows as any[];
  },

  // お気に入り件数取得
  async countByUserId(userId: number) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as total FROM favorites WHERE user_id = ?`,
      [userId]
    ) as any[];
    return rows[0].total as number;
  },

  // user_id + product_id でお気に入りを 1 件取得
  async findByUserAndProduct(userId: number, productId: number) {
    const [rows] = await pool.query(
      `SELECT f.id, f.product_id, f.created_at,
              p.seller_id, p.category_id, p.name, p.price, p.stock, p.status,
              p.created_at AS product_created_at
       FROM favorites f
       JOIN products p ON p.id = f.product_id
       WHERE f.user_id = ? AND f.product_id = ?`,
      [userId, productId]
    ) as any[];
    return rows[0] ?? null;
  },
};
```

**`INSERT IGNORE` の仕組み**：UNIQUE 制約に違反する INSERT が発生した場合、通常はエラーを返す。`INSERT IGNORE` は違反時にエラーを無視してレコードを挿入せず処理を続行する。`affectedRows` が 0 になることで「既に存在した」かどうかを判別できる。

```sql
-- 例：user_id=1, product_id=1 がすでに存在する場合
INSERT IGNORE INTO favorites (user_id, product_id) VALUES (1, 1);
-- → エラーにならず、affectedRows = 0 で終わる
-- → その後 SELECT すると既存レコードが返る → 冪等に 200 を返せる
```

---

### 4-4. repositories/ - cartRepository 新規作成

`src/repositories/cartRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';

export const cartRepository = {
  // ユーザーのカートを取得または作成してカート ID を返す（findOrCreate パターン）
  async findOrCreateByUserId(userId: number): Promise<number> {
    // INSERT IGNORE：カートが存在しなければ作成。既に存在すれば何もしない
    await pool.query(
      `INSERT IGNORE INTO carts (user_id) VALUES (?)`,
      [userId]
    );
    // INSERT の有無に関わらず、SELECT で cart id を取得
    const [rows] = await pool.query(
      `SELECT id FROM carts WHERE user_id = ?`,
      [userId]
    ) as any[];
    return rows[0].id as number;
  },
};
```

**findOrCreate パターン**：ユーザーが初めてカートを操作するとき、カートレコードが存在しない。毎回「カートがあるか確認してなければ作成」という処理を書くのは冗長なため、`findOrCreateByUserId` 1 メソッドで「あれば返し、なければ作って返す」を実現する。`INSERT IGNORE` と `SELECT` の 2 段構成でロック不要の安全な実装になる。

```
初回アクセス（カートなし）:
  INSERT IGNORE → 新規作成（affectedRows=1）
  SELECT → 新規作成した id を返す

2回目以降（カートあり）:
  INSERT IGNORE → 無視（affectedRows=0）
  SELECT → 既存の id を返す
```

---

### 4-5. repositories/ - cartItemRepository 新規作成

`src/repositories/cartItemRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';

export const cartItemRepository = {
  // カートアイテムを追加（既に同じ商品があれば数量加算）
  async addOrIncrement(cartId: number, productId: number, quantity: number) {
    await pool.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
      [cartId, productId, quantity]
    );
  },

  // 数量変更
  async updateQuantity(id: number, quantity: number) {
    await pool.query(
      `UPDATE cart_items SET quantity = ? WHERE id = ?`,
      [quantity, id]
    );
  },

  // カートアイテム削除
  async deleteById(id: number) {
    const [result] = await pool.query(
      `DELETE FROM cart_items WHERE id = ?`,
      [id]
    ) as any[];
    return result.affectedRows as number;
  },

  // カートアイテムを 1 件取得（所有者チェック用：user_id を JOIN で取得）
  async findById(id: number) {
    const [rows] = await pool.query(
      `SELECT ci.id, ci.cart_id, ci.product_id, ci.quantity,
              c.user_id
       FROM cart_items ci
       JOIN carts c ON c.id = ci.cart_id
       WHERE ci.id = ?`,
      [id]
    ) as any[];
    return rows[0] ?? null;
  },

  // カートのアイテム一覧取得（商品の現在価格を JOIN）
  async findWithProductByCartId(cartId: number) {
    const [rows] = await pool.query(
      `SELECT ci.id, ci.product_id, ci.quantity,
              p.name AS product_name,
              p.price AS unit_price,
              p.status AS product_status,
              (p.price * ci.quantity) AS subtotal
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = ?
       ORDER BY ci.created_at ASC`,
      [cartId]
    ) as any[];
    return rows as any[];
  },
};
```

**`ON DUPLICATE KEY UPDATE`**：INSERT 時に UNIQUE 制約に違反した場合、エラーではなく UPDATE 処理に切り替える MySQL の構文。`VALUES(quantity)` は「INSERT しようとした値（今回追加しようとした個数）」を参照する。

```sql
-- cart_id=1, product_id=2 のアイテムがすでに quantity=2 で存在し、さらに 3 個追加しようとした場合
INSERT INTO cart_items (cart_id, product_id, quantity)
VALUES (1, 2, 3)
ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity);
-- → quantity が 2 + 3 = 5 に更新される
```

---

### 4-6. services/ - favoriteService 新規作成

`src/services/favoriteService.ts` を作成：

```typescript
import { favoriteRepository } from '../repositories/favoriteRepository.js';
import { productRepository } from '../repositories/productRepository.js';
import { NotFoundError } from '../errors/AppError.js';

export const favoriteService = {
  // お気に入り登録（商品存在チェック後、INSERT IGNORE で冪等に処理）
  async addFavorite(userId: number, productId: number) {
    // 公開中の商品のみお気に入り登録可能（draft・archived は不可）
    const product = await productRepository.findPublishedById(productId);
    if (!product) throw new NotFoundError('商品が見つかりません');

    return favoriteRepository.add(userId, productId);
  },

  // お気に入り削除（冪等：未登録でも 204 を返す）
  async removeFavorite(userId: number, productId: number) {
    await favoriteRepository.remove(userId, productId);
  },

  // お気に入り一覧取得
  async getFavorites(userId: number, limit: number, offset: number) {
    const [rows, total] = await Promise.all([
      favoriteRepository.findByUserId(userId, limit, offset),
      favoriteRepository.countByUserId(userId),
    ]);
    // レスポンス形式に整形（JOIN で取得したフラットな行をネスト構造に変換）
    const data = rows.map((row: any) => ({
      id: row.id,
      product_id: row.product_id,
      created_at: row.created_at,
      product: {
        id: row.product_id,
        seller_id: row.seller_id,
        category_id: row.category_id,
        name: row.name,
        price: row.price,
        stock: row.stock,
        status: row.status,
        created_at: row.product_created_at,
      },
    }));
    return { data, total };
  },
};
```

**公開済み商品のみお気に入り登録を許可する理由**：`draft`（下書き）は出品者しか見えない商品。購入者が閲覧できない商品をお気に入り登録する操作は存在しえないため、`findPublishedById`（status = 'published'）で確認する。

**JOIN で取得したフラットな行をネストに変換する理由**：SQL の JOIN 結果は1行に全カラムが並ぶ（フラット構造）。APIレスポンスで `{ ..., product: { id, name, ... } }` のようなネスト構造にするためにサービス層で変換する。この変換をリポジトリ層ではなくサービス層で行うのは、リポジトリはSQL結果をそのまま返す責務を持ち、整形はサービスの役割とする設計方針による。

---

### 4-7. services/ - cartService 新規作成

`src/services/cartService.ts` を作成：

```typescript
import { cartRepository } from '../repositories/cartRepository.js';
import { cartItemRepository } from '../repositories/cartItemRepository.js';
import { productRepository } from '../repositories/productRepository.js';
import { NotFoundError, ForbiddenError, UnprocessableEntityError } from '../errors/AppError.js';

export const cartService = {
  // カート取得（findOrCreate で初回も空カートを返す）
  async getCart(userId: number) {
    const cartId = await cartRepository.findOrCreateByUserId(userId);
    const items = await cartItemRepository.findWithProductByCartId(cartId);
    const totalAmount = items.reduce(
      (sum: number, item: any) => sum + Number(item.subtotal),
      0
    );
    return { items, total_amount: totalAmount };
  },

  // カートに商品追加（販売停止・存在しない商品は追加不可）
  async addItem(userId: number, productId: number, quantity: number) {
    // status に関わらず商品を取得して公開状態を確認
    const product = await productRepository.findById(productId);
    if (!product) throw new NotFoundError('商品が見つかりません');
    if (product.status !== 'published') {
      throw new UnprocessableEntityError('販売停止または下書き状態の商品はカートに追加できません');
    }

    const cartId = await cartRepository.findOrCreateByUserId(userId);
    await cartItemRepository.addOrIncrement(cartId, productId, quantity);

    // 追加後のカート全体を返す
    return this.getCart(userId);
  },

  // カートアイテムの数量変更（自分のカートのアイテムかチェック）
  async updateItem(userId: number, cartItemId: number, quantity: number) {
    const item = await cartItemRepository.findById(cartItemId);
    if (!item) throw new NotFoundError('カートアイテムが見つかりません');
    if (item.user_id !== userId) throw new ForbiddenError('このカートアイテムを変更する権限がありません');

    await cartItemRepository.updateQuantity(cartItemId, quantity);
    return this.getCart(userId);
  },

  // カートからアイテム削除（自分のカートのアイテムかチェック）
  async removeItem(userId: number, cartItemId: number) {
    const item = await cartItemRepository.findById(cartItemId);
    if (!item) throw new NotFoundError('カートアイテムが見つかりません');
    if (item.user_id !== userId) throw new ForbiddenError('このカートアイテムを削除する権限がありません');

    await cartItemRepository.deleteById(cartItemId);
  },
};
```

**`getCart` を `addItem` / `updateItem` の末尾で呼ぶ理由**：変更後のカート全体（items + total_amount）を返すことで、Flutter 側が API レスポンスだけで画面を更新できる。個別アイテム情報だけを返すと Flutter 側でカート合計の再計算が必要になり、計算ロジックが分散する。

**カートアイテムの所有者チェックの仕組み**：

```
cart_items.id → JOIN carts → carts.user_id
```

`findById` で `cart_items` と `carts` を JOIN することで、`cart_items.id` だけを知っていても「そのアイテムが誰のカートに属するか」を 1 クエリで確認できる。

---

### 4-8. controllers/ - favoriteController 新規作成

`src/controllers/favoriteController.ts` を作成：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { favoriteService } from '../services/favoriteService.js';
import { favoriteParamsSchema, getFavoritesQuerySchema } from '../schemas/favoriteSchema.js';

export const favoriteController = {
  async add(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: productId } = favoriteParamsSchema.parse(req.params);
      const favorite = await favoriteService.addFavorite(req.user!.id, productId);
      res.json(favorite);
    } catch (error) {
      next(error);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: productId } = favoriteParamsSchema.parse(req.params);
      await favoriteService.removeFavorite(req.user!.id, productId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const query = getFavoritesQuerySchema.parse(req.query);
      const result = await favoriteService.getFavorites(req.user!.id, query.limit, query.offset);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
};
```

---

### 4-9. controllers/ - cartController 新規作成

`src/controllers/cartController.ts` を作成：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { cartService } from '../services/cartService.js';
import { addCartItemSchema, updateCartItemSchema, cartItemParamsSchema } from '../schemas/cartSchema.js';

export const cartController = {
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const cart = await cartService.getCart(req.user!.id);
      res.json(cart);
    } catch (error) {
      next(error);
    }
  },

  async addItem(req: Request, res: Response, next: NextFunction) {
    try {
      const body = addCartItemSchema.parse(req.body);
      const cart = await cartService.addItem(req.user!.id, body.product_id, body.quantity);
      res.json(cart);
    } catch (error) {
      next(error);
    }
  },

  async updateItem(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: cartItemId } = cartItemParamsSchema.parse(req.params);
      const body = updateCartItemSchema.parse(req.body);
      const cart = await cartService.updateItem(req.user!.id, cartItemId, body.quantity);
      res.json(cart);
    } catch (error) {
      next(error);
    }
  },

  async removeItem(req: Request, res: Response, next: NextFunction) {
    try {
      const { id: cartItemId } = cartItemParamsSchema.parse(req.params);
      await cartService.removeItem(req.user!.id, cartItemId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
};
```

---

### 4-10. routes/ - productRoutes 更新（お気に入り追加）

お気に入りのルートは商品 URL 配下（`/products/:id/favorite`）なので `productRoutes.ts` に追記する。

`src/routes/productRoutes.ts` を更新：

```typescript
import { Router } from 'express';
import { productController } from '../controllers/productController.js';
import { favoriteController } from '../controllers/favoriteController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

// 公開エンドポイント（認証不要）
router.get('/', productController.list);
router.get('/:id', productController.show);

// 認証必須：出品操作
router.post('/', authenticate, productController.create);
router.patch('/:id', authenticate, productController.update);
router.delete('/:id', authenticate, productController.archive);

// 認証必須：お気に入り（Phase 5 で追加）
router.post('/:id/favorite', authenticate, favoriteController.add);
router.delete('/:id/favorite', authenticate, favoriteController.remove);

export default router;
```

**`/:id/favorite` と `/:id` が共存できる理由**：Express はHTTPメソッド（GET/POST/PATCH/DELETE）ごとにルートを照合する。`POST /:id/favorite` と `DELETE /:id/favorite` は専用のハンドラーにルーティングされ、`GET /:id`（商品詳細）と競合しない。

---

### 4-11. routes/ - cartRoutes 新規作成

`src/routes/cartRoutes.ts` を作成：

```typescript
import { Router } from 'express';
import { cartController } from '../controllers/cartController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

// カートのエンドポイントはすべて認証必須なので router.use で一括適用
router.use(authenticate);

router.get('/', cartController.get);
router.post('/items', cartController.addItem);
router.patch('/items/:id', cartController.updateItem);
router.delete('/items/:id', cartController.removeItem);

export default router;
```

**`router.use(authenticate)` でルーター全体に適用する理由**：Phase 3 の `productRoutes.ts` では公開・認証必須が混在するためエンドポイントごとに `authenticate` を個別指定した。カートエンドポイントはすべて認証必須なので `router.use` で一括適用できる。

---

### 4-12. userRoutes 更新（お気に入り一覧追加）

`src/routes/userRoutes.ts` を更新：

```typescript
import { Router } from 'express';
import { authController } from '../controllers/authController.js';
import { productController } from '../controllers/productController.js';
import { favoriteController } from '../controllers/favoriteController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

router.get('/me', authenticate, authController.me);
router.patch('/me', authenticate, authController.updateMe);
router.get('/me/products', authenticate, productController.myList);
router.get('/me/favorites', authenticate, favoriteController.list); // Phase 5 で追加

export default router;
```

---

### 4-13. app.ts にルーター登録

`src/app.ts` に追記：

```typescript
import cartRoutes from './routes/cartRoutes.js';

// 既存ルートの後に追加
app.use('/api/v1/cart', cartRoutes);
// productRoutes と userRoutes はすでに登録済み
// お気に入りエンドポイントはそれぞれに追記済み
```

---

### 4-14. 動作確認

```bash
# ログインしてトークン取得
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com","password":"password123"}' \
  | jq -r '.token')

# ========== お気に入り ==========

# お気に入り登録
curl -X POST http://localhost:3000/api/v1/products/1/favorite \
  -H "Authorization: Bearer $TOKEN"
# → {"id":1,"product_id":1,"created_at":"...","product":{"id":1,"name":"iPhone 14",...}}

# 同じ商品を再度登録（冪等：200 が返ること確認）
curl -X POST http://localhost:3000/api/v1/products/1/favorite \
  -H "Authorization: Bearer $TOKEN"
# → 同じレスポンス（エラーにならない）

# お気に入り一覧取得
curl http://localhost:3000/api/v1/me/favorites \
  -H "Authorization: Bearer $TOKEN"
# → {"data":[{"id":1,"product_id":1,"product":{...}}],"total":1}

# お気に入り削除
curl -X DELETE http://localhost:3000/api/v1/products/1/favorite \
  -H "Authorization: Bearer $TOKEN"
# → 204 No Content

# 削除済みのお気に入りを再削除（冪等：204 が返ること確認）
curl -X DELETE http://localhost:3000/api/v1/products/1/favorite \
  -H "Authorization: Bearer $TOKEN"
# → 204 No Content

# 存在しない商品をお気に入り登録（404 確認）
curl -X POST http://localhost:3000/api/v1/products/99999/favorite \
  -H "Authorization: Bearer $TOKEN"
# → {"error":"商品が見つかりません"}

# トークンなしでお気に入り登録（401 確認）
curl -X POST http://localhost:3000/api/v1/products/1/favorite
# → {"error":"認証トークンがありません"}

# ========== カート ==========

# カート取得（初回：空カートが返る）
curl http://localhost:3000/api/v1/cart \
  -H "Authorization: Bearer $TOKEN"
# → {"items":[],"total_amount":0}

# カートに商品追加
curl -X POST http://localhost:3000/api/v1/cart/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"product_id":2,"quantity":1}'
# → {"items":[{"id":1,"product_id":2,"quantity":1,"product_name":"iPad Pro 11inch","unit_price":90000,"subtotal":90000,...}],"total_amount":90000}

# 同じ商品を再度追加（数量加算確認：quantity が 2 になること）
curl -X POST http://localhost:3000/api/v1/cart/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"product_id":2,"quantity":1}'
# → items[0].quantity === 2

# 別の商品を追加
curl -X POST http://localhost:3000/api/v1/cart/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"product_id":3,"quantity":1}'
# → items に 2 件・total_amount = 90000*2 + 65000 = 245000

# 数量変更（items[0].id を使用）
curl -X PATCH http://localhost:3000/api/v1/cart/items/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"quantity":3}'
# → items[0].quantity === 3・subtotal・total_amount が更新されること確認

# カートアイテム削除
curl -X DELETE http://localhost:3000/api/v1/cart/items/1 \
  -H "Authorization: Bearer $TOKEN"
# → 204 No Content

# 販売停止商品のカート追加（422 確認）
# ※ あらかじめ seller アカウントで商品を archived にしておく
SELLER_TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"seller@example.com","password":"password123"}' | jq -r '.token')

curl -X DELETE http://localhost:3000/api/v1/products/1 \
  -H "Authorization: Bearer $SELLER_TOKEN"
# → 204（商品 1 を archived に）

curl -X POST http://localhost:3000/api/v1/cart/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"product_id":1,"quantity":1}'
# → {"error":"販売停止または下書き状態の商品はカートに追加できません"}

# 他ユーザーのカートアイテムを操作（403 確認）
curl -X PATCH http://localhost:3000/api/v1/cart/items/2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -d '{"quantity":5}'
# → {"error":"このカートアイテムを変更する権限がありません"}
```

#### Postman での確認

**事前準備**

Phase 2 の Postman 設定で環境変数 `token` が保存済みであること。環境変数 `cartItemId` を追加しておく。

1. 右上のドロップダウンで「market-api」環境を選択
2. ENVIRONMENTS タブを開き、変数 `cartItemId` を追加（Initial value・Current value は空でよい）
3. 「Save」

**お気に入り登録（POST /api/v1/products/1/favorite）**

1. Method: `POST`、URL: `http://localhost:3000/api/v1/products/1/favorite`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Send → 200 とお気に入り情報が返ること確認

**同じ商品を再度登録（冪等確認）**

1. 同じリクエストを再送
2. Send → 200 が返ること確認（409 にならない）

**お気に入り一覧（GET /api/v1/me/favorites）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/me/favorites`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Send → `{"data":[...],"total":1}` が返ること確認

**お気に入り削除（DELETE /api/v1/products/1/favorite）**

1. Method: `DELETE`、URL: `http://localhost:3000/api/v1/products/1/favorite`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Send → 204 が返ること確認

**カート取得（GET /api/v1/cart）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/cart`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Send → `{"items":[],"total_amount":0}` が返ること確認

**カートに商品追加（POST /api/v1/cart/items）**

1. Method: `POST`、URL: `http://localhost:3000/api/v1/cart/items`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Headers タブ → `Content-Type: application/json`
4. Body:
   ```json
   {
     "product_id": 2,
     "quantity": 1
   }
   ```
5. Scripts タブ → **After response** に以下を入力：
   ```javascript
   const json = pm.response.json();
   if (json.items && json.items.length > 0) {
     pm.environment.set("cartItemId", json.items[0].id);
   }
   ```
6. Send → 200 とカート全体が返ること確認

**数量変更（PATCH /api/v1/cart/items/:id）**

1. Method: `PATCH`、URL: `http://localhost:3000/api/v1/cart/items/{{cartItemId}}`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Headers: `Content-Type: application/json`
4. Body: `{"quantity": 3}`
5. Send → 200 と `quantity: 3` に更新されたカートが返ること確認

**カートアイテム削除（DELETE /api/v1/cart/items/:id）**

1. Method: `DELETE`、URL: `http://localhost:3000/api/v1/cart/items/{{cartItemId}}`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Send → 204 が返ること確認

---

## 5. Flutter連携

### 5-1. Favorite モデル定義

`lib/features/favorite/data/favorite.dart` を作成：

```dart
import '../../product/data/product.dart';

class Favorite {
  final int id;
  final int productId;
  final String createdAt;
  final Product product;

  Favorite({
    required this.id,
    required this.productId,
    required this.createdAt,
    required this.product,
  });

  factory Favorite.fromJson(Map<String, dynamic> json) => Favorite(
    id: json['id'],
    productId: json['product_id'],
    createdAt: json['created_at'],
    product: Product.fromJson(json['product'] as Map<String, dynamic>),
  );
}
```

---

### 5-2. FavoriteRepository（Flutter）

`lib/features/favorite/data/favorite_repository.dart` を作成：

```dart
import '../../../core/api/dio_client.dart';
import 'favorite.dart';

class FavoriteRepository {
  Future<Favorite> addFavorite(int productId) async {
    final response = await dio.post('/products/$productId/favorite');
    return Favorite.fromJson(response.data as Map<String, dynamic>);
  }

  Future<void> removeFavorite(int productId) async {
    await dio.delete('/products/$productId/favorite');
  }

  Future<Map<String, dynamic>> getFavorites({int limit = 20, int offset = 0}) async {
    final response = await dio.get('/me/favorites', queryParameters: {
      'limit': limit,
      'offset': offset,
    });
    return response.data as Map<String, dynamic>;
  }
}
```

---

### 5-3. お気に入りボタンウィジェット（トグル）

`lib/features/favorite/ui/favorite_button.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/favorite_repository.dart';

class FavoriteButton extends StatefulWidget {
  final int productId;
  final bool initialIsFavorited;

  const FavoriteButton({
    super.key,
    required this.productId,
    this.initialIsFavorited = false,
  });

  @override
  State<FavoriteButton> createState() => _FavoriteButtonState();
}

class _FavoriteButtonState extends State<FavoriteButton> {
  final _repo = FavoriteRepository();
  late bool _isFavorited;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _isFavorited = widget.initialIsFavorited;
  }

  Future<void> _toggle() async {
    if (_isLoading) return;
    setState(() { _isLoading = true; });
    try {
      if (_isFavorited) {
        await _repo.removeFavorite(widget.productId);
        setState(() { _isFavorited = false; });
      } else {
        await _repo.addFavorite(widget.productId);
        setState(() { _isFavorited = true; });
      }
    } catch (_) {
      // API 失敗時はサーバー側の状態が正であるため UI を元に戻さない
    } finally {
      setState(() { _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const SizedBox(
        width: 48, height: 48,
        child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
      );
    }
    return IconButton(
      icon: Icon(
        _isFavorited ? Icons.favorite : Icons.favorite_border,
        color: _isFavorited ? Colors.red : null,
      ),
      onPressed: _toggle,
    );
  }
}
```

**楽観的更新を使わない理由**：楽観的更新（タップ直後に UI を切り替えてから API 呼び出し）は UX が良いが、API エラー時に元に戻す処理が必要。このウィジェットでは `isLoading` 中のタップを無視し、API 成功後に状態を変更する保守的な実装にしている。

---

### 5-4. お気に入り一覧画面

`lib/features/favorite/ui/favorites_screen.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/favorite_repository.dart';
import '../data/favorite.dart';

class FavoritesScreen extends StatefulWidget {
  const FavoritesScreen({super.key});
  @override
  State<FavoritesScreen> createState() => _FavoritesScreenState();
}

class _FavoritesScreenState extends State<FavoritesScreen> {
  final _repo = FavoriteRepository();
  List<Favorite> _favorites = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _isLoading = true; _error = null; });
    try {
      final result = await _repo.getFavorites();
      final List data = result['data'];
      setState(() {
        _favorites = data.map((e) => Favorite.fromJson(e)).toList();
        _isLoading = false;
      });
    } catch (e) {
      setState(() { _error = '取得に失敗しました'; _isLoading = false; });
    }
  }

  Future<void> _remove(int productId, int index) async {
    try {
      await _repo.removeFavorite(productId);
      setState(() { _favorites.removeAt(index); });
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('削除に失敗しました')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!));
    if (_favorites.isEmpty) return const Center(child: Text('お気に入りはありません'));

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        itemCount: _favorites.length,
        itemBuilder: (context, index) {
          final fav = _favorites[index];
          return ListTile(
            title: Text(fav.product.name),
            subtitle: Text('¥${fav.product.price}'),
            trailing: IconButton(
              icon: const Icon(Icons.favorite, color: Colors.red),
              onPressed: () => _remove(fav.productId, index),
            ),
          );
        },
      ),
    );
  }
}
```

---

### 5-5. CartItem・Cart モデル定義

`lib/features/cart/data/cart_item.dart` を作成：

```dart
class CartItem {
  final int id;
  final int productId;
  final int quantity;
  final String productName;
  final int unitPrice;
  final int subtotal;
  final String productStatus;

  CartItem({
    required this.id,
    required this.productId,
    required this.quantity,
    required this.productName,
    required this.unitPrice,
    required this.subtotal,
    required this.productStatus,
  });

  factory CartItem.fromJson(Map<String, dynamic> json) => CartItem(
    id: json['id'],
    productId: json['product_id'],
    quantity: json['quantity'],
    productName: json['product_name'],
    unitPrice: json['unit_price'],
    subtotal: json['subtotal'],
    productStatus: json['product_status'],
  );
}
```

`lib/features/cart/data/cart.dart` を作成：

```dart
import 'cart_item.dart';

class Cart {
  final List<CartItem> items;
  final int totalAmount;

  Cart({required this.items, required this.totalAmount});

  factory Cart.fromJson(Map<String, dynamic> json) => Cart(
    items: (json['items'] as List)
        .map((e) => CartItem.fromJson(e as Map<String, dynamic>))
        .toList(),
    totalAmount: json['total_amount'],
  );
}
```

---

### 5-6. CartRepository（Flutter）

`lib/features/cart/data/cart_repository.dart` を作成：

```dart
import '../../../core/api/dio_client.dart';
import 'cart.dart';

class CartRepository {
  Future<Cart> getCart() async {
    final response = await dio.get('/cart');
    return Cart.fromJson(response.data as Map<String, dynamic>);
  }

  Future<Cart> addItem({required int productId, int quantity = 1}) async {
    final response = await dio.post('/cart/items', data: {
      'product_id': productId,
      'quantity': quantity,
    });
    return Cart.fromJson(response.data as Map<String, dynamic>);
  }

  Future<Cart> updateItem(int itemId, int quantity) async {
    final response = await dio.patch('/cart/items/$itemId', data: {
      'quantity': quantity,
    });
    return Cart.fromJson(response.data as Map<String, dynamic>);
  }

  Future<void> removeItem(int itemId) async {
    await dio.delete('/cart/items/$itemId');
  }
}
```

---

### 5-7. カート画面

`lib/features/cart/ui/cart_screen.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/cart.dart';
import '../data/cart_item.dart';
import '../data/cart_repository.dart';

class CartScreen extends StatefulWidget {
  const CartScreen({super.key});
  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  final _repo = CartRepository();
  Cart? _cart;
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _isLoading = true; _error = null; });
    try {
      final cart = await _repo.getCart();
      setState(() { _cart = cart; _isLoading = false; });
    } catch (e) {
      setState(() { _error = '取得に失敗しました'; _isLoading = false; });
    }
  }

  Future<void> _updateQuantity(CartItem item, int newQuantity) async {
    try {
      final cart = await _repo.updateItem(item.id, newQuantity);
      setState(() { _cart = cart; });
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('更新に失敗しました')),
        );
      }
    }
  }

  Future<void> _removeItem(int itemId) async {
    try {
      await _repo.removeItem(itemId);
      _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('削除に失敗しました')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_error != null) return Scaffold(body: Center(child: Text(_error!)));

    final cart = _cart!;

    return Scaffold(
      appBar: AppBar(title: const Text('カート')),
      body: cart.items.isEmpty
        ? const Center(child: Text('カートに商品がありません'))
        : Column(
            children: [
              Expanded(
                child: ListView.builder(
                  itemCount: cart.items.length,
                  itemBuilder: (context, index) {
                    final item = cart.items[index];
                    return ListTile(
                      title: Text(item.productName),
                      subtitle: Text('¥${item.unitPrice} × ${item.quantity} = ¥${item.subtotal}'),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(
                            icon: const Icon(Icons.remove_circle_outline),
                            onPressed: item.quantity > 1
                              ? () => _updateQuantity(item, item.quantity - 1)
                              : null,
                          ),
                          Text('${item.quantity}'),
                          IconButton(
                            icon: const Icon(Icons.add_circle_outline),
                            onPressed: item.quantity < 99
                              ? () => _updateQuantity(item, item.quantity + 1)
                              : null,
                          ),
                          IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () => _removeItem(item.id),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: Colors.grey.shade300)),
                ),
                child: Column(
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('合計金額', style: TextStyle(fontSize: 16)),
                        Text(
                          '¥${cart.totalAmount}',
                          style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: () {
                          // Phase 6 で注文確認画面に遷移する
                        },
                        child: const Text('購入手続きへ'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
    );
  }
}
```

---

## 確認チェックリスト

Phase 5 完了の判断基準：

```
[ ] migrations/008〜010 が実行済みで 3 テーブルが存在する
[ ] POST /products/:id/favorite でお気に入り登録できる
[ ] POST /products/:id/favorite を重複して送っても 200 が返る（冪等）
[ ] DELETE /products/:id/favorite でお気に入り削除できる
[ ] DELETE /products/:id/favorite で未登録商品 → 204 が返る（冪等）
[ ] GET /me/favorites でお気に入り一覧が返る（商品情報含む）
[ ] POST /products/:id/favorite でトークンなし → 401 が返る
[ ] 存在しない商品へのお気に入り登録 → 404 が返る
[ ] GET /cart で初回アクセス時に空のカートが返る（カートが自動作成される）
[ ] POST /cart/items でカートに商品を追加できる
[ ] POST /cart/items で同じ商品を再度追加すると数量が加算される
[ ] PATCH /cart/items/:id で数量を変更できる（レスポンスにカート全体が返る）
[ ] DELETE /cart/items/:id でカートアイテムを削除できる
[ ] POST /cart/items で販売停止商品を追加 → 422 が返る
[ ] POST /cart/items で存在しない商品を追加 → 404 が返る
[ ] PATCH /cart/items/:id で他ユーザーのアイテムを変更 → 403 が返る
[ ] DELETE /cart/items/:id で他ユーザーのアイテムを削除 → 403 が返る
[ ] カートの total_amount が items の unit_price × quantity の総和と一致する
[ ] Flutter アプリでお気に入りボタンをタップして登録・解除できる
[ ] Flutter アプリでお気に入り一覧画面が表示される
[ ] Flutter アプリでカート画面が表示される（商品名・価格・数量・合計）
[ ] Flutter アプリでカート内の数量を変更できる（+ / - ボタン）
[ ] Flutter アプリでカートから商品を削除できる
[ ] openapi.yaml に favorites・cart エンドポイントが定義されている
[ ] openapi.yaml に Favorite・Cart・CartItem・AddCartItemRequest・UpdateCartItemRequest スキーマが定義されている
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|---|---|
| UNIQUE制約の役割 | アプリ側でチェックしても並行リクエストで競合が起きる可能性がある。DB の UNIQUE 制約があれば二重登録を確実に防げる |
| INSERT IGNORE | UNIQUE 制約違反を「エラーなし」で無視する MySQL 構文。冪等な登録操作に適している。`affectedRows` で実際に挿入されたか判別できる |
| ON DUPLICATE KEY UPDATE | INSERT 時に UNIQUE 違反が発生した場合、エラーにせず UPDATE 処理に切り替える MySQL 構文。カートへの「追加で数量加算」に使用。`VALUES(col)` で「INSERT しようとした値」を参照できる |
| findOrCreate パターン | 「あれば返し、なければ作って返す」操作を 1 メソッドにまとめるパターン。INSERT IGNORE + SELECT の 2 段構成でロック不要の安全な実装になる |
| カート価格の扱い | cart_items には価格を保存しない。カート表示時は `JOIN products` で現在価格を取得することで出品者の価格変更がリアルタイムに反映される。注文確定時にサーバーが最新価格を `order_items.unit_price` にコピーする（Phase 6） |
| 冪等性 | 同じリクエストを何度送っても同じ結果になる設計。お気に入り登録は重複時も 200 を返すことで、ネットワーク再送時も安全になる |
| 422 Unprocessable Entity | 入力形式は正しい（400 ではない）が業務ルールで処理できない場合に使用。「販売停止商品はカートに追加できない」のような業務制約違反に適している |
| カートアイテムの所有者チェック | `cart_items.id` → `JOIN carts` → `carts.user_id` の 1 クエリで所有者を確認。`cart_id` を受け取らなくても `item_id` だけで「誰のカートか」を特定できる |
| JOIN 結果のネスト変換 | SQL の JOIN はフラットな行を返す。`{ product: { id, name, ... } }` のようなネスト構造への変換はサービス層の責務とすることでリポジトリをシンプルに保てる |
