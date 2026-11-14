<h1 align="center">Breatic</h1>

<p align="center"><strong>クリエイティブチームのための、リアルタイムで共同制作できる AI ワークスペース。</strong></p>
<p align="center">オンラインで利用可能 · ソースコード公開 · デスクトップブラウザー</p>

<p align="center">
  <a href="https://breatic.ai/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_website_ja">公式サイト</a> ·
  <a href="https://breatic.ai/login?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_ja">Breatic を試す</a> ·
  <a href="https://youtu.be/mc1XAqtJD_M">45秒のデモ（英語）</a> ·
  <a href="docs/USAGE.md">使い方（英語）</a> ·
  <a href="https://discord.gg/Yeu6A4aejN">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/orime-org/breatic/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/orime-org/breatic?style=flat&amp;color=blueviolet&amp;label=release&amp;display_name=tag"></a>
  <a href="LICENSE"><img alt="License: Elastic-2.0" src="https://img.shields.io/badge/license-Elastic--2.0-blue?style=flat"></a>
  <a href="https://discord.gg/Yeu6A4aejN"><img alt="Discord community" src="https://img.shields.io/badge/discord-join%20community-5865F2?style=flat&amp;logo=discord&amp;logoColor=white"></a>
  <a href="#get-started"><img alt="Quickstart guide" src="https://img.shields.io/badge/quickstart-guide-green?style=flat"></a>
</p>

<p align="center" dir="ltr">
  <a href="README.md">English</a> · <a href="README-CN.md">简体中文</a> · <a href="README-TW.md">繁體中文</a> · <strong>日本語</strong> · <a href="README-KO.md">한국어</a> · <a href="README-ES.md">Español</a> · <a href="README-PT-BR.md">Português</a><br>
  <a href="README-DE.md">Deutsch</a> · <a href="README-FR.md">Français</a> · <a href="README-AR.md">العربية</a> · <a href="README-RU.md">Русский</a> · <a href="README-UK.md">Українська</a> · <a href="README-TR.md">Türkçe</a> · <a href="README-TH.md">ภาษาไทย</a>
</p>

---

制作のブリーフ、シーン、メディアを一つの Project にまとめます。Document Spaces で文章を書き、Canvas Spaces で素材を生成・調整し、作品の文脈を共有しながら AI エージェントやメンバーと制作を進められます。

ホスト版には無料の Starter プランがあります。AI 生成用クレジットは別途購入するもので、メンバーシップには含まれません。[料金とクレジット][hosted-pricing]をご覧ください。

![Breatic のキャンバスに並ぶカフェの候補画像とプロジェクトチャット。英語 UI の例](docs/images/readme/workspace-en.png)

## できること

| 機能 | 用途 |
| --- | --- |
| **複数の Spaces を持つ Project** | ブリーフ、シーン、異なる制作方針を別々のタブで整理します。 |
| **Document Spaces** | 見出し、リスト、書式付きテキストで脚本、ショットの説明、制作チェックリストを作成します。 |
| **Canvas Spaces** | 無限キャンバスに参考資料やメディアを配置し、プロンプト、モデル、参照入力で素材を生成・調整します。 |
| **3D（DEV）** | 共有シーンに組み込みオブジェクトを配置し、位置、回転、スケールを編集します。 |
| **Timeline（DEV）** | Project の動画やアップロードしたローカル動画を共有トラックに並べ、クリップの移動・トリミング・分割・複製・削除、自分の編集の取り消し、シーケンスのプレビューができます。Web Animation の内容を書いて DeepSeek に作らせ、実行リストで進行を確認し、結果を Timeline の時計で再生されるクリップとして追加できます。各トラックの動画と Web Animation はレイヤーとして重なって同時に再生され、プレビューでレイヤーを選ぶと移動・拡大縮小・伸縮・回転でき、位置とサイズを数値で入力することもできます。再生バーの右端で画面比率を 7 種類（16:9、9:16、1:1、4:3、4:5、2:3、21:9）から選べ、レイヤーは画面内の相対位置を保ちます。 |
| **プロジェクト内の AI エージェント** | アイデアを話し合い、文書やキャンバスの文脈を渡し、素材とともに提案を検討します。 |
| **リアルタイム共同編集** | メンバーを招待し、アクセス権を設定して、同期されたキャンバス、文書、3D シーン、Timeline を共同編集します。 |

画像、動画、音声、3D 素材に対応します。生成機能は設定したプロバイダーとモデルの利用権限によって異なります。Canvas と Document は利用可能で、3D と Timeline には **DEV** と表示されます。現在の Timeline は複数の映像トラック上で動画と Web Animation の編集とプレビューに対応し、Web Animation は有効にしたデプロイでのみ利用できます。ほかのメディア形式と動画書き出しは計画段階です。3D シーン内のモデル生成と注釈は開発中です。

## 変更を一緒に確認する

制作上の判断を作品のそばに残せます。二つのシーン画像を比較しながら、共同作業者が共有の制作方針を編集できます。エージェントは文書の段落を置き換える前に書き直し案を提示し、チームが採用する内容を決めます。

![二つのシーン画像と共有の制作方針。英語 UI の例](docs/images/readme/shared-direction.png)

![コメント追加と置換の操作を備えた書き直し案。英語 UI の例](docs/images/readme/agent-review.png)

実際のサンプルプロジェクトの画面です。ストーリーとシーン素材は説明用のものです。

## 制作の流れ：30 秒のカフェ動画

**Studio** はプロジェクトと素材を管理します。**Project** は一つの制作をまとめ、その中の **Spaces** でシーン、成果物、制作方針ごとに作業を分けます。

1. **ブリーフを書く：** Document Space にストーリー、対象者、台詞、ビジュアルの方向性を記載します。
2. **エージェントと相談する：** 必要な文脈をチャットに渡し、ショットと提案を検討します。
3. **各シーンを制作する：** Canvas Spaces で設定済みモデルを選び、プロンプトと参考資料を加えて素材を生成・比較します。
4. **確認して受け渡す：** メンバーと素材を選び、制作に使うファイルをダウンロードします。

Spaces を「冒頭・0–10 秒」「メイン・10–20 秒」「締め・20–30 秒」などと名付けられます。これは計画用の名前で、クリップの長さを設定したり動画を自動で完成させたりするものではありません。Timeline で配置とプレビューを行い、仕上げと書き出しには動画編集ソフトを使います。[図解付きの例（英語）](docs/USAGE.md#example-from-a-brief-to-a-visual)もご覧ください。

<a id="get-started"></a>

## はじめに

- **ホスト版：** デスクトップブラウザーで [Breatic を開き][hosted-app]、登録またはログインします。
- **セルフホスト：** [個人・LAN 向け導入ガイド（英語）](self-host/LOCAL.md)に従います。
- **開発：** [開発環境の設定（英語）](self-host/DEVELOPMENT.md)をご覧ください。

個人の Studio を設定し、Project を作成して、**+** から Document、Canvas、3D、Timeline の Spaces を追加します。ブリーフ、参考資料のアップロード、組み込み 3D オブジェクトの配置から始められます。[操作ガイド（英語）](docs/USAGE.md)には[キーボードショートカット](docs/USAGE.md#keyboard-shortcuts)もあります。

### セルフホストの前に

Web、API、バックグラウンド処理、共同編集には公開済みの Docker イメージを使用し、PostgreSQL と Redis に依存します。アップロードとメディア処理には、**ご自身の Cloudflare アカウント**上の Ingest Worker とメディアコンテナー、R2 バケットを使用します。AI 呼び出しにはご自身のプロバイダーアカウントと利用枠が必要です。

オフラインや完全なオンプレミスの構成ではありません。LAN アクセスには信頼できる HTTPS が必要です。クラウドサービスやモデルの利用には料金がかかる場合があります。SMTP、Google ログイン、Stripe 決済、検索は任意の連携です。ガイドに従ってクラウドを設定・確認してください。初回の Node/pnpm/Wrangler の作業はデプロイ用で、日常利用に開発サーバーを起動する必要はありません。

## 状況、サポート、貢献

ホスト版は公開されており、開発も継続中です。上記の DEV 表示と機能範囲は引き続き適用されます。[公開リリース](https://github.com/orime-org/breatic/releases)で更新内容を確認できます。

[不具合報告](https://github.com/orime-org/breatic/issues/new?template=bug_report.yml) · [機能提案](https://github.com/orime-org/breatic/issues/new?template=feature_request.yml) · [Discord](https://discord.gg/Yeu6A4aejN)

脆弱性は [SECURITY.md](SECURITY.md) に従い、非公開の窓口に報告してください。TypeScript、React/Vite、Hono、PostgreSQL、Redis/BullMQ、Hocuspocus/Yjs と、アップロード用の独立した Cloudflare Worker を使用しています。

[貢献方法](CONTRIBUTING.md) · [アーキテクチャ](docs/ARCHITECTURE.md) · [テスト](docs/TEST-MANDATE.md)

[公式サイト](https://breatic.ai) · [X](https://x.com/breatic_ai) · [YouTube](https://www.youtube.com/@breatic_ai) · [Instagram](https://www.instagram.com/breatic_ai)

## ライセンスと利用範囲

Breatic のソースコードは [Elastic License 2.0](LICENSE)（Elastic-2.0）で公開されています。閲覧、変更、再配布、ご自身での実行、組織内での実行が可能で、商用の制作作業にも利用できます。第三者に Breatic をホスト型またはマネージドサービスとして提供することはできません。詳細はライセンス本文をご確認ください。

Breatic の名称とロゴは Orime, Inc. の商標で、ソフトウェアライセンスの対象外です。[TRADEMARKS.md](TRADEMARKS.md) をご覧ください。このライセンスは Breatic で制作するコンテンツを制限しません。

### 生成コンテンツ

各インスタンスの運営者と利用者は、著作権、商標、プライバシー、データ保護、名誉毀損、コンテンツ管理などの適用法令を遵守し、入力やその後の利用に必要な権利を確保して、利用状況に応じたコンテンツ管理を行う責任を負います。Orime, Inc. は生成物の正確性、適法性、独創性、安全性を保証しません。

第三者のコンポーネントと通知は [THIRD-PARTY.md](THIRD-PARTY.md) に記載しています。

[hosted-app]: https://breatic.ai/login?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_ja
[hosted-pricing]: https://breatic.ai/ja/pricing/?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_pricing_ja

© 2026 Orime, Inc.
