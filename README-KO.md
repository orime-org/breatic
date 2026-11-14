<h1 align="center">Breatic</h1>

<p align="center"><strong>크리에이티브 팀을 위한 실시간 협업 AI 작업 공간.</strong></p>
<p align="center">온라인 서비스 제공 · 소스 코드 공개 · 데스크톱 브라우저</p>

<p align="center">
  <a href="https://breatic.ai/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_website_ko">웹사이트</a> ·
  <a href="https://breatic.ai/login?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_ko">Breatic 시작하기</a> ·
  <a href="https://youtu.be/mc1XAqtJD_M">45초 데모 (영어)</a> ·
  <a href="docs/USAGE.md">사용 가이드 (영어)</a> ·
  <a href="https://discord.gg/Yeu6A4aejN">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/orime-org/breatic/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/orime-org/breatic?style=flat&amp;color=blueviolet&amp;label=release&amp;display_name=tag"></a>
  <a href="LICENSE"><img alt="License: Elastic-2.0" src="https://img.shields.io/badge/license-Elastic--2.0-blue?style=flat"></a>
  <a href="https://discord.gg/Yeu6A4aejN"><img alt="Discord community" src="https://img.shields.io/badge/discord-join%20community-5865F2?style=flat&amp;logo=discord&amp;logoColor=white"></a>
  <a href="#get-started"><img alt="Quickstart guide" src="https://img.shields.io/badge/quickstart-guide-green?style=flat"></a>
</p>

<p align="center" dir="ltr">
  <a href="README.md">English</a> · <a href="README-CN.md">简体中文</a> · <a href="README-TW.md">繁體中文</a> · <a href="README-JA.md">日本語</a> · <strong>한국어</strong> · <a href="README-ES.md">Español</a> · <a href="README-PT-BR.md">Português</a><br>
  <a href="README-DE.md">Deutsch</a> · <a href="README-FR.md">Français</a> · <a href="README-AR.md">العربية</a> · <a href="README-RU.md">Русский</a> · <a href="README-UK.md">Українська</a> · <a href="README-TR.md">Türkçe</a> · <a href="README-TH.md">ภาษาไทย</a>
</p>

---

브리프, 장면, 미디어를 하나의 Project에 모으세요. Document Spaces에서 글을 쓰고 Canvas Spaces에서 에셋을 생성·수정하며, 제작 맥락을 공유하는 AI 에이전트 및 팀원과 함께 작업할 수 있습니다.

호스팅 서비스에는 무료 Starter 요금제가 있습니다. AI 생성 크레딧은 별도로 구매하며 멤버십에 포함되지 않습니다. [요금 및 크레딧][hosted-pricing]을 확인하세요.

![Breatic 캔버스의 카페 이미지 후보와 프로젝트 채팅. 영어 UI 예시](docs/images/readme/workspace-en.png)

## 할 수 있는 일

| 기능 | 용도 |
| --- | --- |
| **여러 Spaces가 있는 Project** | 브리프, 장면, 서로 다른 창작 방향을 별도 탭으로 정리합니다. |
| **Document Spaces** | 제목, 목록, 서식 있는 텍스트로 대본, 숏 설명, 제작 체크리스트를 작성합니다. |
| **Canvas Spaces** | 무한 캔버스에 참고 자료와 미디어를 배치하고 프롬프트, 모델, 참조 입력으로 에셋을 생성·수정합니다. |
| **3D (DEV)** | 공유 장면에 내장 오브젝트를 배치하고 위치, 회전, 크기를 편집합니다. |
| **Timeline (DEV)** | Project 동영상이나 업로드한 로컬 동영상을 공유 트랙에 배치하고 클립을 이동·트리밍·분할·복제·삭제하며, 자신의 편집을 취소하고 시퀀스를 미리 봅니다. Web Animation을 설명해 DeepSeek에게 만들게 하고 실행 목록에서 진행을 확인한 뒤, 결과를 Timeline 시계에 맞춰 재생되는 클립으로 추가합니다. 모든 트랙의 동영상과 Web Animation은 레이어로 겹쳐 함께 재생되며, 미리보기에서 레이어를 선택해 이동·크기 조절·늘이기·회전하거나 위치와 크기를 직접 입력할 수 있습니다. 재생 바 오른쪽 끝에서 화면 비율을 7가지(16:9, 9:16, 1:1, 4:3, 4:5, 2:3, 21:9) 중에서 고르면 레이어는 화면 안의 상대 위치를 유지합니다. |
| **프로젝트 내 AI 에이전트** | 아이디어를 논의하고 문서·캔버스 맥락을 제공하며 자료와 함께 제안을 검토합니다. |
| **실시간 협업** | 팀원을 초대하고 접근 권한을 설정하여 동기화된 캔버스, 문서, 3D 장면, Timeline을 함께 편집합니다. |

이미지, 동영상, 오디오, 3D 에셋을 지원합니다. 생성 기능은 설정된 제공업체와 모델 접근 권한에 따라 달라집니다. Canvas와 Document는 사용할 수 있으며 3D와 Timeline에는 **DEV** 표시가 붙습니다. 현재 Timeline은 여러 영상 트랙에서 동영상과 Web Animation의 편집과 미리보기를 지원하며, Web Animation은 이 기능을 켠 배포에서만 사용할 수 있습니다. 추가 미디어 유형과 동영상 내보내기는 예정된 기능입니다. 3D 장면 내 모델 생성과 주석은 개발 중입니다.

## 변경 사항을 함께 검토하기

작업 옆에 의사결정을 남기세요. 팀이 두 장면 이미지를 비교하는 동안 협업자가 공유 창작 방향을 편집할 수 있습니다. 에이전트는 문서의 문단을 바꾸기 전에 수정안을 제시하고, 팀이 적용할 내용을 결정합니다.

![공유 창작 방향과 두 장면 이미지. 영어 UI 예시](docs/images/readme/shared-direction.png)

![댓글 추가 및 교체 동작이 있는 문서 수정안. 영어 UI 예시](docs/images/readme/agent-review.png)

실제 예제 프로젝트의 화면이며 이야기와 장면 에셋은 설명을 위한 예시입니다.

## 창작 흐름: 30초 카페 동영상

**Studio**는 프로젝트와 에셋을 관리합니다. **Project**는 하나의 제작을 모으고, 그 안의 **Spaces**는 장면, 결과물 또는 창작 방향에 따라 작업을 나눕니다.

1. **브리프 작성:** Document Space에 이야기, 대상, 대사, 시각적 방향을 적습니다.
2. **에이전트와 협업:** 관련 맥락을 채팅에 제공하고 숏과 제안을 검토합니다.
3. **장면 제작:** Canvas Spaces에서 설정된 모델을 선택하고 프롬프트와 참고 자료로 에셋을 생성해 비교합니다.
4. **검토와 전달:** 팀원과 에셋을 고른 뒤 제작에 사용할 파일을 내려받습니다.

Spaces를 “도입 · 0–10초”, “주요 장면 · 10–20초”, “마무리 · 20–30초”로 이름 지을 수 있습니다. 이름은 계획용이며 클립 길이를 설정하거나 완성 동영상을 자동으로 만들지 않습니다. Timeline으로 배치와 미리보기를 하고 영상 편집기로 마무리·내보내기 작업을 하세요. [그림이 있는 예제 (영어)](docs/USAGE.md#example-from-a-brief-to-a-visual)도 참고하세요.

<a id="get-started"></a>

## 시작하기

- **호스팅 제품:** 데스크톱 브라우저에서 [Breatic 열기][hosted-app]를 선택해 가입하거나 로그인하세요.
- **자체 설치:** [개인 및 LAN 배포 가이드 (영어)](self-host/LOCAL.md)를 따르세요.
- **개발:** [개발 환경 설정 (영어)](self-host/DEVELOPMENT.md)을 확인하세요.

개인 Studio를 설정하고 Project를 만든 뒤 **+**로 Document, Canvas, 3D, Timeline Spaces를 추가하세요. 브리프를 쓰거나 참고 자료를 올리고 내장 3D 오브젝트를 배치할 수 있습니다. [사용 가이드 (영어)](docs/USAGE.md)에는 [키보드 단축키](docs/USAGE.md#keyboard-shortcuts)도 있습니다.

### 자체 호스팅 전에

웹, API, 백그라운드 작업, 협업은 공개된 Docker 이미지와 PostgreSQL, Redis를 사용합니다. 업로드와 미디어 처리에는 **본인 Cloudflare 계정**의 Ingest Worker와 미디어 컨테이너를 사용하며 파일은 본인 R2 버킷에 저장합니다. AI 호출은 본인의 제공업체 계정과 할당량을 사용합니다.

오프라인이나 완전한 온프레미스 설치가 아닙니다. LAN 접근에는 신뢰할 수 있는 HTTPS가 필요합니다. 클라우드와 모델 호출에는 비용이 발생할 수 있습니다. SMTP, Google 로그인, Stripe 결제, 검색은 선택적 연동입니다. 가이드에 따라 클라우드를 설정하고 검증하세요. 초기 Node/pnpm/Wrangler 단계는 배포 작업이며 일상적인 사용에 개발 서버가 필요한 것은 아닙니다.

## 상태, 도움말, 기여

호스팅 서비스는 사용할 수 있으며 계속 개발되고 있습니다. 위의 DEV 표시와 기능 범위는 그대로 적용됩니다. [릴리스](https://github.com/orime-org/breatic/releases)에서 공개 버전과 변경 사항을 확인하세요.

[버그 신고](https://github.com/orime-org/breatic/issues/new?template=bug_report.yml) · [기능 제안](https://github.com/orime-org/breatic/issues/new?template=feature_request.yml) · [Discord](https://discord.gg/Yeu6A4aejN)

보안 취약점은 [SECURITY.md](SECURITY.md)의 비공개 절차로 신고하세요. 이 프로젝트는 TypeScript, React/Vite, Hono, PostgreSQL, Redis/BullMQ, Hocuspocus/Yjs 및 업로드용 별도 Cloudflare Worker를 사용합니다.

[기여 방법](CONTRIBUTING.md) · [아키텍처](docs/ARCHITECTURE.md) · [테스트](docs/TEST-MANDATE.md)

[웹사이트](https://breatic.ai) · [X](https://x.com/breatic_ai) · [YouTube](https://www.youtube.com/@breatic_ai) · [Instagram](https://www.instagram.com/breatic_ai)

## 라이선스 및 허용 용도

Breatic은 [Elastic License 2.0](LICENSE) (Elastic-2.0)으로 소스 코드를 공개합니다. 읽기, 수정, 재배포, 개인 또는 조직 내부 실행이 가능하며 상업적 작업에도 사용할 수 있습니다. Breatic을 제3자에게 호스팅 또는 관리형 서비스로 제공할 수는 없습니다. 전체 조건은 라이선스를 확인하세요.

Breatic 이름과 로고는 Orime, Inc.의 상표이며 소프트웨어 라이선스에 포함되지 않습니다. [TRADEMARKS.md](TRADEMARKS.md)를 확인하세요. 라이선스는 Breatic으로 만드는 콘텐츠를 제한하지 않습니다.

### 생성된 콘텐츠

각 인스턴스의 운영자와 사용자는 저작권, 상표, 개인정보, 데이터 보호, 명예훼손, 콘텐츠 관리 등 관련 법률 준수, 입력 및 후속 사용에 필요한 권리 확보, 사용 맥락에 맞는 콘텐츠 관리에 책임을 집니다. Orime, Inc.는 생성된 콘텐츠의 정확성, 적법성, 독창성, 안전성을 보증하지 않습니다.

타사 구성요소 및 고지는 [THIRD-PARTY.md](THIRD-PARTY.md)에 있습니다.

[hosted-app]: https://breatic.ai/login?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_ko
[hosted-pricing]: https://breatic.ai/ko/pricing/?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_pricing_ko

© 2026 Orime, Inc.
