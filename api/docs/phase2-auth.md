# Phase 2 - 認証・認可 詳細作業ログ

## 概要

Phase 1 で構築した商品一覧APIに認証・認可機能を追加する。
「誰がリクエストしているか」を識別し、認証が必要なエンドポイントを保護する。

- bcryptjs でパスワードをハッシュ化してDBに保存
- ログイン成功時にJWT（JSON Web Token）を発行
- 認証Middleware で `Authorization: Bearer <token>` ヘッダーを検証
- Phase 1 で省略していた `seller_id` を products テーブルおよびOpenAPIスキーマに追加

### tokenとは何か・認証と認可の違い

**認証**（Authentication）＝「誰か」の確認
→ tokenがあり署名が正しい → このtokenに紐づくユーザーが存在する

**認可**（Authorization）＝「何ができるか」の確認
→ `req.user.role === 'seller'` → 出品操作を許可する

tokenはその両方の**起点**。ログイン成功時に発行されるJWTの中に `id`・`role` が入っており、`jwt.verify()` 1回でそれを取り出せる。

```
リクエスト(Authorization: Bearer <token>)
    ↓
authenticate middleware が jwt.verify() → req.user に { id, role } をセット
    ↓
Controller / 認可Middleware で参照
    ├── id   → 「誰のリソースか」判定（自分のデータのみ操作可など）
    └── role → 「この操作を許可するか」判定（seller のみ出品可など）
```

tokenの中に `role` が入っているためDBを参照せずに権限判定できる（ステートレス）。
Flutterから `Authorization: Bearer <token>` を送っていたのは、このフローにtokenを渡すため。
今後 `seller` 限定エンドポイントを追加するなら `req.user.role !== 'seller'` で弾くmiddlewareを1枚追加するだけ。

---

## 1. パッケージインストール

```bash
npm i bcryptjs jsonwebtoken
npm i -D @types/bcryptjs @types/jsonwebtoken
```

| パッケージ | 役割 |
|---|---|
| `bcryptjs` | パスワードのハッシュ化・照合。`bcrypt` の純JS実装でネイティブ依存なし |
| `jsonwebtoken` | JWT（ログイン状態を示すトークン）の生成・検証 |

---

## 2. .env に JWT_SECRET 追加

```
JWT_SECRET=your-very-long-secret-key-change-in-production
```

*開発用として「dev-secret-key-32chars-minimum!!」を入れる（32文字）

`JWT_SECRET` はトークンの署名に使う秘密鍵。漏洩するとトークンを偽造されるため、本番環境では32文字以上のランダム文字列を使う。

`src/app.ts` の先頭に起動時バリデーションを追加：

```typescript
import 'dotenv/config';

if (!process.env.JWT_SECRET) throw new Error('環境変数 JWT_SECRET が設定されていません');
```

---

## 3. DB（テーブル作成・更新）

### 3-1. migrations/003_create_users.sql

```sql
CREATE TABLE users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('buyer', 'seller', 'admin') NOT NULL DEFAULT 'buyer',
  status        ENUM('active', 'banned') NOT NULL DEFAULT 'active',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

実行：

```bash
mysql market < migrations/003_create_users.sql
```

| カラム | 理由 |
|---|---|
| `email UNIQUE` | 同じメールでの複数登録をDB制約で防ぐ |
| `password_hash` | パスワードの平文は保存しない。bcryptハッシュ値を格納 |
| `role ENUM` | 取りうる権限を制限値で管理 |
| `status ENUM` | アカウント無効化（BAN）をDB側で管理 |

### 3-2. migrations/004_add_seller_id_to_products.sql

Phase 1 で省略していた `seller_id` を追加する。既存レコード（Phase 1 のシードデータ20件）があるため、NULLABLEで追加→データ更新→NOT NULL化の順で実行する。

`migrations/004_add_seller_id_to_products.sql` を作成：

```sql
-- Step 1: NULLABLEで追加（既存レコードがあるためいきなりNOT NULLにできない）
ALTER TABLE products ADD COLUMN seller_id INT UNSIGNED AFTER id;

-- Step 2 と 3 はシードユーザー投入後に手動で実行（下記 3-3 を参照）
-- UPDATE products SET seller_id = 1;
-- ALTER TABLE products
--   MODIFY COLUMN seller_id INT UNSIGNED NOT NULL,
--   ADD CONSTRAINT fk_products_seller FOREIGN KEY (seller_id) REFERENCES users(id);
```

Step 1 のみ先に実行：

```bash
mysql market < migrations/004_add_seller_id_to_products.sql
```

確認：

```bash
# NULL確認
mysql market -e "SELECT * FROM products;"
```

### 3-3. シードデータ投入（開発用ユーザー）

bcryptハッシュはSQL内で生成できないため、Node.jsスクリプトで投入する。

`seeds/users.ts` を作成：

```typescript
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/connection.js';

const users = [
  { email: 'seller@example.com', password: 'password123', role: 'seller' },
  { email: 'buyer@example.com',  password: 'password123', role: 'buyer'  },
];

for (const u of users) {
  const hash = await bcrypt.hash(u.password, 10);
  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)`,
    [u.email, hash, u.role]
  );
}
console.log('Users seeded');
process.exit(0);
```

実行：

```bash
npx tsx seeds/users.ts
```

確認：

```bash
# レコード確認
mysql market -e "SELECT * FROM users;"
```

**tsconfig の対応が必要**：`seeds/` は `src/` の外にあるため、main の tsconfig（`rootDir: "./src"` / `exclude: ["seeds"]`）では seeds ファイルが TypeScript プロジェクトに含まれない。この状態だと VSCode 上で以下の型エラーが出る。

- `pool.query` が存在しない（`moduleResolution: nodenext` が未適用のため mysql2/promise の型が正しく解決されない）
- `process` が見つからない（`types: ["node"]` が未適用）

`seeds/tsconfig.json` を作成して seeds 専用の設定を持たせる（main tsconfig は変更しない）：

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "rootDir": "..",
    "noEmit": true
  },
  "include": ["./**/*", "../src/**/*"]
}
```

VSCode は編集中のファイルに最も近い tsconfig を自動で使うため、`seeds/users.ts` を開くと `seeds/tsconfig.json` が適用される。`noEmit: true` により seeds は dist へコンパイルされず、スクリプトとして `npx tsx` で直接実行する運用のまま維持できる。

**bcryptのコスト（salt rounds）とは**：`bcrypt.hash(password, 10)` の `10` は計算を2^10 = 1024回繰り返すことを意味する。計算に意図的に時間（〜100ms）をかけることでブルートフォース攻撃を遅くする。数字が大きいほど安全だが、ログインのたびに時間がかかる。

ユーザー投入後、migration の Step 2・3 を実行：

```bash
mysql market -e "UPDATE products SET seller_id = 1;"

mysql market -e "
ALTER TABLE products
  MODIFY COLUMN seller_id INT UNSIGNED NOT NULL,
  ADD CONSTRAINT fk_products_seller FOREIGN KEY (seller_id) REFERENCES users(id);
"
```

| 句 | 意味 |
|---|---|
| `MODIFY COLUMN seller_id INT UNSIGNED NOT NULL` | Step 1 でNULLABLEとして追加したカラムに `NOT NULL` 制約を付与し直す。Step 2 の UPDATE で全レコードに値が入った後でないとこの変更はエラーになる |
| `ADD CONSTRAINT fk_products_seller` | 外部キー制約に名前をつけて追加。命名規則は `fk_制約を持つテーブル_参照先テーブル` が一般的（この場合 `fk_products_users` が正確だが、`seller_id` カラム名由来で `fk_products_seller` としている）。名前をつけることで `ALTER TABLE products DROP FOREIGN KEY fk_products_seller` のように後から削除できる |
| `FOREIGN KEY (seller_id)` | 外部キーとして扱うカラムを指定 |
| `REFERENCES users(id)` | 参照先を `users` テーブルの `id` カラムに指定。これにより `users` に存在しない `id` を `seller_id` に設定しようとするとDBがエラーを返す |

確認：

```bash
# レコード確認
mysql market -e "SELECT * FROM products;"

# テーブル確認
mysql market -e "DESCRIBE products;"

# 外部キー制約の確認（fk_products_seller）
mysql market -e "SHOW CREATE TABLE products;"
```

---

## 4. OpenAPI（仕様更新）

### 4-1. 認証エンドポイント追加

`openapi.yaml` の `paths:` セクションに追記：

```yaml
  /auth/register:
    post:
      summary: 会員登録
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email, password]
              properties:
                email:
                  type: string
                  format: email
                password:
                  type: string
                  minLength: 8
      responses:
        '201':
          description: 登録成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AuthResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
        '409':
          $ref: '#/components/responses/Conflict'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /auth/login:
    post:
      summary: ログイン
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email, password]
              properties:
                email:
                  type: string
                  format: email
                password:
                  type: string
      responses:
        '200':
          description: ログイン成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AuthResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /me:
    get:
      summary: 認証済みユーザー情報取得
      security:
        - BearerAuth: []
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '500':
          $ref: '#/components/responses/InternalServerError'
    patch:
      summary: プロフィール更新
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                email:
                  type: string
                  format: email
                password:
                  type: string
                  minLength: 8
      responses:
        '200':
          description: 更新成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '409':
          $ref: '#/components/responses/Conflict'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

### 4-2. securitySchemes・新スキーマ・新レスポンス追加

`components:` セクションに追記：

```yaml
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  schemas:
    User:
      type: object
      properties:
        id:
          type: integer
        email:
          type: string
          format: email
        role:
          type: string
          enum: [buyer, seller, admin]
        status:
          type: string
          enum: [active, banned]
        created_at:
          type: string
          format: date-time

    AuthResponse:
      type: object
      properties:
        token:
          type: string
        user:
          $ref: '#/components/schemas/User'
```

`components/responses:` に追記：

```yaml
    BadRequest:
      description: バリデーションエラー
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string

    Unauthorized:
      description: 認証エラー
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string

    Conflict:
      description: リソースの重複
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
```

**`components/responses` と `components/schemas` の使い分け**

| | responses | schemas |
|---|---|---|
| 含むもの | ステータスコード＋ボディ | データの形のみ |
| 向いているケース | 常に同じステータスで返す（404・401など） | 複数のステータスコードで同じ形を使い回す |

`AuthResponse` を `schemas` に置いた理由は、register（201）と login（200）でステータスコードが異なるため。`responses` に入れるとステータスコードが固定になり両方から使い回せない。`schemas` に入れることでデータの形だけを定義し、呼び出し側でステータスコードを自由に指定できる。

```yaml
# register → 201 で使う
'201':
  content:
    schema:
      $ref: '#/components/schemas/AuthResponse'

# login → 200 で使う
'200':
  content:
    schema:
      $ref: '#/components/schemas/AuthResponse'
```

`BadRequest`・`Unauthorized` は常に同じステータスコードとセットで返すため `responses` に置いている。

### 4-3. Product スキーマに seller_id 追加

`components/schemas/Product` の `properties` を更新：

```yaml
    Product:
      type: object
      properties:
        id:
          type: integer
        seller_id:
          type: integer
        name:
          type: string
        description:
          type: string
          nullable: true
        price:
          type: integer
        stock:
          type: integer
        status:
          type: string
          enum: [draft, published, archived]
        created_at:
          type: string
          format: date-time
```

---

## 5. API実装

### 5-1. errors/ - 認証エラークラス追加

`src/errors/AppError.ts` に追記：

```typescript
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, message);
  }
}
```

既存の `if (err instanceof AppError)` チェックがこれらも自動的にハンドリングするため、`errorHandler.ts` の変更は不要。

**401 vs 403 の使い分け**：

| コード | 意味 | 例 |
|---|---|---|
| 401 Unauthorized | 誰かわからない（未認証） | トークンなし・期限切れ |
| 403 Forbidden | 誰かはわかるが権限がない | 他人の商品を編集しようとした |

---

### 5-2. types/ - Express Request 型拡張

`src/types/express.d.ts` を作成：

```typescript
export {};

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; email: string; role: string };
    }
  }
}
```

**なぜ必要か**：Expressの `Request` には `user` プロパティが存在しない。認証Middlewareが `req.user` をセットすることをTypeScriptに伝えるために型定義を拡張する。`export {}` はこのファイルをモジュールとして認識させるために必要。

---

### 5-3. schemas/ - 認証バリデーション定義

`src/schemas/authSchema.ts` を作成：

```typescript
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const updateProfileSchema = z.object({
  email: z.email().optional(),
  password: z.string().min(8).optional(),
});
```

**`loginSchema` で password を `min(1)` にする理由**：ログイン時は「正しいパスワードか検証する」ためにサービス層でbcrypt.compareを実行する。8文字未満でもDBに照合しに行き、存在しなければ同じエラーメッセージを返す。バリデーションで事前拒否するより「メールまたはパスワードが正しくありません」と統一することで、攻撃者にパスワードの長さ情報を与えない。

**`updateProfileSchema` の `.optional()` と `exactOptionalPropertyTypes`**：Zodの `.optional()` を付けたフィールドの推論型は `string | undefined` になる（プロパティが存在してもvalueが `undefined` になりうる）。`tsconfig.json` で `exactOptionalPropertyTypes: true` が有効な場合、受け取り側の型が `email?: string`（`undefined` なし）だと型エラーになる。そのため `updateMe()` の引数型は `email?: string | undefined` と明示する必要がある（5-5 参照）。

---

### 5-4. repositories/ - userRepository

`src/repositories/userRepository.ts` を作成：

```typescript
import { pool } from '../db/connection.js';

export const userRepository = {
  // ログインで使用：email でユーザーを検索（password_hash も取得して照合に使う）
  async findByEmail(email: string) {
    const [rows] = await pool.query(
      `SELECT id, email, password_hash, role, status, created_at FROM users WHERE email = ?`,
      [email]
    ) as any[]; // mysql2 の戻り値は [rows, fields] のタプル。[rows] で行データだけを取り出す
    return rows[0] ?? null; // 0件のとき rows[0] は undefined → null を返す
  },

  // 認証済みユーザー情報取得で使用：password_hash はレスポンスに不要なため SELECT しない
  async findById(id: number) {
    const [rows] = await pool.query(
      `SELECT id, email, role, status, created_at FROM users WHERE id = ?`,
      [id]
    ) as any[];
    return rows[0] ?? null;
  },

  // 会員登録で使用：email とハッシュ済みパスワードを INSERT し、生成された id を返す
  async create(email: string, passwordHash: string) {
    const [result] = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES (?, ?)`,
      [email, passwordHash]
    ) as any[];
    return result.insertId as number; // AUTO_INCREMENT で採番された新規 id
  },

  // プロフィール更新で使用：渡されたフィールドだけ UPDATE する動的 SQL
  async updateById(id: number, fields: { email?: string; passwordHash?: string }) {
    const sets: string[] = [];    // SET 句の断片（例: ['email = ?', 'password_hash = ?']）
    const values: unknown[] = []; // プレースホルダーに対応する値
    // undefined でない（実際に渡された）フィールドだけ SET 句に追加
    if (fields.email !== undefined) {
      sets.push('email = ?');
      values.push(fields.email);
    }
    if (fields.passwordHash !== undefined) {
      sets.push('password_hash = ?');
      values.push(fields.passwordHash);
    }
    if (sets.length === 0) return; // 更新するものがなければ何もしない
    values.push(id); // WHERE id = ? に対応する値を末尾に追加
    // sets.join(', ') → 'email = ?, password_hash = ?' のように結合して SQL を組み立てる
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, values);
  },
};
```

**`findById` に `password_hash` を含めない理由**：`GET /me` など認証済みユーザー情報を返す際にパスワードハッシュを誤ってレスポンスに含めないようにする。`findByEmail` のみパスワード照合のために取得する。

---

### 5-5. services/ - authService

`src/services/authService.ts` を作成：

```typescript
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { userRepository } from '../repositories/userRepository.js';
import { ConflictError, NotFoundError, UnauthorizedError } from '../errors/AppError.js';

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = '7d'; // トークンの有効期限：7日

export const authService = {
  async register(email: string, password: string) {
    // 同じメールが既に登録されていたら 409 Conflict
    const existing = await userRepository.findByEmail(email);
    if (existing) throw new ConflictError('このメールアドレスは既に登録されています');

    // パスワードをハッシュ化（10ラウンド = 2^10 回の計算。平文は保存しない）
    const passwordHash = await bcrypt.hash(password, 10);
    const id = await userRepository.create(email, passwordHash);
    const user = await userRepository.findById(id); // INSERT 後に改めて取得（password_hash を除いた形で）

    // jwt.sign() で署名付き JWT（JWS）を生成する
    // JWT には「署名（JWS）」と「暗号化（JWE）」の2種類があるが、
    // jsonwebtoken ライブラリは JWS のみ対応しており JWE は非対応（JWE が必要なら jose ライブラリを使う）
    // JWS はペイロードを Base64url エンコードするだけなので誰でもデコードして中身を読める。
    // 「改ざんを検知する署名」であり「内容を隠す暗号化」ではない。
    //
    // もしペイロードに password_hash を含めた場合：
    // JWT はレスポンスボディ・通信ログ・ブラウザの開発者ツール・フロント側ストレージなど
    // 多くの場所を経由するため、トークンが漏れる経路はDBよりはるかに多い。
    // 攻撃者がトークンを1つ入手するだけでハッシュ値を取り出せてしまい、
    // サーバーのレートリミットを一切受けずにオフラインでブルートフォース攻撃が可能になる。
    // bcrypt のコスト係数で遅くしてあっても、ハッシュさえあればローカルで総当たりできる。
    // そのためペイロードには password_hash や個人情報を絶対に含めず、id・email・role だけにする
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    return { token, user };
  },

  async login(email: string, password: string) {
    const user = await userRepository.findByEmail(email);
    // ユーザーが存在しない場合も bcrypt.compare と同じパスを通り、同じエラーを返す（ユーザー列挙攻撃防止）
    // bcrypt.compare はリクエストの平文 password と DB の password_hash を照合し、一致すれば true を返す
    // && の短絡評価により user が null なら compare は実行されず isValid は null（falsy）になる
    const isValid = user && await bcrypt.compare(password, user.password_hash);
    if (!isValid) throw new UnauthorizedError('メールアドレスまたはパスワードが正しくありません');

    // 分割代入で password_hash を除外し、残りを safeUser としてレスポンスに使う
    const { password_hash, ...safeUser } = user;
    // jwt.sign() は署名（JWS）を生成する。ペイロードは Base64url エンコードのみで誰でも読めるため
    // password_hash を safeUser から除いた後に sign する（register と同じ理由）
    const token = jwt.sign(
      { id: safeUser.id, email: safeUser.email, role: safeUser.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    return { token, user: safeUser };
  },

  async getMe(id: number) {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('ユーザーが見つかりません');
    return user;
  },

  async updateMe(id: number, fields: {email?: string | undefined, password?: string | undefined}){
    if (fields.email) {
      // 変更先のメールアドレスが他のユーザーに使われていないか確認
      const existing = await userRepository.findByEmail(fields.email);
      if (existing && existing.id !== id) throw new ConflictError('このメールアドレスは既に使用されています');
    }
    const updates: { email?: string; passwordHash?: string } = {};
    if (fields.email)    updates.email        = fields.email;
    if (fields.password) updates.passwordHash = await bcrypt.hash(fields.password, 10); // 新パスワードをハッシュ化

    await userRepository.updateById(id, updates);
    return userRepository.findById(id); // 更新後の値を返す
  },
};
```

**`updateMe()` の引数型に `| undefined` が必要な理由**：`updateProfileSchema.parse()` の戻り値型は `{ email?: string | undefined; password?: string | undefined }` （Zodの `.optional()` 由来）。`exactOptionalPropertyTypes: true` の環境では `email?: string`（`undefined` なし）と `email?: string | undefined` は別の型として扱われるため、引数型を `email?: string | undefined` と明示しないとコンパイルエラーになる（5-3 参照）。

**ユーザー列挙攻撃の防止**：

```typescript
const user = await userRepository.findByEmail(email);
const isValid = user && await bcrypt.compare(password, user.password_hash);
if (!isValid) throw new UnauthorizedError('メールアドレスまたはパスワードが正しくありません');
```

メールが存在しない場合も「パスワードが正しくありません」と同じメッセージを返す。「このメールは存在しません」と返すと攻撃者にアカウントの存在を教えることになる。

**JWTペイロードに最小限の情報だけ入れる理由**：JWTはBase64エンコードなので誰でもデコードして中身を読める（署名は「改ざん防止」であり「暗号化」ではない）。パスワードハッシュや個人情報は絶対に含めない。

---

### 5-6. middlewares/ - 認証Middleware

`src/middlewares/authenticate.ts` を作成：

```typescript
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../errors/AppError.js';

const JWT_SECRET = process.env.JWT_SECRET!;

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization; // 'Bearer eyJ...' の形式で届く
  // ヘッダーがない、または 'Bearer ' で始まらない場合は 401
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('認証トークンがありません'));
  }

  const token = authHeader.slice(7); // 'Bearer '（7文字）を取り除いてトークン部分だけ取り出す
  try {
    // 署名の検証と有効期限チェックを同時に行う。改ざん・期限切れなら例外が投げられる
    const payload = jwt.verify(token, JWT_SECRET) as { id: number; email: string; role: string };
    req.user = payload; // 検証済みのユーザー情報をリクエストに付与（後続の Controller で req.user.id などを参照できる）
    next(); // 認証成功：次のミドルウェアまたは Controller に処理を渡す
  } catch {
    // 署名不一致・期限切れなど jwt.verify が投げた例外をまとめて 401 にする
    next(new UnauthorizedError('トークンが無効または期限切れです'));
  }
}
```

**有効期限チェックの仕組み**：

`jwt.sign()` でトークン生成時、ペイロードに `exp`（Unix秒）が自動付与される。

```
// jwt.sign(..., { expiresIn: '7d' }) が生成するペイロード（Base64デコードすると見える）
{
  "id": 1,
  "email": "seller@example.com",
  "role": "seller",
  "iat": 1720000000,   ← 発行時刻（issued at）
  "exp": 1720604800    ← 失効時刻（= iat + 7日分の秒数）
}
```

`jwt.verify()` は内部で以下を実行：

```
現在時刻(Unix秒) > exp  →  TokenExpiredError を throw
現在時刻(Unix秒) ≤ exp  →  ペイロードを返す（認証成功）
```

時刻の比較だけで判定しており、DBアクセスは発生しない。JWTが「ステートレス」と呼ばれる理由がこれ（サーバー側にセッション情報を持たない）。

**`jwt.verify` が投げる例外**：

| エラー | 原因 |
|---|---|
| `JsonWebTokenError` | 署名不一致・フォーマット不正 |
| `TokenExpiredError` | 有効期限切れ |

どちらも同じ401を返してよい（攻撃者に理由を教える必要はない）。
逆に理由を教えてしまうケース：`"トークンの有効期限が切れています"` や `"署名が不正です"` のように種別を返すと、攻撃者は「署名エラー→トークン偽造に失敗した」「期限切れ→正規トークンを入手済みで再利用を試みている」と戦略を切り替えられる。

実装では `"トークンが無効または期限切れです"` と `JsonWebTokenError`・`TokenExpiredError` を同一メッセージに束ねているため、どちらのエラーか判別不能→このケースには該当しない。

---

### 5-7. controllers/ - authController

`src/controllers/authController.ts` を作成：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService.js';
import { registerSchema, loginSchema, updateProfileSchema } from '../schemas/authSchema.js';

export const authController = {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const body = registerSchema.parse(req.body); // Zod でバリデーション（失敗すると ZodError → 400 になる）
      const result = await authService.register(body.email, body.password);
      res.status(201).json(result); // 201 Created：リソースが新規作成されたことを示す
    } catch (error) {
      next(error); // 共通エラーハンドラーへ転送
    }
  },

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const body = loginSchema.parse(req.body);
      const result = await authService.login(body.email, body.password);
      // res.json() はデフォルトで 200 を付与するため res.status(200) の明示不要
      res.json(result); // 200 OK：既存リソースの取得なので 201 ではなく 200
    } catch (error) {
      next(error);
    }
  },

  async me(req: Request, res: Response, next: NextFunction) {
    try {
      // req.user は authenticate ミドルウェアがセットした値（! で null でないと TypeScript に保証）
      const user = await authService.getMe(req.user!.id);
      res.json(user);
    } catch (error) {
      next(error);
    }
  },

  async updateMe(req: Request, res: Response, next: NextFunction) {
    try {
      const body = updateProfileSchema.parse(req.body); // 全フィールドがオプション（送られたものだけ更新）
      const user = await authService.updateMe(req.user!.id, body);
      res.json(user); // 更新後のユーザー情報を返す
    } catch (error) {
      next(error);
    }
  },
};
```

---

### 5-8. routes/ - ルーター定義

`src/routes/authRoutes.ts` を作成（認証不要のエンドポイント）：

```typescript
import { Router } from 'express';
import { authController } from '../controllers/authController.js';

const router = Router();

router.post('/register', authController.register);
router.post('/login', authController.login);

export default router;
```

`src/routes/userRoutes.ts` を作成（認証必須のエンドポイント）：

```typescript
import { Router } from 'express';
import { authController } from '../controllers/authController.js';
import { authenticate } from '../middlewares/authenticate.js';

const router = Router();

router.get('/me', authenticate, authController.me);
router.patch('/me', authenticate, authController.updateMe);

export default router;
```

**2つに分ける理由**：`/auth/register`・`/auth/login` は認証不要だが `/me` は認証必須。ルーターを分けることで `authenticate` を適用する範囲が明確になる。

**`router.get` の引数順序**：第1引数はパス（固定・必須）、第2引数以降はハンドラーを左から順に実行。`router.get('/me', authenticate, authController.me)` なら `authenticate` → `authController.me` の順。`authenticate` 内で `next()` を呼ぶことで次のハンドラーへ制御が移る。個数上限はなく、`router.get('/path', mw1, mw2, mw3, handler)` のように何個でも連鎖可能。

---

### 5-9. productRepository に seller_id を追加

`src/repositories/productRepository.ts` のSELECT文を更新：

```typescript
async findAll(limit: number, offset: number) {
  const [rows] = await pool.query(
    `SELECT id, seller_id, name, description, price, stock, status, created_at
     FROM products
     WHERE status = 'published'
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return rows;
},

async findById(id: number) {
  const [rows] = await pool.query(
    `SELECT id, seller_id, name, description, price, stock, status, created_at
     FROM products
     WHERE id = ? AND status = 'published'`,
    [id]
  ) as any[];
  return rows[0] ?? null;
},
```

---

### 5-10. app.ts にルーター登録

```typescript
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';

app.use('/api/v1/auth', authRoutes);  // POST /api/v1/auth/register, /api/v1/auth/login
app.use('/api/v1', userRoutes);       // GET/PATCH /api/v1/me
app.use('/api/v1/products', productRoutes);
```

---

### 5-11. 動作確認

```bash
# 会員登録
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
# → {"token":"eyJ...","user":{"id":3,"email":"test@example.com",...}}

# ログイン
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
# → {"token":"eyJ...","user":{...}}

# プロフィール取得（TOKEN は上記レスポンスの token 値）
curl http://localhost:3000/api/v1/me \
  -H "Authorization: Bearer TOKEN"
# → {"id":3,"email":"test@example.com","role":"buyer",...}

# トークンなしで /me アクセス（401確認）
curl http://localhost:3000/api/v1/me
# → {"error":"認証トークンがありません"}

# 誤ったパスワードでログイン（401確認）
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"wrongpassword"}'
# → {"error":"メールアドレスまたはパスワードが正しくありません"}

# 重複メールで登録（409確認）
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
# → {"error":"このメールアドレスは既に登録されています"}

# 商品一覧に seller_id が含まれること確認
curl http://localhost:3000/api/v1/products
# → {"data":[{"id":1,"seller_id":1,"name":"iPhone 14",...}],"total":20}
```


確認：

```bash
# レコード確認
mysql market -e "SELECT * FROM users;"

# テスト用レコード削除（動作確認後に実行）
mysql market -e "DELETE FROM users WHERE id = 3;"
```

---

#### Postman での確認

**ダウンロード**
ページ: https://www.postman.com/jp/downloads/

ブラウザ版だとlocalhost:3000のAPIが使えないので、アプリをダウンロードした上で利用する

**事前準備：環境変数の設定**

Postman の環境変数にトークンを保存しておくと、毎回コピペせずに認証付きリクエストを送れる。

1. 画面右上の「No Environment」→「Add new environment」
2. 環境名を「market-api」に設定
3. 変数 `token` を追加（Initial value・Current value は空でよい）
4. 「Save」→ 右上のドロップダウンで「market-api」を選択

**会員登録（POST /api/v1/auth/register）**

1. Method: `POST`、URL: `http://localhost:3000/api/v1/auth/register`
2. Headers タブ → `Content-Type: application/json`
3. Body タブ → raw → JSON を選択し以下を入力：
   ```json
   {
     "email": "test@example.com",
     "password": "password123"
   }
   ```
4. Scripts タブ → **After response** に以下を入力（レスポンスの `token` を環境変数に自動保存）：
   ```javascript
   const json = pm.response.json();
   pm.environment.set("token", json.token);
   ```
5. Send → 201 とトークン・ユーザー情報が返ること確認

**ログイン（POST /api/v1/auth/login）**

1. Method: `POST`、URL: `http://localhost:3000/api/v1/auth/login`
2. Headers: `Content-Type: application/json`
3. Body:
   ```json
   {
     "email": "test@example.com",
     "password": "password123"
   }
   ```
4. Scripts タブ → **After response** に会員登録と同じスクリプトを入力
5. Send → 200 とトークンが返り、環境変数 `token` に保存されること確認

**プロフィール取得（GET /api/v1/me）**

1. Method: `GET`、URL: `http://localhost:3000/api/v1/me`
2. Authorization タブ → Type: `Bearer Token` → Token: `{{token}}`
3. Send → 200 とユーザー情報が返ること確認

**トークンなしで /me アクセス（401確認）**

1. Authorization タブ → Type: `No Auth`
2. Send → 401 と `{"error":"認証トークンがありません"}` が返ること確認

**誤ったパスワードでログイン（401確認）**

1. ログインと同じリクエストで `password` を `wrongpassword` に変更
2. Send → 401 と `{"error":"メールアドレスまたはパスワードが正しくありません"}` が返ること確認

**重複メールで登録（409確認）**

1. 会員登録と同じリクエストを再送
2. Send → 409 と `{"error":"このメールアドレスは既に登録されています"}` が返ること確認

**商品一覧取得（GET /api/v1/products）**

認証不要。

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products`
2. Send → 200 と `{"data":[...],"total":20}` が返ること確認

ページネーションの確認（クエリパラメーター）：

1. Params タブ → 以下を追加：

   | KEY    | VALUE |
   |--------|-------|
   | limit  | 5     |
   | offset | 0     |

2. Send → `data` が5件・`total` が20であること確認
3. `offset` を `5` に変更して Send → 次の5件が返ること確認

**商品詳細取得（GET /api/v1/products/:productId）**

認証不要。

1. Method: `GET`、URL: `http://localhost:3000/api/v1/products/1`
2. Send → 200 と id:1 の商品情報が返ること確認

存在しないIDの確認：

1. URL を `http://localhost:3000/api/v1/products/9999` に変更
2. Send → 404 と `{"error":"..."}` が返ること確認

**環境変数 `token` が更新されているか確認する方法**

`pm.environment.set()` は ENVIRONMENTS タブの **Current Value** に書き込む。タブを開いたまま Send すると表示が古いままに見えることがある。

1. ENVIRONMENTS タブを一度閉じて再度開く（または別の環境に切り替えてから market-api に戻す）→ Current Value にトークンが入っていれば正常
2. スクリプトが正常に動いているか不明な場合は After response を以下に置き換えて Send し、Postman Console（View → Show Postman Console）で各ログを確認する：
   ```javascript
   console.log("body:", pm.response.text());
   const json = pm.response.json();
   console.log("token:", json.token);
   pm.environment.set("token", json.token);
   console.log("env token:", pm.environment.get("token"));
   ```
   `token:` と `env token:` に同じ値が出ていれば保存成功。ENVIRONMENTS タブの表示更新を待つだけでよい。

---

## 6. Flutter連携

### 6-1. flutter_secure_storage 設定

```bash
flutter pub add flutter_secure_storage
```

`lib/core/storage/secure_storage.dart` を作成：

```dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const _storage = FlutterSecureStorage();
const _tokenKey = 'jwt_token';

Future<void> saveToken(String token) => _storage.write(key: _tokenKey, value: token);
Future<String?> readToken() => _storage.read(key: _tokenKey);
Future<void> deleteToken() => _storage.delete(key: _tokenKey);
```

**なぜ SecureStorage か**：`SharedPreferences` はアプリのプライベートストレージに平文保存される。`flutter_secure_storage` はiOSのKeychainとAndroidのKeyStoreを使ってOSレベルで暗号化する。JWTのようなクレデンシャルには必須。

---

### 6-2. Dioインターセプター

`lib/core/api/dio_client.dart` を更新：

```dart
import 'package:dio/dio.dart';
import '../storage/secure_storage.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'http://localhost:3000/api/v1',
  connectTimeout: const Duration(seconds: 5),
  receiveTimeout: const Duration(seconds: 5),
  headers: {'Content-Type': 'application/json'},
));

void setupDioInterceptors() {
  dio.interceptors.add(InterceptorsWrapper(
    onRequest: (options, handler) async {
      final token = await readToken();
      if (token != null) {
        options.headers['Authorization'] = 'Bearer $token';
      }
      handler.next(options);
    },
  ));
}
```

`main.dart` の `main()` 内で呼び出す：

```dart
void main() {
  setupDioInterceptors();
  runApp(const MyApp());
}
```

**インターセプターとは**：Dioのすべてのリクエストが実行される前に割り込む処理。`onRequest` でヘッダーを追加することで、各APIコール時に手動でトークンをセットする必要がなくなる。

---

### 6-3. AuthRepository（Flutter）

`lib/features/auth/data/auth_repository.dart` を作成：

```dart
import '../../../core/api/dio_client.dart';
import '../../../core/storage/secure_storage.dart';

class AuthRepository {
  Future<void> register(String email, String password) async {
    final response = await dio.post('/auth/register', data: {
      'email': email,
      'password': password,
    });
    await saveToken(response.data['token'] as String);
  }

  Future<void> login(String email, String password) async {
    final response = await dio.post('/auth/login', data: {
      'email': email,
      'password': password,
    });
    await saveToken(response.data['token'] as String);
  }

  Future<Map<String, dynamic>> getMe() async {
    final response = await dio.get('/me');
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> updateMe({String? email, String? password}) async {
    final response = await dio.patch('/me', data: {
      if (email != null)    'email': email,
      if (password != null) 'password': password,
    });
    return response.data as Map<String, dynamic>;
  }

  Future<void> logout() => deleteToken();
}
```

---

### 6-4. 会員登録画面

`lib/features/auth/ui/register_screen.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/auth_repository.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});
  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _repo = AuthRepository();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isLoading = false;
  String? _error;

  Future<void> _register() async {
    setState(() { _isLoading = true; _error = null; });
    try {
      await _repo.register(_emailController.text, _passwordController.text);
      if (mounted) Navigator.pushReplacementNamed(context, '/products');
    } catch (e) {
      setState(() { _error = '登録に失敗しました'; });
    } finally {
      setState(() { _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('会員登録')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(
              controller: _emailController,
              decoration: const InputDecoration(labelText: 'メールアドレス'),
              keyboardType: TextInputType.emailAddress,
            ),
            TextField(
              controller: _passwordController,
              decoration: const InputDecoration(labelText: 'パスワード（8文字以上）'),
              obscureText: true,
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: const TextStyle(color: Colors.red)),
              ),
            const SizedBox(height: 16),
            _isLoading
              ? const CircularProgressIndicator()
              : ElevatedButton(onPressed: _register, child: const Text('登録')),
            TextButton(
              onPressed: () => Navigator.pushReplacementNamed(context, '/login'),
              child: const Text('ログインはこちら'),
            ),
          ],
        ),
      ),
    );
  }
}
```

---

### 6-5. ログイン画面

`lib/features/auth/ui/login_screen.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/auth_repository.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _repo = AuthRepository();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isLoading = false;
  String? _error;

  Future<void> _login() async {
    setState(() { _isLoading = true; _error = null; });
    try {
      await _repo.login(_emailController.text, _passwordController.text);
      if (mounted) Navigator.pushReplacementNamed(context, '/products');
    } catch (e) {
      setState(() { _error = 'メールアドレスまたはパスワードが正しくありません'; });
    } finally {
      setState(() { _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('ログイン')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(
              controller: _emailController,
              decoration: const InputDecoration(labelText: 'メールアドレス'),
              keyboardType: TextInputType.emailAddress,
            ),
            TextField(
              controller: _passwordController,
              decoration: const InputDecoration(labelText: 'パスワード'),
              obscureText: true,
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: const TextStyle(color: Colors.red)),
              ),
            const SizedBox(height: 16),
            _isLoading
              ? const CircularProgressIndicator()
              : ElevatedButton(onPressed: _login, child: const Text('ログイン')),
            TextButton(
              onPressed: () => Navigator.pushReplacementNamed(context, '/register'),
              child: const Text('アカウントをお持ちでない方はこちら'),
            ),
          ],
        ),
      ),
    );
  }
}
```

---

### 6-6. プロフィール画面

`lib/features/auth/ui/profile_screen.dart` を作成：

```dart
import 'package:flutter/material.dart';
import '../data/auth_repository.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});
  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _repo = AuthRepository();
  Map<String, dynamic>? _user;
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final user = await _repo.getMe();
      setState(() { _user = user; _isLoading = false; });
    } catch (e) {
      setState(() { _error = 'データの取得に失敗しました'; _isLoading = false; });
    }
  }

  Future<void> _logout() async {
    await _repo.logout();
    if (mounted) Navigator.pushReplacementNamed(context, '/login');
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!));

    return Scaffold(
      appBar: AppBar(title: const Text('プロフィール')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('メール: ${_user!['email']}'),
            Text('ロール: ${_user!['role']}'),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _logout,
              style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
              child: const Text('ログアウト'),
            ),
          ],
        ),
      ),
    );
  }
}
```

---

### 6-7. Product モデルに seller_id を追加

`lib/features/product/data/product.dart` を更新：

```dart
class Product {
  final int id;
  final int sellerId;
  final String name;
  final String? description;
  final int price;
  final int stock;
  final String status;
  final String createdAt;

  Product({
    required this.id,
    required this.sellerId,
    required this.name,
    this.description,
    required this.price,
    required this.stock,
    required this.status,
    required this.createdAt,
  });

  factory Product.fromJson(Map<String, dynamic> json) => Product(
    id: json['id'],
    sellerId: json['seller_id'],
    name: json['name'],
    description: json['description'] as String?,
    price: json['price'],
    stock: json['stock'],
    status: json['status'],
    createdAt: json['created_at'],
  );
}
```

---

## 確認チェックリスト

Phase 2 完了の判断基準：

```
[ ] POST /auth/register でユーザーを登録できる
[ ] POST /auth/login で正しいパスワード → JWTトークンが返る
[ ] POST /auth/login で誤ったパスワード → 401が返る
[ ] GET /me でトークンあり → ユーザー情報が返る
[ ] GET /me でトークンなし → 401が返る
[ ] 重複メールで登録 → 409が返る
[ ] PATCH /me でメール・パスワードを更新できる
[ ] FlutterアプリでJWTがSecureStorageに保存される
[ ] ログイン後のAPIリクエストに自動でAuthorizationヘッダーが付与される
[ ] GET /products レスポンスに seller_id が含まれる
[ ] openapi.yaml に /auth/register・/auth/login・/me が定義されている
[ ] openapi.yaml の Product スキーマに seller_id が追加されている
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|---|---|
| なぜパスワードを平文保存しないか | DBが漏洩した際に全ユーザーのパスワードが即座に危険にさらされるため。ハッシュは一方向関数なので元の値を復元できない |
| bcryptのコスト係数 | 計算を意図的に遅くしてブルートフォース攻撃に耐える。`10` ≒ 100ms/hash |
| JWTの仕組み | `header.payload.signature` の3部構成。payloadはBase64エンコードなので暗号化ではない。改ざん検知のみ |
| JWT vs セッション | JWTはサーバー側に状態を持たないためスケールしやすい。セッションはサーバー側ストアが必要 |
| 401 vs 403 | 401は「誰かわからない（認証せよ）」、403は「誰かはわかるが権限がない」 |
| ユーザー列挙攻撃 | 「このメールは存在しません」と返すとアカウントの存在を漏らす。認証失敗は常に同じメッセージを返す |
| SecureStorage | JWTをローカルに安全に保存する仕組み。iOSのKeychain・AndroidのKeyStoreを利用 |
| Dioインターセプター | 全リクエストに共通処理を挟む仕組み。認証ヘッダーの自動付与に使う |
