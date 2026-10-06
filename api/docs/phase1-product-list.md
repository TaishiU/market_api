# Phase 1 - 商品一覧 詳細作業ログ

## 概要

Flutter → Node.js API → MySQL の一連の流れを初めて通す。
認証・注文などは一切なく「商品を取得して表示する」だけに集中する。

---

## 1. 環境構築

### 1-1. Node.js + TypeScript + Express プロジェクト初期化

**やること**

```bash
mkdir market-api && cd market-api
npm init -y
```

`npm init -y` で `package.json` が生成される（`-y` はすべてデフォルト値で即作成）。

**必要パッケージのインストール**

```bash
# 実行時に必要
npm i express

# 開発時のみ必要（TypeScriptの型定義・コンパイラ等）
npm i -D typescript tsx @types/express @types/node
```

| パッケージ | 役割 |
|---|---|
| `express` | HTTPサーバーフレームワーク |
| `typescript` | TypeScriptコンパイラ |
| `tsx` | `.ts` ファイルをコンパイルなしで直接実行するツール。`module: nodenext` のESM環境でも動作する（`ts-node` の後継として推奨） |
| `@types/express` | ExpressのTypeScript型定義 |
| `@types/node` | Node.js組み込みAPIの型定義 |

---

### 1-2. tsconfig.json 設定

`tsconfig.json` はTypeScriptのコンパイル設定ファイル。

```bash
npx tsc --init
```

`npx tsc --init` を実行すると、インストールされているTypeScriptのバージョンに合わせた推奨値が自動設定される。現在のバージョンでは以下が生成される：

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    ...
  }
}
```

生成されたファイルの中から以下の項目を探してコメントアウトを外し、値を設定する：

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "rootDir": "./src",
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true
  }
}
```

| 設定 | 意味 |
|---|---|
| `target: "esnext"` | 最新のJS構文にコンパイル |
| `module: "nodenext"` | Node.jsのESModule方式を使う |
| `moduleResolution: "nodenext"` | importの解決方法をnodenextに合わせる |
| `rootDir` | TypeScriptソースの場所 |
| `outDir` | コンパイル済みJSの出力先 |
| `strict` | 型チェックを厳格にする |

**`nodenext` 使用時は `package.json` に `"type": "module"` が必要**：

```json
{
  "name": "market-api",
  "type": "module",
  ...
}
```

これがないと「ESMで書いているのにNode.jsがCommonJSとして扱う」矛盾が発生してエラーになる。

**`nodenext` での重要な注意点**：自作ファイルのimportには `.js` 拡張子が必要になる。

```typescript
// ❌ nodenext では動かない
import { pool } from '../db/connection';

// ✅ .js をつける（実体は.tsだが拡張子は.jsと書く）
import { pool } from '../db/connection.js';
```

node_modulesのパッケージ（express・mysql2等）はそのまま拡張子なしでOK。

---

### 1-3. src/app.ts 作成・起動確認

```typescript
import express from 'express';

const app = express();
const PORT = 3000;

app.use(express.json()); // JSONボディを受け取れるようにする

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

起動確認：

```bash
npm run dev
# → Server running on http://localhost:3000

# 別ターミナルで確認
curl http://localhost:3000/health
# → {"status":"ok"}
```

`curl` はターミナルからHTTPリクエストを送るコマンド。ブラウザでURLを開くのと同じ動作。

---

### 1-4. mysql2 インストール・DB接続設定

```bash
npm i mysql2
```

`mysql2` はNode.jsからMySQLに接続するためのライブラリ。

`src/db/connection.ts` を作成：

```typescript
import mysql from 'mysql2/promise';

const requiredEnv = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const;
for (const key of requiredEnv) {
  if (process.env[key] === undefined) throw new Error(`環境変数 ${key} が設定されていません`);
}

export const pool = mysql.createPool({
  host: process.env.DB_HOST!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASSWORD!,
  database: process.env.DB_NAME!,
  waitForConnections: true,
  connectionLimit: 10,
});
```

**コネクションプールとは**：DBへの接続を毎回作成・破棄すると遅い。あらかじめ接続を複数プールして使い回す仕組み。`connectionLimit: 10` は同時に最大10本の接続を保持する設定。

**なぜ `!` をつけるか**：`process.env.DB_HOST` の型は `string | undefined`（値がない可能性がある）。mysql2 は `undefined` を受け付けないため型エラーになる。直前のループで存在チェック済みなので `!`（Non-null assertion）で「ここでは必ず値がある」とTypeScriptに伝える。`.env` に記載漏れがあればサーバー起動時に即エラーになるため、本番環境での設定ミスを早期に検知できる。

---

### 1-5. .env で DB接続情報管理

```bash
npm i dotenv
```

`.env` ファイルを作成（**Gitにコミットしない**）：

```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=  ← 「2. MySQL インストール・初期設定」の 2-4 でパスワードを空に変更済みのため空欄
DB_NAME=market
PORT=3000
```

> **注意**：まだMySQLをインストールしていない場合はセクション2を先に実施すること。セクション2-4でパスワードを空に変更するため `DB_PASSWORD` は空欄のままでOK。

`src/app.ts` の先頭で読み込む：

```typescript
import 'dotenv/config';
```

`.env` をGit管理から除外：

```bash
echo ".env" >> .gitignore
```

**なぜ .env を使うか**：パスワードをコードに直書きするとGitHubに公開されてしまう。環境変数として外部ファイルに分離することでセキュリティリスクを回避する。

---

### 1-6. package.json にスクリプト追加

```json
{
  "scripts": {
    "dev": "tsx --watch src/app.ts",
    "build": "tsc",
    "start": "node dist/app.js"
  }
}
```

以降は `npm run dev` で起動できる。

`--watch`：ソースファイルの変更を検知して自動でサーバーを再起動するフラグ。これがないとコードを変更するたびに手動で再起動が必要になる。

---

## 2. MySQL インストール・初期設定

### 2-1. インストール

```bash
brew install mysql
```

### 2-2. 起動・自動起動設定

```bash
# 起動
brew services start mysql

# 起動確認
brew services list
# mysql が started になっていればOK
```

### 2-3. 初期セキュリティ設定

```bash
mysql_secure_installation
```

対話形式で以下を設定する：

```
VALIDATE PASSWORD component を使用するか？ → n（学習用なので不要）
root パスワードを設定するか？             → y
新しいパスワードを入力                    → 任意のパスワード（例: password123）
匿名ユーザーを削除するか？                → y
rootのリモートログインを禁止するか？       → y
testデータベースを削除するか？            → y
権限テーブルをリロードするか？            → y
```

ここで設定したパスワードが `.env` の `DB_PASSWORD` に入る。

### 2-4. rootパスワードを空に変更（確認コマンド省力化）

ローカル開発環境限定。毎回パスワード入力を省略するため空に変更する：

```bash
mysql -u root -p -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '';"
# 現在のパスワードを入力してEnter
```

以降 `-p` オプション不要になる：

```bash
# 変更後の接続確認
mysql -u root
# mysql> が表示されればOK → 「quit」と入力して enter で終了
```

`.env` の `DB_PASSWORD` も空にする：

```
DB_PASSWORD=
```

### 2-5. mysqlコマンド短縮設定

`~/.my.cnf` にデフォルト接続設定を書くことで `mysql` だけで接続できる：

```bash
echo "[client]
user=root
password=" >> ~/.my.cnf
chmod 600 ~/.my.cnf
```

以降のコマンドが短縮される：

```bash
# 変更前
mysql -u root market -e "SELECT COUNT(*) FROM products;"

# 変更後
mysql market -e "SELECT COUNT(*) FROM products;"
```

### 2-6. 接続確認

```bash
mysql
# mysql> が表示されればOK
```

### 2-6. DB作成

```sql
CREATE DATABASE market CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 作成確認
SHOW DATABASES;
-- market が一覧にあればOK

-- mysqlを終了
exit
```

`utf8mb4` は絵文字を含む日本語を正しく扱えるエンコーディング。

### 2-6. .env のパスワード設定

```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=  ← 2-4 で空に変更済みのため空欄
DB_NAME=market
PORT=3000
```

---

## 4. DB（テーブル作成）

### 4-1. migrations/001_create_categories.sql

`migrations/` ディレクトリを作成し、ファイルを作る：

```sql
CREATE TABLE categories (
  id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,  -- UNSIGNED: 0以上の整数のみ（負数不可）。IDは負にならないため指定し、通常のINTより最大値が約43億と2倍になる
  name VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

実行：

```bash
mysql market < migrations/001_create_categories.sql
```

確認：

```bash
mysql market -e "SHOW TABLES;"
# → categories が表示されれば成功

# 詳細確認
mysql market -e "DESCRIBE categories;"
```

**マイグレーションとは**：スキーマ変更をSQLファイルで番号管理し、順番通りに実行することでDBの状態をどの環境でも再現できる運用。チーム開発でも「自分のDBと他人のDBの構造が違う」という問題を防げる。

---

### 4-2. migrations/002_create_products.sql

```sql
CREATE TABLE products (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category_id INT UNSIGNED NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  price       BIGINT UNSIGNED NOT NULL,   -- BIGINT: 最大約922京。高額商品・将来の通貨拡張を考慮しINTより大きい型を使用
  stock       INT UNSIGNED NOT NULL DEFAULT 0,  -- INT: 最大約42億。在庫数はBIGINTほど不要なためINTで十分
  status      ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id)
);
```

| カラム | 理由 |
|---|---|
| `price BIGINT` | 金額は浮動小数点を使わず整数で管理（例：100円 → 100） |
| `status ENUM` | 取りうる値を制限してDB側で不正値を防ぐ |
| `ON UPDATE CURRENT_TIMESTAMP` | UPDATE時に自動で更新日時をセット |
| `FOREIGN KEY` | 存在しないカテゴリIDの商品を登録できないようにする |

実行：

```bash
mysql market < migrations/002_create_products.sql
```

確認：

```bash
mysql market -e "SHOW TABLES;"
# → products が表示されれば成功

# 詳細確認
mysql market -e "DESCRIBE products;"
```

---

### 4-3. シードデータ投入（商品20件）

`seeds/products.sql` を作成：

```sql
INSERT INTO categories (name) VALUES ('スマホ・タブレット'), ('PC・周辺機器'), ('ファッション');

INSERT INTO products (category_id, name, description, price, stock, status) VALUES
(1, 'iPhone 14', '美品。傷なし。', 80000, 1, 'published'),
(1, 'iPad Pro 11inch', 'ケース付き。', 90000, 2, 'published'),
(1, 'Galaxy S23', 'SIM フリー。バッテリー良好。', 65000, 1, 'published'),
(1, 'AirPods Pro 第 2 世代', '充電ケース付き。', 22000, 1, 'published'),
(1, 'Apple Watch Series 8', '傷なし。バンド 2 本付き。', 35000, 1, 'published'),
(1, 'Kindle Paperwhite', '広告なし版。ほぼ新品。', 12000, 1, 'published'),
(1, 'Nintendo Switch', 'ドック・コントローラー付き。', 25000, 1, 'published'),
(2, 'MacBook Air M2', '2023 年購入。', 120000, 1, 'published'),
(2, 'メカニカルキーボード', '茶軸。', 8000, 5, 'published'),
(2, 'Dell モニター 27 インチ', '4K 対応。使用期間 1 年。', 30000, 1, 'published'),
(2, 'Logicool MX Master 3', '充電ケーブル付き。', 7000, 2, 'published'),
(2, 'Anker USB-C ハブ 7in1', '未使用品。', 3500, 3, 'published'),
(2, 'ロジクール Web カメラ C920', '1080p。箱付き。', 5000, 1, 'published'),
(2, 'ゼンハイザー ヘッドセット', '在宅勤務用。状態良好。', 9000, 1, 'published'),
(3, 'ユニクロ ダウン L', '1 回使用。', 5000, 1, 'published'),
(3, 'ナイキ エアマックス 27cm', '3 回着用。', 6000, 1, 'published'),
(3, 'ノースフェイス フリース M', 'ブラック。洗濯済み。', 8000, 1, 'published'),
(3, 'リーバイス 501 W32', '古着。色落ち良好。', 4000, 1, 'published'),
(3, 'ノースフェイス バックパック', '20L。ほぼ未使用。', 11000, 1, 'published'),
(3, 'GU オーバーサイズパーカー XL', '昨シーズン購入。', 1500, 2, 'published');
```

実行：

```bash
mysql market < seeds/products.sql
```

確認：

```bash
# カテゴリ確認（3件）
mysql market -e "SELECT * FROM categories;"

# 商品確認（20件）
mysql market -e "SELECT id, category_id, name, price, stock, status FROM products;"

# 件数確認
mysql market -e "SELECT COUNT(*) FROM products;"
```

**シードデータとは**：APIが動いているかを確認するための開発専用ダミーデータ。本番のデータとは別物。

---

## 5. OpenAPI（実装前に仕様を決める）

### なぜ先に書くのか

OpenAPIは「APIの設計書・契約書」。実装前に書くことで：
- 何を作るかが明確になる
- FlutterエンジニアとAPIエンジニアが並行して動ける
- 実装後のドキュメント化が不要になる

---

### 3-1. openapi.yaml 作成

`openapi.yaml` を作成：

```yaml
openapi: 3.0.3
info:
  title: Flutter Market API
  version: 1.0.0

servers:
  - url: http://localhost:3000/api/v1

paths:
  /products:
    get:
      summary: 商品一覧取得
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
                      $ref: '#/components/schemas/Product'
                  total:
                    type: integer
        '500':
          $ref: '#/components/responses/InternalServerError'

  /products/{productId}:
    get:
      summary: 商品詳細取得
      parameters:
        - name: productId
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
                $ref: '#/components/schemas/Product'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'

components:
  schemas:
    Product:
      type: object
      properties:
        id:
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

  responses:
    NotFound:
      description: リソースが見つからない
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
    InternalServerError:
      description: サーバーエラー
      content:
        application/json:
          schema:
            type: object
            properties:
              error:
                type: string
```

**yamlの書き方**
- [公式ドキュメント](https://swagger.io/docs/specification/v3_0/basic-structure/)

**用語解説**

| 用語 | 意味 |
|---|---|
| `paths` | 各エンドポイントの定義 |
| `parameters` | クエリパラメータ（`?limit=20`）やパスパラメータ（`/products/1`）の定義 |
| `components/schemas` | 再利用できる型定義（`$ref` で参照） |
| `components/responses` | 再利用できるレスポンス定義 |

**確認方法**
1. VSCodeにて「Swagger Viewer」というプラグインをインストール
2. yamlファイルを開いている状態で「command + Shift + P」→「Preview Swagger」の入力でSwaggerのUIを確認

---

## 6. API実装

### 4-1. ディレクトリ構成を作る

```bash
mkdir -p src/{routes,controllers,services,repositories,middlewares,db,schemas,errors}
```

---

### 4-2. errors/ - カスタムエラークラス定義

`src/errors/AppError.ts`：

```typescript
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not Found') {
    super(404, message);
  }
}
```

なぜカスタムエラーを作るか：`throw new NotFoundError()` と書くだけで404レスポンスを返す処理を一元管理できる。各Controllerで毎回 `res.status(404).json(...)` を書く必要がなくなる。

#### 仕組みの詳細

`throw new NotFoundError()` と `res.status(404).json()` は等価ではない。エラーハンドラーミドルウェア（4-9）が橋渡しをしているから省略できる。

**処理の流れ**

```
Service で throw
    ↓
Controller の catch で捕捉 → next(error) で委譲
    ↓
errorHandler ミドルウェアが受け取る
    ↓
AppError のインスタンスか判定 → res.status(err.statusCode).json(...)
```

コードで追うと：
```
Service（4-5）
if (!product) {
  throw new NotFoundError('商品が見つかりません'); // ← statusCode=404 を持つオブジェクトを投げるだけ
}

Controller（4-7）
} catch (error) {
  next(error); // ← res は触らず、エラーをそのまま転送するだけ
}

errorHandler（4-9） ← ここで初めて res を触る
if (err instanceof AppError) {
  return res.status(err.statusCode).json({ error: err.message });
  //                  ↑ 404 が入っている
}
```

**カスタムエラーがない場合（各Controllerで毎回書く）**

```typescript
async show(req, res) {
  const product = await productRepository.findById(id);
  if (!product) {
    res.status(404).json({ error: '商品が見つかりません' }); // 全Controllerに散在
    return;
  }
}
```

**カスタムエラーがある場合（errorHandlerに一元化）**

```typescript
// Service
if (!product) throw new NotFoundError('商品が見つかりません'); // 404という情報を持つオブジェクトを投げるだけ

// Controller
} catch (error) { next(error); } // 共通処理、何も考えなくていい

// errorHandler（1箇所だけ）
if (err instanceof AppError) {
  return res.status(err.statusCode).json({ error: err.message }); // ここで初めてresを触る
}
```

つまり `throw new NotFoundError()` は「404という情報を持ったエラーオブジェクトを投げる」だけで、「HTTPレスポンスを送る」のは errorHandler の役割。errorHandler を1回書いておけば、各Controllerで `res.status(404).json()` を重複して書く必要がなくなる。

#### カスタムエラー方式のデメリット・現場での判断

**間接性が高まる**

エラーが `throw` → `next` → `errorHandler` と2段経由するため処理の流れを追いにくい。新メンバーが「この throw はどこで res になるのか」を把握するのに時間がかかる。

**柔軟性が下がるケース**

```typescript
// このControllerだけ特殊なレスポンス構造を返したい
if (!product) {
  res.status(404).json({ code: 'PRODUCT_NOT_FOUND', retryable: false, hint: '...' });
}
```

errorHandler を通すとフォーマットが統一されるので、エンドポイントごとに細かく変えたいときに逆に邪魔になる。

**小規模プロジェクトではオーバーエンジニアリング**

Controller が2〜3本しかないなら、共通化のコストに対してリターンが小さい。

**どちらが向いているか**

| 状況 | 向いている方式 |
|---|---|
| Controller が多い・増える予定 | カスタムエラー |
| エラーログ・Sentry等の通知を一元管理したい | カスタムエラー |
| Controller が少ない・割り切ったプロトタイプ | 直接 `res.status()` |
| エンドポイントごとにレスポンス構造が違う | 直接 `res.status()` |

**現場でカスタムエラーを導入・提案すべき判断基準**

以下のどれか1つでも当てはまれば、カスタムエラー方式の価値が高い：

- Controller が5本以上あり、同じ `res.status(404).json(...)` パターンが散在している
- エラーレスポンスの形式がエンドポイントによってバラバラで、フロントが複数のフォーマットに対応している
  - 例：`/products` は `{ "error": "..." }`、`/orders` は `{ "message": "..." }`、`/users` は `{ "errors": [...] }` と3種類存在し、フロント側で `if (error.error ?? error.message ?? error.errors?.[0])` のような分岐が必要になっている状態
  - 改善：`AppError` と `errorHandler` を導入し、全エンドポイントで `throw new AppError(statusCode, message)` に統一する。errorHandler が `{ "error": "..." }` の形式で必ず返すようにすることで、フロントの分岐が1種類になる
    ```typescript
    // 改善前：各Controllerで形式がバラバラ
    // products
    res.status(404).json({ error: '商品が見つかりません' });
    // orders
    res.status(404).json({ message: '注文が見つかりません' });
    // users
    res.status(400).json({ errors: ['メールアドレスが不正です'] });

    // 改善後：全ControllerでthrowするだけでerrorHandlerが統一フォーマットで返す
    throw new NotFoundError('商品が見つかりません');
    throw new NotFoundError('注文が見つかりません');
    throw new ValidationError('メールアドレスが不正です'); // 400用のカスタムエラーを追加

    // errorHandler（1箇所）が常に同じ形式で返す
    // → { "error": "商品が見つかりません" }
    // → { "error": "注文が見つかりません" }
    // → { "error": "メールアドレスが不正です" }
    ```
- Sentry・Datadog等にエラーを集約したいが、散在しているため漏れが出ている
- 今後 Controller が増える予定があり、同じパターンをコピペしていく未来が見える
- エラー時のレスポンス形式を一括で変更したい要件が来たとき、全 Controller を修正する必要がある

逆に以下の状況なら提案の優先度は低い：

- Controller が3本以下でスケールアップの予定もない
- 既存コードが直接方式で統一されており、動いている
- チームの規約として決まっている

**現場で「直接書く方が良い」と言われたとき**

黙って飲み込む必要はないが、まず理由を聞く価値はある：

- 「小さいプロジェクトだから」「既存コードと統一したい」→ 納得できれば従う
- 「テストしやすいから」「チームの規約」→ 立派な理由なので従う
- 「なんとなく」→ 軽くメリットを共有して終わり（押しつけない）

「コードの一貫性」は現場では強い理由になる。既存コードが全部直接 `res.status()` で書かれているなら、自分だけカスタムエラー方式にする方が読みにくい。動いていて一貫性があるコードへの改善提案はバグ修正やセキュリティ問題と比べて優先度が低いので、チームに受け入れられなければ飲み込んでいい類の話。

---

### 4-3. db/ - DB接続設定

`src/db/connection.ts`（1-4で作成済み）を使う。

---

### 4-4. repositories/ - SQLを書く場所

`src/repositories/productRepository.ts`：

```typescript
import { pool } from '../db/connection.js';

export const productRepository = {
  async findAll(limit: number, offset: number) {
    const [rows] = await pool.query(
      `SELECT id, name, description, price, stock, status, created_at
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
      `SELECT id, name, description, price, stock, status, created_at
       FROM products
       WHERE id = ? AND status = 'published'`,
      [id]
    ) as any[];
    return rows[0] ?? null; // 見つからなければnull
  },

  async count() {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as total FROM products WHERE status = 'published'`
    ) as any[];
    return rows[0].total as number;
  },
};
```

**`LIMIT ? OFFSET ?` とは**：`LIMIT 20 OFFSET 0` = 先頭から20件取得。`LIMIT 20 OFFSET 20` = 21件目から20件取得。ページングの基本。

**`?` プレースホルダーとは**：SQLに直接値を文字列連結すると SQLインジェクション（悪意ある入力でDBを操作される攻撃）が起きる。`?` を使うとmysql2が安全にエスケープして渡してくれる。

**`version` カラムをSELECTに含めない理由**：`version` は楽観的ロック（Phase 7）のための内部カラムで、クライアントに返す必要がない。GETエンドポイントのSELECTには含めず、在庫減算のUPDATE文の中でのみ使用する（`WHERE version = ? AND stock >= 1`）。APIレスポンス（openapi.yaml の Product スキーマ）にも定義しない。

---

### 4-5. services/ - ビジネスロジック

`src/services/productService.ts`：

```typescript
import { productRepository } from '../repositories/productRepository.js';
import { NotFoundError } from '../errors/AppError.js';

export const productService = {
  async getProducts(limit: number, offset: number) {
    const [data, total] = await Promise.all([
      productRepository.findAll(limit, offset),
      productRepository.count(),
    ]);
    return { data, total };
  },

  async getProductById(id: number) {
    const product = await productRepository.findById(id);
    if (!product) {
      throw new NotFoundError('商品が見つかりません');
    }
    return product;
  },
};
```

Phase 1ではビジネスロジックがほぼないのでシンプル。Phase 6以降で「在庫チェック」「価格計算」などのロジックがここに増えてくる。

---

### 4-6. schemas/ - バリデーション定義

```bash
npm i zod
```

`src/schemas/productSchema.ts`：

```typescript
import { z } from 'zod';

export const getProductsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const getProductParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
```

**Zodとは**：TypeScriptの型定義とバリデーションを同時に行えるライブラリ。`z.coerce.number()` はクエリパラメータ（文字列）を数値に自動変換する。

**`.number()` と `.int()` の役割の違い**：`.number()` は文字列を数値に変換するだけで、小数も通過してしまう。`.int()` を追加することで変換後の値が整数かどうかを検証できる。

```
?limit=20   →  "20"  → 20   → int ✅
?limit=1.5  →  "1.5" → 1.5  → int ❌（バリデーションエラー）
?limit=abc  →  "abc" → NaN  → number ❌（変換失敗）
```

`LIMIT 1.5` をSQLに渡すとMySQLが暗黙的に切り捨てるが、APIの入口で明示的に弾くのが正しい。

---

### 4-7. controllers/ - リクエスト受信・レスポンス返却

`src/controllers/productController.ts`：

```typescript
import type { Request, Response, NextFunction } from 'express';
import { productService } from '../services/productService.js';
import { getProductsQuerySchema, getProductParamsSchema } from '../schemas/productSchema.js';

export const productController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const query = getProductsQuerySchema.parse(req.query);
      const result = await productService.getProducts(query.limit, query.offset);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  async show(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = getProductParamsSchema.parse(req.params);
      const product = await productService.getProductById(id);
      res.json(product);
    } catch (error) {
      next(error);
    }
  },
};
```

**`next(error)` とは**：Expressのエラーハンドラー（後述）に処理を委譲する。`try/catch` で拾ったエラーを毎回自分でレスポンスせず、一元管理できる。

---

### 4-8. routes/ - URLとControllerの紐付け

`src/routes/productRoutes.ts`：

```typescript
import { Router } from 'express';
import { productController } from '../controllers/productController.js';

const router = Router();

router.get('/', productController.list);
router.get('/:id', productController.show);

export default router;
```

---

### 4-9. middlewares/ - 共通エラーハンドラー

`src/middlewares/errorHandler.ts`：

```typescript
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError.js';
import { ZodError } from 'zod';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'バリデーションエラー' });
  }
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
}
```

**なぜMiddlewareにまとめるか**：エラーの種類（バリデーション・NotFound・予期せぬエラー）ごとにレスポンスを変える処理を1箇所に集約できる。各Controllerで同じ処理を書く必要がなくなる。

---

### 4-10. app.ts にルーターとエラーハンドラーを登録

```typescript
import 'dotenv/config';
import express from 'express';
import productRoutes from './routes/productRoutes.js';
import { errorHandler } from './middlewares/errorHandler.js';

const app = express();
app.use(express.json());

// ルーター登録
app.use('/api/v1/products', productRoutes);

// エラーハンドラーは必ず最後に登録
app.use(errorHandler);

app.listen(Number(process.env.PORT) || 3000, () => {
  console.log('Server started');
});
```

**エラーハンドラーを最後に登録する理由**：Expressはミドルウェアを上から順に実行する。エラーハンドラーを最後にすることで、すべてのルートで発生したエラーをキャッチできる。

---

### 4-11. 動作確認

```bash
# 商品一覧
curl http://localhost:3000/api/v1/products

# ページング
curl "http://localhost:3000/api/v1/products?limit=5&offset=0"

# 商品詳細
curl http://localhost:3000/api/v1/products/1

# 存在しないID（404になること確認）
curl http://localhost:3000/api/v1/products/99999
```

---

## 7. Flutter連携

### 7-1. Dio の設定

```bash
# pubspec.yaml に追加
flutter pub add dio
```

`lib/core/api/dio_client.dart`：

```dart
import 'package:dio/dio.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'http://localhost:3000/api/v1',
  connectTimeout: const Duration(seconds: 5),
  receiveTimeout: const Duration(seconds: 5),
  headers: {'Content-Type': 'application/json'},
));
```

**開発時のbaseUrl注意点**：

| 実行環境 | baseUrl |
|---|---|
| iOSシミュレーター | `http://localhost:3000` |
| Androidエミュレーター | `http://10.0.2.2:3000` |
| 実機 | PCのローカルIP（例: `http://192.168.1.5:3000`） |

---

### 7-2. Product モデル定義

`lib/features/product/data/product.dart`：

```dart
class Product {
  final int id;
  final String name;
  final String? description;
  final int price;
  final int stock;
  final String status;
  final String createdAt;

  Product({
    required this.id,
    required this.name,
    this.description,
    required this.price,
    required this.stock,
    required this.status,
    required this.createdAt,
  });

  factory Product.fromJson(Map<String, dynamic> json) => Product(
    id: json['id'],
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

### 7-3. ProductRepository（Flutter側）

`lib/features/product/data/product_repository.dart`：

```dart
import 'package:dio/dio.dart';
import 'product.dart';
import '../../core/api/dio_client.dart';

class ProductRepository {
  Future<List<Product>> getProducts({int limit = 20, int offset = 0}) async {
    final response = await dio.get('/products', queryParameters: {
      'limit': limit,
      'offset': offset,
    });
    final List data = response.data['data'];
    return data.map((e) => Product.fromJson(e)).toList();
  }

  Future<Product> getProductById(int id) async {
    final response = await dio.get('/products/$id');
    return Product.fromJson(response.data);
  }
}
```

---

### 7-4. 商品一覧画面

`lib/features/product/ui/product_list_screen.dart`：

```dart
import 'package:flutter/material.dart';
import '../data/product_repository.dart';
import '../data/product.dart';

class ProductListScreen extends StatefulWidget {
  const ProductListScreen({super.key});
  @override
  State<ProductListScreen> createState() => _ProductListScreenState();
}

class _ProductListScreenState extends State<ProductListScreen> {
  final _repo = ProductRepository();
  List<Product> _products = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final products = await _repo.getProducts();
      setState(() {
        _products = products;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = 'データの取得に失敗しました';
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!));

    return ListView.builder(
      itemCount: _products.length,
      itemBuilder: (context, index) {
        final p = _products[index];
        return ListTile(
          title: Text(p.name),
          subtitle: Text('¥${p.price}'),
          onTap: () {
            // 詳細画面へ遷移
          },
        );
      },
    );
  }
}
```

---

## 確認チェックリスト

Phase 1 完了の判断基準：

```
[ ] npm run dev でサーバーが起動する
[ ] curl で GET /api/v1/products が商品一覧JSONを返す
[ ] curl で GET /api/v1/products/1 が商品詳細JSONを返す
[ ] curl で GET /api/v1/products/99999 が {"error":"商品が見つかりません"} + 404を返す
[ ] FlutterアプリでAPIから取得した商品が一覧表示される
[ ] ローディング中にスピナーが表示される
[ ] API失敗時にエラーメッセージが表示される
[ ] openapi.yaml に /products・/products/{id} が定義されている
```

---

## この段階で理解すべきこと

| テーマ | 内容 |
|---|---|
| 層分離の意義 | なぜRoute / Controller / Service / Repository に分けるのか |
| プレースホルダー | `?` を使わないとSQLインジェクションが起きる理由 |
| エラーハンドリング | `next(error)` で一元管理する設計 |
| 環境変数 | パスワードをコードに書かない理由 |
| マイグレーション | SQLファイルで管理することの意味 |
| OpenAPIファースト | 実装前に仕様を決めることの効果 |
