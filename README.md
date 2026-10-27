# cloud_browser — Cloud Run Remote Browser (Docker)

Cloud Run上でChromiumを実行し、外部サイトを閲覧するMVPです。iframeは使いません。利用者のブラウザにはスクリーンショットを送り、クリック・スクロール・キーボード入力をWebSocket経由でCloud Run上のブラウザへ転送します。

**目的:** 訪問先のWebサイトに、利用者端末のIPを直接知らせずにアクセスすること。訪問先への通常のHTTP(S)接続元はCloud Runの送信元IPになります。ログイン、Cookie、フィンガープリント等による追跡を防ぐ匿名化ツールではありません。

## できること

- URL入力、Webページ表示、戻る・進む・再読み込み
- マウスクリック・ホイール・キーボード入力
- HTTPS / WebSocketのブラウザUI
- パスワード認証、許可ドメイン、内部IPへのアクセスの一部制限
- DockerfileからCloud Runにデプロイ

**制限:** スクリーンショット転送は約350ms間隔。動画・音声・ファイルダウンロード・コピー＆ペースト・複数タブ・一部IME入力には未対応です。WebSocketの切断で閲覧状態が初期化されます。Cloud RunのWebSocket接続はリクエストタイムアウト（最大60分）の対象です。

## セキュリティ上の重要事項

**本アプリは実験用MVPです。任意の信頼できないサイトを閲覧できる一般公開サービスとして、そのまま運用しないでください。**

- アプリケーション層でHTTP(S)、標準ポート、パブリックIPを確認していますが、**DNSリバインディング、Chromium内部からの通信などのリスクを完全には防げません**。本番ではネットワーク層でプライベートIP/メタデータ宛を遮断してください。
- Playwright公式のDockerイメージは開発・テスト向けで、信頼できないWebサイトの閲覧には追加の隔離が必要です。
- パスワード・シークレットをGitHubにコミットせず、Secret Managerを使用してください。
- 初期設定はALLOWED_HOSTS=example.comです。任意のURLを許可するALLOWED_HOSTS=*はリスクが高く、隔離・外向き通信制限なしでの公開は推奨しません。
- Cloud Runを --allow-unauthenticated で公開した場合、Cloud Run入口は公開されます。アプリ認証のほかIAP/Cloud Armor等も検討してください。
- 現在のGitHubリポジトリがPublicの場合、ソースコードは公開されています。

## 構成

~~~text
利用者ブラウザ ── HTTPS + WebSocket ──> Cloud Run (Node.js)
        ↑                                  ↓
   JPEG画像・操作                         Chromium (Playwright)
                                            ↓ HTTP(S)
                                        外部Webサイト
~~~

~~~text
.
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── package.json
├── src/
│   ├── security.js
│   └── server.js
├── public/
│   ├── app.html
│   ├── app.js
│   ├── login.html
│   ├── login.js
│   └── style.css
└── test/
    └── security.test.js
~~~

## Dockerでローカル起動

~~~bash
git clone https://github.com/ryo-aien/cloud_browser.git
cd cloud_browser
cp .env.example .env
# .env の APP_PASSWORD(12文字以上)、SESSION_SECRET(32文字以上)、
# ALLOWED_HOSTS(例: example.com,*.example.com)を編集
# SESSION_SECRET生成例: openssl rand -hex 32
docker build --platform linux/amd64 -t cloud-browser .
docker run --rm -p 8080:8080 --env-file .env cloud-browser
~~~

http://localhost:8080 にアクセスしてパスワードでログインします。

## Cloud Runへデプロイ（Cloud Shell / bash）

前提: Google Cloudプロジェクトと課金が有効で、gcloud CLIログイン済み。Cloud Build/Cloud Run/Artifact Registry/Secret Managerの必要な権限が必要です。

~~~bash
export PROJECT_ID="$(gcloud config get-value project)"
export REGION=asia-northeast1
export REPOSITORY=cloud-browser
export SERVICE=cloud-browser
export IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/$SERVICE:latest"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

gcloud artifacts repositories create "$REPOSITORY" \
  --location="$REGION" --repository-format=docker \
  --description="Remote browser images"

# 実際の秘密情報をGitHub/コマンドライン引数へ書かず、入力する
gcloud secrets create remote-browser-password --replication-policy=automatic
gcloud secrets create remote-browser-secret --replication-policy=automatic
read -rs -p 'APP_PASSWORD (12文字以上): ' APP_PASSWORD; echo
printf %s "$APP_PASSWORD" | gcloud secrets versions add remote-browser-password --data-file=-
unset APP_PASSWORD
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add remote-browser-secret --data-file=-

gcloud iam service-accounts create remote-browser-runtime \
  --display-name="Remote Browser Runtime"
export SERVICE_ACCOUNT="remote-browser-runtime@$PROJECT_ID.iam.gserviceaccount.com"
for SECRET in remote-browser-password remote-browser-secret; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:$SERVICE_ACCOUNT" \
    --role=roles/secretmanager.secretAccessor
done

gcloud builds submit --tag "$IMAGE" .

gcloud run deploy "$SERVICE" \
  --image "$IMAGE" --region "$REGION" \
  --service-account "$SERVICE_ACCOUNT" \
  --memory 2Gi --cpu 2 --concurrency 10 --max-instances 1 \
  --timeout 3600 --session-affinity \
  --allow-unauthenticated \
  --set-secrets "APP_PASSWORD=remote-browser-password:latest,SESSION_SECRET=remote-browser-secret:latest" \
  --set-env-vars "ALLOWED_HOSTS=example.com,MAX_SESSIONS=2"
~~~

### GitHub連携（継続的デプロイ）でデプロイする場合

Cloud RunコンソールのGitHub連携（Cloud Buildトリガー）では `--set-secrets` が渡されないため、サービス側に一度だけ設定してください。設定は以降のリビジョンにも引き継がれます。未設定でもコンテナは起動しますが、`/healthz` 以外は503（設定エラー）を返します。

~~~bash
gcloud run services update cloud-browser --region europe-west1 \
  --service-account "$SERVICE_ACCOUNT" \
  --memory 2Gi --cpu 2 --timeout 3600 --session-affinity \
  --set-secrets "APP_PASSWORD=remote-browser-password:latest,SESSION_SECRET=remote-browser-secret:latest" \
  --set-env-vars "ALLOWED_HOSTS=example.com,MAX_SESSIONS=2"
~~~

本番用途では、権限の最小化、WebSocket再接続、監視、レート制限、ネットワーク制御、認証設計を別途検討してください。別ドメインを許可する場合はALLOWED_HOSTSを変更してください。

**固定の外向きIPが必要な場合:** Direct VPC egressとCloud NAT（予約済み静的IP）を追加します。標準のCloud Runからの送信元IPは固定ではありません。

## 開発・テスト

~~~bash
npm install
npm test
npm run check
~~~

Node.js単体実行はChromiumとPlaywrightの依存ライブラリが必要なため、通常はDockerで起動してください。テストと構文確認は実施済みですが、DockerイメージビルドとCloud Run実行は未検証です。

## 参考

- https://playwright.dev/docs/docker
- https://cloud.google.com/run/docs/triggering/websockets
- https://cloud.google.com/run/docs/container-contract
