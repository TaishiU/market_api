# 結論

フリマアプリで「決済完了率」を改善したいなら、画面を開いたことだけでなく、**ユーザーが購入ファネルのどこまで進み、どの段階で離脱したか**を計測できるようにします。

ただし、すべての画面・ボタンに無制限にログを仕込むのはおすすめしません。まずはKGI・最重要KPIから逆算し、意思決定に使うイベントを優先して設計します。元記事の主張どおり、ダウンロード数や画面表示数だけでなく、購入や継続利用など、事業の成果に近い指標を重視する考え方です。 [picks-design](https://picks-design.com/blog/6445/)

***

## 1. KPIからログを設計する

まず、フリマアプリのビジネス構造を簡単に整理します。

```text
KGI：売上・利益を増やす
  ├─ 取引数を増やす
  │    ├─ 商品閲覧者を増やす
  │    ├─ 購入意向を持つ人を増やす
  │    └─ 決済完了率を上げる
  ├─ 1取引あたりの単価を上げる
  └─ 手数料率・運営コストを改善する
```

今回の最重要KPIを「決済完了率」と仮定すると、定義を先に決めます。

### 決済完了率の例

```text
決済完了率 =
purchaseイベントを発生させたユーザー数
÷
begin_checkoutイベントを発生させたユーザー数
```

または、取引単位で見るなら次のように定義します。

```text
決済完了率 =
決済完了注文数
÷
決済を開始した注文数
```

重要なのは、**分子と分母を明確にすること**です。

例えば、アプリ起動ユーザーを分母にすると「アプリ起動から購入までの全体CVR」になります。一方、`begin_checkout`を分母にすると「購入手続き開始後の決済完了率」になります。これらは異なる指標です。

***

## 2. どの粒度でログを入れるか

ログの粒度は、次の3種類に分けると考えやすいです。

| 粒度 | 例 | 目的 | 優先度 |
|---|---|---|---|
| 画面・状態 | ホーム表示、商品詳細表示、決済画面表示 | ユーザーの流れを把握する | 高 |
| 重要な行動 | 商品選択、購入手続き開始、支払い情報送信 | ファネル分析を行う | 最重要 |
| UI操作 | 購入ボタンタップ、戻る、閉じる | 原因調査やUX改善 | 必要な箇所だけ |

基本方針は、**すべてのボタンではなく、ユーザーの意図が変化する行動を記録する**ことです。

### 画面表示だけでは不十分

例えば、次のようなログだけでは決済完了率を正しく分析できません。

```text
home_screen_view
item_detail_screen_view
checkout_screen_view
```

これでは、「決済画面を表示したが、何も入力せずに離脱した」のか、「支払い処理中にエラーになった」のかが分かりません。

そのため、画面表示に加えて、以下のような意味のある行動を記録します。

```text
商品を見る
購入手続きを開始する
配送情報を登録する
支払い情報を送信する
決済に成功する
決済に失敗する
```

Firebase Analyticsには、EC向けの推奨イベントとして`view_item`、`select_item`、`begin_checkout`、`add_payment_info`、`purchase`などが用意されています。標準イベント名を使うと、GA4の既存のレポートや分析機能と連携しやすくなります。 [support.google](https://support.google.com/analytics/answer/9267735?hl=ja)

***

## 3. 決済ファネルのイベント設計

フリマアプリで、次の購入導線を考えます。

```text
アプリ起動
  ↓
ホーム画面表示
  ↓
商品一覧表示
  ↓
商品選択
  ↓
商品詳細表示
  ↓
購入手続き開始
  ↓
配送先入力
  ↓
支払い方法入力
  ↓
決済実行
  ↓
購入完了
```

この流れを、Firebase Analyticsのイベントに対応させます。

| ユーザー行動 | Firebaseイベント | 発生タイミング |
|---|---|---|
| アプリを起動 | 自動収集イベント | アプリ起動時 |
| 商品一覧を見る | `view_item_list` | 商品一覧が実際に表示されたとき |
| 商品を選択 | `select_item` | 一覧から商品をタップしたとき |
| 商品詳細を見る | `view_item` | 商品詳細画面の表示が完了したとき |
| 購入手続きを開始 | `begin_checkout` | 購入手続き画面へ遷移したとき |
| 配送情報を登録 | `add_shipping_info` | 配送情報を正常に保存したとき |
| 支払い情報を送信 | `add_payment_info` | 支払い情報を送信したとき |
| 決済成功 | `purchase` | サーバーで決済成功が確定したとき |
| 返金 | `refund` | 返金処理が確定したとき |

`purchase`は「購入ボタンを押したとき」ではなく、**決済成功が確定したとき**に送るのが重要です。Firebaseの公式例でも、購入イベントには取引ID、通貨、金額、商品情報などを付けます。 [firebase.google](https://firebase.google.com/docs/analytics/measure-ecommerce)

***

## 4. Flutterでの具体例

まずFirebase Analyticsを利用します。

```yaml
dependencies:
  firebase_core: ^latest
  firebase_analytics: ^latest
```

初期化例です。

```dart
await Firebase.initializeApp();

final analytics = FirebaseAnalytics.instance;
```

実際のプロジェクトでは、各画面から直接`FirebaseAnalytics.instance.logEvent()`を呼ぶより、専用のクラスに集約する方が保守しやすくなります。

### Analyticsクラス

```dart
import 'package:firebase_analytics/firebase_analytics.dart';

class AppAnalytics {
  AppAnalytics(this._analytics);

  final FirebaseAnalytics _analytics;

  Future<void> logItemSelected({
    required String itemId,
    required String itemListId,
    required String itemListName,
    required int index,
  }) {
    return _analytics.logSelectItem(
      itemListId: itemListId,
      itemListName: itemListName,
      items: [
        AnalyticsEventItem(
          itemId: itemId,
          index: index,
        ),
      ],
    );
  }

  Future<void> logViewItem({
    required String itemId,
    required String itemName,
    required double price,
    required String currency,
  }) {
    return _analytics.logViewItem(
      currency: currency,
      value: price,
      items: [
        AnalyticsEventItem(
          itemId: itemId,
          itemName: itemName,
          price: price,
          quantity: 1,
        ),
      ],
    );
  }

  Future<void> logBeginCheckout({
    required String transactionDraftId,
    required String itemId,
    required double price,
    required String currency,
  }) {
    return _analytics.logBeginCheckout(
      currency: currency,
      value: price,
      items: [
        AnalyticsEventItem(
          itemId: itemId,
          price: price,
          quantity: 1,
        ),
      ],
    );
  }

  Future<void> logAddPaymentInfo({
    required String itemId,
    required double price,
    required String currency,
    required String paymentType,
  }) {
    return _analytics.logAddPaymentInfo(
      currency: currency,
      value: price,
      paymentType: paymentType,
      items: [
        AnalyticsEventItem(
          itemId: itemId,
          price: price,
          quantity: 1,
        ),
      ],
    );
  }

  Future<void> logPurchase({
    required String transactionId,
    required String itemId,
    required double price,
    required String currency,
  }) {
    return _analytics.logPurchase(
      transactionId: transactionId,
      currency: currency,
      value: price,
      items: [
        AnalyticsEventItem(
          itemId: itemId,
          price: price,
          quantity: 1,
        ),
      ],
    );
  }
}
```

バージョンによってFlutter SDKのメソッド引数や`AnalyticsEventItem`のAPIが変わる可能性があるため、実際には利用中の`firebase_analytics`のバージョンに合わせて確認してください。

### 商品一覧から商品を選択

```dart
onTap: () async {
  await analytics.logItemSelected(
    itemId: item.id,
    itemListId: 'home_recommendations',
    itemListName: 'ホームおすすめ商品',
    index: index,
  );

  if (!context.mounted) return;

  Navigator.push(
    context,
    MaterialPageRoute(
      builder: (_) => ItemDetailPage(itemId: item.id),
    ),
  );
}
```

ここで重要なのは、単なる「商品ボタンを押した」という情報ではなく、次の情報を持たせることです。

```text
item_id: 商品ID
item_list_id: どの商品一覧から来たか
item_list_name: 一覧の名称
index: 一覧内の位置
```

これにより、例えば次のような分析が可能になります。

- ホームのおすすめ商品と検索結果のどちらが購入されやすいか。
- 一覧の上位商品ほど選択されるか。
- バナー経由の商品は購入率が高いか。
- カテゴリ別に商品詳細到達率が異なるか。

### 商品詳細画面を表示

商品詳細データの取得に成功し、画面に商品が表示できたタイミングで送ります。

```dart
@override
void initState() {
  super.initState();

  _loadItem();
}

Future<void> _loadItem() async {
  final item = await repository.fetchItem(widget.itemId);

  if (!mounted) return;

  setState(() {
    _item = item;
  });

  await analytics.logViewItem(
    itemId: item.id,
    itemName: item.title,
    price: item.price,
    currency: 'JPY',
  );
}
```

画面の`build()`内でログを送るのは避けてください。`build()`は何度も呼ばれる可能性があり、同じイベントが重複送信されるためです。

***

## 5. 決済フローの実装例

### 購入手続き開始

「購入」ボタンをタップしただけでなく、購入可能性を確認して決済画面への遷移が成功した時点で、`begin_checkout`を送るのが安全です。

```dart
Future<void> onPurchasePressed() async {
  final result = await orderRepository.createCheckoutDraft(
    itemId: item.id,
  );

  if (!result.isSuccess) {
    await analytics.logEvent(
      name: 'checkout_start_failed',
      parameters: {
        'item_id': item.id,
        'reason': result.errorCode,
      },
    );

    return;
  }

  await analytics.logBeginCheckout(
    transactionDraftId: result.draftId,
    itemId: item.id,
    price: item.price,
    currency: 'JPY',
  );

  if (!context.mounted) return;

  Navigator.push(
    context,
    MaterialPageRoute(
      builder: (_) => CheckoutPage(
        draftId: result.draftId,
      ),
    ),
  );
}
```

ここで`begin_checkout`を「ボタンタップ時」に送る実装も可能ですが、通信エラーや在庫切れなどで決済画面に進めない場合、実際にはチェックアウトを開始していないユーザーまで分母に入ります。

したがって、次のように定義するのがおすすめです。

```text
begin_checkout =
購入可能性の確認が完了し、
チェックアウト画面の表示に成功した
```

### 配送情報の登録

```dart
Future<void> onShippingInfoSubmitted() async {
  final result = await checkoutRepository.saveShippingAddress(
    draftId: draftId,
    address: selectedAddress,
  );

  if (!result.isSuccess) {
    await analytics.logEvent(
      name: 'shipping_info_submit_failed',
      parameters: {
        'checkout_id': draftId,
        'error_code': result.errorCode,
      },
    );

    return;
  }

  await FirebaseAnalytics.instance.logAddShippingInfo(
    currency: 'JPY',
    value: item.price,
    shippingTier: selectedShippingMethod,
    items: [
      AnalyticsEventItem(
        itemId: item.id,
        price: item.price,
        quantity: 1,
      ),
    ],
  );
}
```

### 支払い情報の登録

```dart
Future<void> onPaymentInfoSubmitted() async {
  final result = await paymentRepository.savePaymentMethod(
    draftId: draftId,
    paymentMethod: selectedPaymentMethod,
  );

  if (!result.isSuccess) {
    await analytics.logEvent(
      name: 'payment_info_submit_failed',
      parameters: {
        'checkout_id': draftId,
        'error_code': result.errorCode,
      },
    );

    return;
  }

  await FirebaseAnalytics.instance.logAddPaymentInfo(
    currency: 'JPY',
    value: item.price,
    paymentType: selectedPaymentMethod.analyticsName,
    items: [
      AnalyticsEventItem(
        itemId: item.id,
        price: item.price,
        quantity: 1,
      ),
    ],
  );
}
```

なお、カード番号そのものや個人情報をAnalyticsに送ってはいけません。`payment_type`は`credit_card`や`paypay`のような分類値にとどめ、カード番号、メールアドレス、住所、氏名などは送信しない設計にします。

### 決済成功

決済成功イベントは、クライアントが「成功したと思った」時点ではなく、**バックエンドが成功を確定した時点**に基づいて送るのが理想です。

```dart
Future<void> completePayment() async {
  final result = await paymentRepository.pay(
    draftId: draftId,
  );

  if (!result.isSuccess) {
    await analytics.logEvent(
      name: 'payment_failed',
      parameters: {
        'checkout_id': draftId,
        'error_code': result.errorCode,
      },
    );

    return;
  }

  await analytics.logPurchase(
    transactionId: result.transactionId,
    itemId: item.id,
    price: item.price,
    currency: 'JPY',
  );

  if (!context.mounted) return;

  Navigator.pushReplacement(
    context,
    MaterialPageRoute(
      builder: (_) => PurchaseCompletePage(
        transactionId: result.transactionId,
      ),
    ),
  );
}
```

より堅牢にするなら、決済APIのレスポンス後に直接`purchase`を送るのではなく、購入完了画面を表示する際にバックエンドの注文ステータスを確認します。

```text
決済API成功
  ↓
バックエンドで注文確定
  ↓
注文ステータスがcompleted
  ↓
purchaseを送信
```

### 重複計上への対策

ネットワーク再試行や画面再表示によって、同じ購入が2回送信される可能性があります。

そのため、`transaction_id`にはバックエンドで発行した一意な注文IDを使用します。

```text
transaction_id = order_20260914_000123
```

同じ注文IDで何度も`purchase`を送らないよう、アプリ側でも次のような対策を検討します。

```dart
if (purchaseAlreadyLogged(transactionId)) {
  return;
}

await analytics.logPurchase(
  transactionId: transactionId,
  currency: 'JPY',
  value: price,
  items: items,
);
```

ただし、最終的な売上集計はFirebase Analyticsだけに依存せず、バックエンドの注文データを正とするべきです。

***

## 6. 追加するカスタムイベント

Firebaseの標準イベントだけでは、離脱理由やエラー原因まで分かりません。決済率改善では、失敗イベントも重要です。

### 追加候補

| イベント | 発生タイミング | 使い道 |
|---|---|---|
| `checkout_start_failed` | 購入手続き開始に失敗 | 在庫切れ・本人確認などを分析 |
| `shipping_info_submit_failed` | 配送情報の保存失敗 | 入力エラーやAPI障害を分析 |
| `payment_info_submit_failed` | 支払い情報送信失敗 | 支払い方法別の失敗率を分析 |
| `payment_failed` | 決済失敗 | 決済事業者・エラーコード別に分析 |
| `checkout_abandoned` | 一定時間内に完了しなかった | 決済画面離脱を分析 |
| `item_unavailable` | 商品が売り切れ・購入不可 | 商品状態とCVRの関係を分析 |

例：

```dart
await analytics.logEvent(
  name: 'payment_failed',
  parameters: {
    'checkout_id': draftId,
    'item_id': item.id,
    'payment_type': 'credit_card',
    'error_code': 'insufficient_funds',
  },
);
```

エラーコードは、画面に表示する文章をそのまま送るのではなく、分析用に安定したコードを定義します。

```text
payment_declined
payment_timeout
payment_provider_error
insufficient_funds
authentication_required
```

これにより、文言変更があっても集計が壊れません。

***

## 7. どのログを最初に実装するか

最初から大量のイベントを入れるのではなく、次の順番がおすすめです。

### フェーズ1：最小限の決済ファネル

まずは次の5つで十分です。

```text
view_item
begin_checkout
add_shipping_info
add_payment_info
purchase
```

この5つがあれば、次のようなファネルを作れます。

```text
商品詳細閲覧者        10,000人
  ↓ 30%
購入手続き開始者       3,000人
  ↓ 70%
配送情報登録者         2,100人
  ↓ 80%
支払い情報登録者       1,680人
  ↓ 90%
購入完了者             1,512人
```

この場合、最も大きな改善余地は、商品詳細から購入手続き開始までの区間です。

```text
商品詳細 → チェックアウト開始：30%
チェックアウト → 配送情報：70%
配送情報 → 支払い情報：80%
支払い情報 → 購入完了：90%
```

このデータだけでも、「決済処理を改善しよう」と思っていたのに、実は商品詳細画面の購入導線や価格表示が問題だった、という発見ができます。

### フェーズ2：原因分析用イベント

次に追加します。

```text
select_item
view_item_list
view_cart
payment_failed
checkout_start_failed
```

### フェーズ3：施策評価用イベント

UI改善やキャンペーンの効果を測るために追加します。

```text
select_promotion
view_promotion
apply_coupon
favorite_item
share_item
search
```

***

## 8. `screen_view`とカスタム画面ログ

Firebase Analyticsでは画面表示も計測できますが、画面ログだけでユーザー行動を判断しないことが重要です。

### 画面表示で分かること

```text
どの画面が多く見られているか
どの画面で離脱が多いか
どの画面への遷移が多いか
```

### 画面表示だけでは分からないこと

```text
本当に購入意欲があったか
入力に成功したか
ボタンタップ後にAPIが成功したか
決済が確定したか
```

例えば、次のような画面ログは補助的に使います。

```text
screen_view: home
screen_view: item_detail
screen_view: checkout
screen_view: purchase_complete
```

一方、KPI計算には意味のあるイベントを使います。

```text
view_item
begin_checkout
add_payment_info
purchase
```

つまり、**画面ログは経路の観察用、業務イベントはKPI計算用**と分けると設計しやすいです。

***

## 9. イベントパラメータの設計

イベント名だけでは分析できる範囲が限られます。イベントには、後から切り口として使いたいパラメータを付けます。

### 共通パラメータ

```text
item_id
item_category
price
currency
item_list_id
item_list_name
payment_type
shipping_tier
transaction_id
```

### 例：`begin_checkout`

```json
{
  "event_name": "begin_checkout",
  "currency": "JPY",
  "value": 4980,
  "items": [
    {
      "item_id": "item_123",
      "item_name": "ワイヤレスイヤホン",
      "item_category": "家電",
      "price": 4980,
      "quantity": 1
    }
  ]
}
```

### 例：`purchase`

```json
{
  "event_name": "purchase",
  "transaction_id": "order_123",
  "currency": "JPY",
  "value": 4980,
  "shipping": 750,
  "items": [
    {
      "item_id": "item_123",
      "item_name": "ワイヤレスイヤホン",
      "item_category": "家電",
      "price": 4980,
      "quantity": 1
    }
  ]
}
```

Googleの公式ドキュメントでは、`value`を送る場合、正確な収益計測のために`currency`も送ることが示されています。また、購入イベントには`transaction_id`や`items`などを含めます。 [firebase.google](https://firebase.google.com/docs/analytics/measure-ecommerce)

***

## 10. ログ設計で避けたいこと

### 1. ボタン名だけを送る

```text
button_tap
```

これだけでは、どのボタンか分かりません。

送るなら、次のように意味を明確にします。

```text
purchase_button_tapped
favorite_button_tapped
apply_coupon_tapped
```

ただし、購入ボタンのタップはKPIの購入完了とは別物です。

### 2. 画面表示をKPIにする

```text
checkout_screen_view = 購入意向
```

とは限りません。誤タップや確認目的の閲覧も含まれるため、決済率の分母には、業務上定義した`begin_checkout`を使う方が適切です。

### 3. `purchase`をボタンタップ時に送る

決済失敗でも購入としてカウントされるため、決済完了率が実際より高くなります。

### 4. `build()`でログを送る

Flutterでは再ビルドでイベントが重複します。`initState`、アクション完了処理、API成功処理など、発生条件が明確な場所で送ります。

### 5. イベント名を自由に作りすぎる

```text
product_opened
product_viewed
item_detail_open
item_detail_displayed
```

同じ意味のイベントが増えると分析が困難になります。

EC系では、可能な限りFirebase/GA4の推奨イベント名を使います。推奨イベントは既定のパラメータと組み合わせることで、レポートや分析機能を活用しやすくなります。 [support.google](https://support.google.com/analytics/answer/9267735?hl=ja)

***

## 11. 開発タスクの優先順位判断

プロダクト視点では、「実装しやすいもの」ではなく、**最重要KPIに対して影響が大きく、検証可能なタスク**を優先します。

例えば、決済完了率が重要KPIなら、次のように考えます。

| タスク | KPIへの近さ | 優先度 |
|---|---:|---:|
| アプリアイコンの微調整 | 遠い | 低 |
| 決済ファネルの計測 | 非常に近い | 最優先 |
| 決済エラーの可視化 | 非常に近い | 最優先 |
| 購入ボタンのアニメーション変更 | 中程度 | 中 |
| 商品一覧の画像最適化 | 中程度 | 仮説次第 |
| 未使用画面のリファクタリング | 間接的 | 低〜中 |

まず計測し、次に仮説を立てます。

```text
仮説：
支払い方法入力画面で離脱が多い。
原因は、利用可能な支払い方法が分かりにくいこと。

計測：
add_payment_info
payment_failed
payment_type
checkout_screen_view

施策：
支払い方法一覧の改善

評価：
payment_info到達率
payment_info → purchase率
決済完了率
```

このように、Flutterエンジニアとしては「画面を作る」だけでなく、

```text
KPI
  ↓
ユーザー行動
  ↓
イベント設計
  ↓
実装
  ↓
分析
  ↓
改善施策
```

というサイクルを意識すると、ビジネスに直結する開発判断がしやすくなります。

***

## 12. 最初に作るイベント仕様書

実装前に、次のような表をMarkdownで作ると、チーム内で認識を合わせやすくなります。

```markdown
# 決済ファネルイベント仕様

| Event | Trigger | Required params | Owner |
|---|---|---|---|
| view_item | 商品詳細の表示成功 | item_id, price, currency | Flutter |
| begin_checkout | 購入手続き画面の表示成功 | item_id, value, currency | Flutter |
| add_shipping_info | 配送情報の保存成功 | shipping_tier, items | Flutter |
| add_payment_info | 支払い情報の送信成功 | payment_type, items | Flutter |
| purchase | バックエンドで注文確定 | transaction_id, value, currency, items | Backend/Flutter |
| payment_failed | 決済失敗 | error_code, payment_type | Flutter/Backend |
```

さらに、以下も決めておくと良いです。

```text
イベントを送る責任者
イベントの発生条件
重複送信を防ぐ方法
個人情報を含めないこと
DebugViewでの確認方法
本番リリース前の検証方法
```

Firebase公式ドキュメントでも、設定後はDebugViewでイベントを確認することが推奨されています。 [support.google](https://support.google.com/analytics/answer/9267735?hl=ja)

最初の実装としては、次の5イベントから始めるのが現実的です。

```text
view_item
begin_checkout
add_shipping_info
add_payment_info
purchase
```

その後、`payment_failed`や`checkout_start_failed`を加えると、「どこで離脱したか」だけでなく、「なぜ離脱したか」まで分析できるようになります。