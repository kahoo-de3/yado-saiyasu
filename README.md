# 楽天トラベルサポート（yado-saiyasu）

楽天トラベルの宿を「宿泊日 × エリア（複数可）× 人数（子供の年齢区分対応）× 予算 × こだわり条件」で
最安値から検索するスマホ向けWebアプリ。

**方針変更（2026-07-09, v19）**: 他サイト（Google比較/Booking/Agoda/じゃらん/Yahoo）への横断リンクは
v13〜v18で実装・実機検証したが全廃し、**楽天トラベル専用**とした。各サイトのディープリンク可否・
制約の知見は「フェーズ2」以降のセクションに保存（再挑戦時の資料）。

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

## 楽天APIメモ（実測で確認済み）

- 空室検索: `VacantHotelSearch/20170426`（sort=`+roomCharge` で安い順、hits最大30、page最大100）
- エリアコード: `GetAreaClass`（largeClass=japan → middle=都道府県47 → small → detail）。7日間localStorageキャッシュ。**新旧エンドポイントでレスポンス構造が異なる**（新=フラットなオブジェクト、旧=ペア配列）→ パーサは両対応
- squeezeCondition: `kinen` 禁煙 / `internet` / `daiyoku` 大浴場 / `onsen` 温泉 / `breakfast` / `dinner`（カンマ区切りで複数可）
- 404 = 「該当空室なし」の正常系。429 = レート超過（1リクエスト/秒）
- **新形式キー（`pk_…`）**: `openapi.rakuten.co.jp/engine/api/Travel/` に `applicationId` と `accessKey` の**両方**として同じ値を渡す。従来の数値アプリIDは `app.rakuten.co.jp/services/api/Travel/`（キー形式で自動判定）
- **新形式キーはOriginヘッダを許可ドメインと厳格照合**（Referer不可・localhost/127.0.0.1は登録不可＝ローカル開発でAPIは呼べない。公開サイト上でのみ動作）。CORSレスポンスは `access-control-allow-origin: *` なのでfetchでOK。JSONPはOriginが付かないため新キーでは不可（旧キーのみのフォールバック）
- **料金は `dailyCharge.total`（1室・人数分・日別）の宿泊日合計を採用**。`hotelMinCharge` は検索条件と無関係なホテル全体最安値で、実際に予約可能なプラン料金と一致しない（実測: hotelMinCharge=3,900円 vs 実プラン2名合計9,000円）
- アフィリエイトID設定時は返却URLが自動的にアフィリエイトリンクになる

## フェーズ2: ヤフートラベル・じゃらん統合（2026-08-02 調査のうえ見送り）

**結論: 楽天トラベル専用を維持する。** 両サイトとも価格を取得する手段がないため。

- **じゃらん**: [じゃらんWebサービス](https://www.jalan.net/jw/jwp0000/jww0001.do) に空室検索API・エリア検索APIのドキュメントは現存するが、**2020年2月25日をもってアカウント登録の新規申請が終了済み**（公式ページに告知）。新規にAPIキーを取得する手段がなく、`js/providers/jalan.js` の実装は不可能。**この点は再調査不要**
- **ヤフートラベル**: 公開APIなし（変更なし）
- **ディープリンクのみの統合はしない**: 価格を出せないため要件（重複施設の金額表記＋予約ボタン）を満たさない。かつ v13〜v18 で実装・実機検証したうえで `120d80c` で全廃した経緯があり、戻すのは後退
- 未検証の残された道: バリューコマース等アフィリエイト経由の宿泊フィードで価格が取れるか。必要になれば調査する
- 仮に将来統合する場合の課題（メモ）: エリアコード体系の相互マッピング、同一ホテルの名寄せ（名称+緯度経度で突合）、こだわり条件の対応表

なお `app.js` のプロバイダ抽象化（`PROVIDERS` 配列）はそのまま残す。実装コストは既に払っており、将来の追加口として無害。

## 検証状況

- 実APIキー（pk_形式）でGetAreaClass / VacantHotelSearchの疎通確認済み（curl + 実レスポンスをフィクスチャにしたブラウザ検証）
- 箱根2名1泊で213件、プラン合計¥9,000〜が安い順に正しく表示されることを確認
- ブラウザからの実検索は許可ドメイン（公開サイト）上でのみ可能なため、GitHub Pages公開後に最終確認する
