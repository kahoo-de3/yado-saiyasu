# 宿最安ファインダー（yado-saiyasu）

国内宿泊の最安値を「宿泊日 × エリア × 予算 × こだわり条件」で検索するスマホ向けWebアプリ。
楽天トラベル（楽天ウェブサービスAPI）をベースに、将来ヤフートラベル・じゃらん掲載宿を統合する前提のプロバイダ分離構成。

## 使い方

1. [楽天ウェブサービス](https://webservice.rakuten.co.jp/) でアプリID（無料）を取得
2. アプリ右上の ⚙ からアプリIDを入力して保存（ブラウザのlocalStorageにのみ保存・外部送信なし）
3. 保存と同時にエリア情報（GetAreaClass API）を取得し、都道府県→エリア→詳細エリアが選択可能になる
4. 日付・人数・予算・こだわり（温泉/大浴場/朝食/夕食/禁煙/ネット）で検索 → 安い順に表示

ローカル起動: `python -m http.server 8772 --directory docs`（launch.json名: `yado-saiyasu`）

## 構成

```
docs/
  index.html            UI（自己完結・依存ライブラリなし・モバイルFirst）
  css/style.css
  js/app.js             検索フロー・マージ・描画（プロバイダ横断）
  js/providers/rakuten.js   楽天トラベル プロバイダ実装
```

### プロバイダ共通インターフェース（統合の要）

`js/providers/*.js` は以下を実装した `window.XxxProvider` を公開し、
`app.js` の `PROVIDERS` 配列に追加するだけで検索・マージ・表示に統合される。

```js
{
  id, label, badgeClass,
  isConfigured(settings) -> bool,
  fetchAreas(settings)   -> Promise<AreaNode[]>,          // 楽天のみ使用（エリアマスタ）
  search(params, settings) -> Promise<{items, page, pageCount, total}>,
}
// items: {provider, id, name, url, thumb, address, access, review, reviewCount, price, planName, roomName}
```

複数プロバイダの結果は価格昇順にマージし、`provider:id` で重複排除。ページングはプロバイダごとに独立管理（`pagingState`）。

## 楽天APIメモ

- 空室検索: `VacantHotelSearch/20170426`（sort=`+roomCharge` で安い順、hits最大30、page最大100）
- エリアコード: `GetAreaClass`（largeClass=japan → middle=都道府県 → small → detail）。7日間localStorageキャッシュ
- squeezeCondition: `kinen` 禁煙 / `internet` / `daiyoku` 大浴場 / `onsen` 温泉 / `breakfast` / `dinner`（カンマ区切りで複数可）
- 404 = 「該当空室なし」の正常系。429 = レート超過（1リクエスト/秒）
- エンドポイント2系統: 新形式（accessKeyあり）= `openapi.rakuten.co.jp/engine/api/Travel/`、従来 = `app.rakuten.co.jp/services/api/Travel/`。設定に応じて自動選択+フォールバック
- fetch（CORS）→ 失敗時JSONP（callbackパラメータ）の順で自動フォールバック
- アフィリエイトID設定時は返却URLが自動的にアフィリエイトリンクになる

## フェーズ2: ヤフートラベル・じゃらん統合（未着手）

- **じゃらん**: [じゃらんWebサービス](https://www.jalan.net/jw/jwp0000/jww0001.do) に空室検索API・エリア検索APIのドキュメントが現存。APIキー申請の可否・新規受付状況を要確認。受付中なら `js/providers/jalan.js` として実装（じゃらん独自エリアコード⇔楽天エリアのマッピング表が必要）
- **ヤフートラベル**: 公開APIなし。選択肢は (a) Yahoo!デベロッパーネットワークの動向確認 (b) バリューコマース等アフィリエイト経由の商品フィード (c) 統合断念して外部リンク（ヤフートラベルの検索結果URLに日付・エリアを引き継ぐディープリンク）
- 統合時の課題: エリアコード体系の相互マッピング、同一ホテルの名寄せ（名称+緯度経度で突合）、こだわり条件の対応表

## 未検証事項

- 実APIキーでの疎通（キー未取得のためUI動作のみ検証済み）
- `hotelMinCharge` が検索条件での「合計額」か「1名1泊額」か — 実データで要確認（表示は「〜 合計/条件により1名分」と注記済み）
