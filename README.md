# 프로모션 자동화 — 사용 가이드 (v4.0)

Figma 에서 시안 → 추출 → UTF-8 zip → Way(Jira) 이슈 첨부 + 댓글 등록까지, 사업부 PPT 를 Figma 로 자동 가져오기, **PPT 영역 텍스트 → 팝업 컴포넌트 자동 적용 (다중 종류 지원)**, **AI 이미지 자동 생성·적용** 까지 한 흐름으로 처리.

**v4.1 신규 기능 — PLATFORM-8 사내 이미지 라이브러리 우선 매칭**
- 팝업/배너 `[적용 + 이미지 생성]` 시 AI 호출 전에 사내 라이브러리 (`http://10.10.224.110:3000/api/images`) 를 먼저 조회 → 매칭 있으면 인라인 픽커에서 썸네일 한 번 클릭으로 즉시 적용 (AI 호출 안 함 → 비용 절감)
- 검색 키워드 = **프레임명의 promotion + 프레임 내 모든 텍스트 노드** 자동 조합 (한글 NFC/NFD 정규화)
- **AI 이미지 스타일 dropdown 값이 라이브러리 view 필터로 그대로 매핑** — 3D 선택 시 라이브러리도 3D 만, 2D 선택 시 2D 만 노출
- **흰 배경 자동 투명 처리** — 코너 floodfill 로 오브젝트 안쪽 흰색은 유지하면서 배경만 alpha=0
- **프레임 배경 파스텔 자동 적용** — 투명 처리된 이미지의 dominant color → HSL L 0.87~0.93 clamp (AI 생성과 동일 룰)
- SVG 는 자동 제외 (Figma image fill 이 raster 만 지원)
- 소통참여(sotong) 는 실사 사진 대상이라 이 흐름 미적용, 매칭 없거나 취소 시 조용히 AI 생성으로 폴백

**v4.0 신규 기능 — AI 이미지 생성**
- [적용 + 이미지 생성] 한 번에 컴포넌트 텍스트 자동 매핑 + GPT-4o-mini 가 한국어 문구에서 영어 개체명 추출 + gpt-image-1 으로 투명 배경 PNG 생성
- **3가지 스타일 선택**: 3D 일러스트 / 실사 사진 / 2D 일러스트 (라인 없는 flat design)
- **미리보기 → 적용 / 재생성 / 취소** — 마음에 안 들면 hint/style 바꿔서 재생성, 적용 안 하면 Figma 에 손도 안 댐
- **재생성 코멘트 입력** — 미리보기 박스의 textarea 에 "분홍색 톤으로", "카드 말고 선물상자로" 같은 피드백 적으면 GPT 가 그걸 반영해 다음 이미지 재생성
- 생성 이미지의 dominant color → HSL Lightness 87~93 으로 클램프 → **프레임 배경에 자동 파스텔 적용**
- 진행 표시 박스 (단계 + 경과 시간 카운터)
- **마지막 입력값 자동 기억** — style/hint 가 figma.clientStorage 에 저장돼 plugin 재실행해도 그대로 복원
- **일괄 처리** — frame 여러 개 multi-select 후 버튼 누르면 "N개 영역 일괄 처리" 로 라벨 자동 변경, 순차 실행 (미리보기 자동 스킵)
- **미리보기 없이 바로 적용** 체크박스 — 빠른 단발 작업 또는 일괄 모드용 (매 실행 시 default off)
- **금액·% 숫자 강조** 체크박스 — 텍스트의 `20,000원` / `5%` 같은 패턴 추출해 이미지에 큰 글자로 노출 (옵트인, 매 실행 시 default off)
- **한국 지역명 자동 인식** (28개) — `양산`(parasol), `경주`(race), `영광`(glory) 같은 동음이의어 도시명을 GPT 가 일반 명사로 오역하지 않게 어노테이션 자동 주입

**v3.9 기능 (계속 사용)**
- PPT 슬라이드별 mockup 영역 자동 인식 (텍스트 + 사각형/그림 container 기반 클러스터링)
- 영역 sub-frame 1개 선택 OR 텍스트 노드 다중 선택 → **[팝업 적용]** 으로 자동 인스턴스 생성 + placeholder 채움
- **다중 팝업 종류 등록** — 홈팝업 / 진입팝업 / 다른 사이즈 등 여러 종류 등록 후 dropdown 에서 골라서 적용
- 텍스트 개수에 따라 자동 매핑 (1개: 메인 / 2개: 메인+버튼 / 3개: 상단+메인+버튼 / 4개: +설명 / 5개: +설명 서브)
- `img`, `이미지`, `(... 이미지)`, `설명 텍스트` 같은 placeholder 자동 제외
- Helper 코드는 disk 직접 사용 — 수정 시 helper 재시작만 하면 자동 적용
- macOS TCC 자동 감지 — install.sh 가 helper 를 보호 폴더 밖으로 자동 이동

---

## 한 줄 요약

이슈 키 입력만으로 (1) 사업부 PPT 슬라이드를 Figma 에 가져오기, (2) 작업 끝나면 Way 에 zip 첨부 + 자동 댓글까지 끝.

---

## 사전 준비물 (각자)

- macOS
- **Figma 데스크톱 앱** (웹 브라우저 X)
- **Python 3.9 이상** (보통 기본 설치됨. 확인: `python3 --version`)
- **Homebrew** (`brew --version` 으로 확인)
- **Way 계정** (영문 ID + 비밀번호)
- **Pretendard 폰트** (Figma 의 텍스트 노드 표시에 사용; 사내 표준이라 보통 설치돼 있음)
- **OpenAI API 키** (AI 이미지 생성 기능 쓸 거면) — https://platform.openai.com/api-keys 에서 발급. `gpt-image-1` 사용 권한 + 결제수단 필요. 한 번 생성당 약 $0.04 (1024×1024). 생성 안 쓸 거면 생략 가능

---

## 1회 설치 (약 10분)

### Step 1. 도구 받기

`promo-automation` 폴더를 받아서 `~/Documents/` 안에 두기.

```
~/Documents/promo-automation/
├── figma-plugin/   ← Figma 가 사용 (이 위치 그대로 OK)
└── helper/         ← 백그라운드 서버 (install.sh 가 알아서 hidden 폴더로 옮김 — 아래 Step 4)
```

> **macOS TCC 경고**: helper 디렉토리는 `~/Documents` 안에 그대로 두면 launchd 가 접근 차단해서 helper 가 동작 안 합니다 (`Operation not permitted`). 걱정 마세요 — Step 4 의 `install.sh` 가 이 문제를 감지하고 자동으로 `~/.promo-automation/helper-src` 로 이동 + 원래 위치에는 symlink 를 만들어 줍니다. Finder/Editor 에서는 똑같은 위치로 보입니다.

### Step 2. LibreOffice + Poppler 설치

PPT → PDF → PNG 변환에 사용합니다.

```bash
brew install --cask libreoffice
brew install poppler
```

설치 후 macOS Gatekeeper 차단 풀기 (LibreOffice 만):
```bash
sudo xattr -rd com.apple.quarantine /Applications/LibreOffice.app
```

**중요**: LibreOffice 를 한 번 GUI 로 실행 (Finder → 응용 프로그램 → LibreOffice 더블클릭). 첫 실행으로 폰트 cache 가 빌드되어야 한글 텍스트 변환이 정상 동작. 창이 뜨면 바로 닫아도 OK.

### Step 3. Way 인증 정보 작성

```bash
mkdir -p ~/.promo-export
chmod 700 ~/.promo-export
```

`~/.promo-export/config.json` 파일 생성:

```json
{
  "way_base_url":  "https://konaway.konai.com",
  "way_username":  "본인영문ID",
  "way_password":  "본인비밀번호",
  "default_file_key": "이번달 마스터 파일 fileKey",
  "openai_api_key": "sk-..."
}
```

- `way_username` 은 **영문 ID** (예: `sb.shin14`). 사번 숫자 아님.
- 매월 마스터 파일이 바뀌면 `default_file_key` 갱신.
- `openai_api_key` 는 **AI 이미지 생성 기능 쓸 때만 필요**. 없으면 `[적용 + 이미지 생성]` 버튼이 503 떨어짐. (PPT 가져오기/Way 업로드 같은 다른 기능은 키 없어도 동작)
- 또는 `helper/.env` 에 `OPENAI_API_KEY=sk-...` 한 줄로 넣어도 helper 가 자동 인식.
- 팀에서 템플릿 설정을 공유하려면 `templates_sync_url` (+ private repo 면 `templates_sync_token`) 도 추가. 자세한 워크플로우는 Step 7-보너스 참고.

저장 후 권한 잠금:
```bash
chmod 600 ~/.promo-export/config.json
```

> 주의: 평문 비밀번호이므로 절대 git/슬랙에 공유 금지.

### Step 4. Helper 설치 (백그라운드 서버)

```bash
cd ~/Documents/promo-automation/helper
bash install.sh
```

자동으로:
- **TCC 감지**: `~/Documents` 안 helper 는 launchd 가 못 읽으니, 한 번 prompt 표시
  ```
  [!] 경고: helper 코드 위치가 macOS TCC 보호 폴더 안입니다.
      자동으로 이동하시겠어요? [y/N]
  ```
  **`y` + Enter** 누르면:
  - 코드를 `~/.promo-automation/helper-src/` 로 이동
  - `~/Documents/promo-automation/helper/` 에 symlink 생성 (Finder 보기/편집 그대로 가능)
- Python 가상환경 + 라이브러리 (FastAPI, Pillow, pdf2image, python-pptx 등) 설치
- macOS 로그인 시 자동 시작 등록 (launchd)
- `http://127.0.0.1:7000` 에서 백그라운드 상시 실행

`설치 완료` 메시지 + `코드 위치: /Users/.../.promo-automation/helper-src` 보이면 OK. 컴퓨터 재시작해도 자동 재시작.

확인:
```bash
curl -s http://127.0.0.1:7000/health
```
`"config_loaded":true` 보이면 정상.

### Step 5. Figma Plugin 등록

Figma 데스크톱 앱에서:
1. 메뉴 → **Plugins → Development → Import plugin from manifest...**
2. `~/Documents/promo-automation/figma-plugin/manifest.json` 선택
3. 등록되면 어떤 파일에서든 **Plugins → Development → Promotion Automation** 으로 사용 가능

### Step 6. work 컴포넌트 1회 배치

라이브러리 자동 import 는 Figma plugin 정적 검사가 막아서, **작업 파일에 work 컴포넌트 인스턴스를 한 번만 끌어다 둡니다**:

1. Figma 좌측 **Assets** 탭
2. **Libraries** 에 `[LOCAL] Common` 활성화
3. 검색에 `work` → 컴포넌트 드래그해서 캔버스 어디든 한 번 두기

도구가 그 인스턴스의 main 을 찾아 새 인스턴스 자동 생성합니다.

### Step 7. 팝업 / 배너 컴포넌트 등록 (종류마다 1회)

v3.9.3 부터 placeholder 이름에 의존하지 않습니다. 컴포넌트 안의 모든 TEXT 노드를 **위→아래 위치 순서** 로 정렬해서 매핑하므로, 자식 노드 이름이 무엇이든 동작:

| 컴포넌트 종류 | placeholder 예시 (위→아래) |
|---|---|
| 팝업 | 상단 텍스트 / 메인텍스트 / 설명 / 설명 서브 / 버튼명 |
| 배너 | 서브텍스트 / 메인텍스트 |
| 다른 형태 | (자유) |

**(1) 템플릿 파일에서 컴포넌트로 변환 + publish**

1. 템플릿 파일에서 frame 우클릭 → **컴포넌트로 만들기** (Cmd+Opt+K)
2. 좌측 **Assets** 탭 → **Libraries** → 해당 라이브러리 **Publish**
3. 작업 파일에 그 라이브러리 활성화

**(2) 작업 파일에서 plugin 에 등록 (종류마다 반복)**

1. 작업 파일 → Assets → 라이브러리에서 등록할 팝업 컴포넌트 한 번 드래그 (인스턴스 생성)
2. 그 인스턴스 선택 + Plugin **[(라이브러리 인스턴스 선택) 팝업 종류 등록]** 클릭
3. 로그에 `✓ 팝업 종류 등록 완료 (총 N종)` + **자식 TEXT 노드 이름들** + **매칭된 placeholder** 표시
4. 다른 사이즈/종류 팝업도 같은 방식으로 누적 등록 가능
5. Plugin UI 의 dropdown 에 등록한 모든 종류가 자동으로 나타남

**잘못 등록된 경우**: dropdown 에서 해당 종류 선택 + **[(선택된 종류) 등록 삭제]** 클릭 — 컴포넌트 자체는 안 지워지고 plugin 의 등록 정보만 제거.

**기존 v3.8 이전 등록 (홈팝업 1개) 자동 마이그레이션**: 처음 v3.9 plugin 을 실행하면 옛 등록이 자동으로 새 다중 구조로 옮겨집니다. 재등록 불필요.

### Step 7-보너스. 템플릿 설정 팀 공유 (선택)

매 사용자가 따로 등록할 필요 없이, 한 명이 등록한 popup/배너/상세 템플릿 묶음을 GitHub repo 에 올려두고 다른 사람들은 plugin 버튼 한 번으로 동기화할 수 있습니다.

**방식 1 — 수동 (개발 없이 즉시 사용 가능)**

1. 한 명이 plugin → **설정 백업** → **[↑ 내보내기]** → JSON 다운로드
2. 받은 JSON 을 사내 공유폴더/슬랙으로 전달
3. 다른 사람은 같은 영역 → **[↓ 가져오기]** → JSON 선택

**방식 2 — 원격 자동 동기화 (권장)**

1. 한 명이 plugin → **[↑ 내보내기]** 로 JSON 받음 → 팀 git repo 에 `templates.json` 으로 commit/push
2. 각자 `~/.promo-export/config.json` 에 url(+token) 추가:
   ```json
   {
     "templates_sync_url":   "https://raw.githubusercontent.com/<org>/<repo>/<branch>/templates.json",
     "templates_sync_token": "ghp_..."
   }
   ```
   - public repo / public gist 면 `templates_sync_token` 생략 가능
   - private repo 면 GitHub Personal Access Token (repo read 권한) 필요
3. Helper 재시작:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.konai.promo-automation.plist
   launchctl load ~/Library/LaunchAgents/com.konai.promo-automation.plist
   ```
4. Plugin → **설정 백업** → **[⟳ 원격 설정 동기화]** 클릭 → 자동 import

> 동기화는 버튼을 직접 누를 때만 실행되어 의도치 않은 덮어쓰기를 막습니다. 라이브러리에 새 팝업 종류가 추가되면 한 명이 등록 + JSON export + repo push, 나머지 팀원은 [원격 설정 동기화] 한 번으로 끝.

> Helper `/health` 응답의 `"templates_sync_configured": true` 로 설정 여부 확인 가능.

---

## 매번 작업할 때

### A. 사업부 이슈에서 작업 시작 (선택)

1. Figma 데스크톱에서 작업할 파일 열기
2. Plugin 실행 → Way 이슈 키 입력 (예: `KONASALES-72525`)
3. **"이슈 PPT 슬라이드 가져오기"** 클릭

자동으로:
- Helper 가 Way 에서 PPT 다운로드
- LibreOffice 로 PPT → PDF, poppler 로 PDF → 슬라이드별 PNG
- python-pptx 로 슬라이드별 텍스트 추출 (좌→우, 위→아래 순서)
- Plugin 이 Figma 캔버스의 빈 공간에:
  - 상단 라벨: `{MMDD}_{이슈키}_{이슈명}`
  - work 컴포넌트 (assignee + 작업중 + 오늘 날짜)
  - 슬라이드 PNG 들 위→아래 + 각 슬라이드 오른쪽에 추출된 텍스트

디자이너는 그 정보 옆에서 디자인 작업 시작.

### B-1. PPT 영역 → 팝업 자동 적용

PPT 슬라이드의 한 mockup 이 팝업이면 **두 가지 방법** 중 하나로 적용:

**(방법 1) 영역 sub-frame 선택** — 자동 영역 인식이 정확할 때
1. 해당 영역 sub-frame 1개 선택 (예: `슬라이드1_영역5`)
2. Plugin dropdown 에서 **팝업 종류** 선택 (홈팝업 / 진입팝업 / 등)
3. **[팝업 적용]**

**(방법 2) TEXT 다중 선택** — 자동 영역이 여러 mockup 텍스트가 섞였을 때 (권장)
1. Figma 캔버스에서 팝업에 들어갈 텍스트 노드들을 **Shift+클릭** 으로 다중 선택
2. Plugin dropdown 에서 **팝업 종류** 선택
3. **[팝업 적용]**

**매핑 패턴** (사용 텍스트 개수별):

| 텍스트 수 | 매핑 |
|---|---|
| 1개 | 메인 |
| 2개 | 메인 / 버튼 |
| 3개 | 상단 / 메인 / 버튼 |
| 4개 | 상단 / 메인 / 설명 / 버튼 |
| 5개 | 상단 / 메인 / 설명 / 설명 서브 / 버튼 |
| 6개 이상 | 처음 5개만 매핑, 나머지 무시 |

**자동 제외**: 다음 텍스트들은 매핑에서 자동 빠짐
- `img`, `IMG`, `Img`, `image`, `IMAGE`, `이미지`, `photo`, `사진` (대소문자 무관)
- `(쿠폰 2종이 카트 바구니로 쏟아지는 이미지)` 같은 괄호 안 이미지 설명
- 1~2자 자투리 영문 (`i`, `xx` 등)

**정렬**: 선택 순서 무관. 도구가 자동으로 위→아래, 좌→우 순서로 정렬해서 매핑.

자동으로:

- 등록된 홈팝업 컴포넌트 인스턴스 생성 → 그 frame 오른쪽에 배치
- PPT 텍스트 개수에 따라 placeholder 자동 매핑:

매핑 규칙 (placeholder 가 위→아래 정렬된 상태에서):

| PPT 텍스트 N | 매핑 |
|---|---|
| N=1 | "메인" 키워드 있는 placeholder 우선, 없으면 첫 번째 |
| N=2 | [위 첫 1개, 가장 아래 1개] |
| N=3 | [첫, 둘째, **마지막**] = 보통 상단/메인/버튼 |
| N=4 | [첫, 둘째, 셋째, **마지막**] = 상단/메인/설명/버튼 |
| N=5 (= placeholder 5개 팝업) | 1:1 |
| N > placeholder 수 | 처음 N-1 + 마지막, 나머지 무시 |

핵심: **"마지막 텍스트는 마지막 placeholder"** 보존 → 팝업의 버튼 자리 / 배너의 메인 강조 자리 자동 매핑.

등록 시 plugin 로그에 **매핑 미리보기** (N=1~5 일 때 어떤 placeholder 에 들어갈지) 가 표시됩니다. 의도와 안 맞으면 컴포넌트의 placeholder 시각적 순서 (y 좌표) 를 조정.

설명 텍스트 / 설명 서브 텍스트는 PPT 에 없으면 자동으로 빠집니다. 매핑 결과는 plugin 로그에 표시. 빗나간 자리는 디자이너가 클릭해서 직접 수정.

### B-1.5. AI 이미지 자동 생성 (선택)

팝업/배너에 AI 그림을 넣고 싶으면 **[적용 + 이미지 생성]** 버튼 한 번이면 끝. 텍스트 매핑 + 이미지 생성 + 프레임 배경 파스텔 적용까지 자동.

**선행 조건**
- 컴포넌트 안에 이미지 자리 RECTANGLE/FRAME 노드가 있어야 함. 이름에 `img` / `image` / `이미지` / `사진` / `photo` 중 하나가 들어가거나, 이미 IMAGE 타입 fill 이 깔려 있으면 자동 인식. 후보 여러 개면 면적 가장 큰 노드 선택.
- `~/.promo-export/config.json` 또는 `helper/.env` 에 `openai_api_key` (또는 `OPENAI_API_KEY`) 설정.

**사용법**
1. 적용 탭 → 배너 / 팝업 sub-tab 이동
2. **AI 이미지 스타일** 선택 (3D 일러스트 / 실사 사진 / 2D 일러스트) — 기본 3D
3. 필요하면 **AI 이미지 스타일 힌트** 입력 (예: `따뜻한 톤`, `pink theme`) — 영어로 적어도 OK
4. **금액·% 숫자 강조** 체크박스 — 텍스트에 `20,000원` 같은 패턴 있고 그 숫자를 이미지에 크게 보여주고 싶으면 체크 (옵트인)
5. PPT 영역 또는 텍스트 노드 선택 + **[적용 + 이미지 생성]**
6. 진행 박스에 단계·경과 시간 표시 (보통 20~30초)
7. **미리보기** 가 뜸 → 마음에 들면 **[적용]**, 안 쓸 거면 **[취소]**
8. 별로면 미리보기 박스의 **재생성 코멘트** textarea 에 피드백 적고 **[재생성]** 클릭
   - 예: `더 귀여운 캐릭터로`, `분홍색 톤으로`, `카드 말고 선물상자로`
   - GPT 가 그 코멘트를 다음 개체명 추출과 최종 프롬프트에 모두 반영 → 자연스럽게 의도 반영된 결과
   - 코멘트 비워두고 [재생성] 누르면 같은 설정으로 랜덤 재생성

**프롬프트 동작**
- GPT-4o-mini 가 한국어 문구에서 영어 핵심 개체명만 추출 (예: "여름 카드 할인 쿠폰 이벤트" → `a summer discount coupon`)
- 스타일별 고정 템플릿에 끼워 넣음:
  - **3D**: `Simple 3D illustration of {개체명}, cute and minimal, smooth matte plastic texture, isolated subject on transparent background, ...`
  - **실사**: `Photorealistic studio photograph of {개체명}, soft natural lighting, ...`
  - **2D**: `Flat design illustration of {개체명}, simple clean vector style, solid color fills only, no outline, no stroke, no line art, no text, no letters`
- 항상 투명 배경 PNG 로 생성 (gpt-image-1 의 `background="transparent"` 옵션)

**프레임 배경색 자동 적용**
- 생성된 이미지의 dominant color → HSL Lightness 87~93 으로 클램프 → 프레임 SOLID fill 로 자동 세팅
- 즉 이미지와 어울리는 파스텔 톤이 프레임 배경에 자동으로 깔림 (별도 작업 없음)

**비용** — gpt-image-1 1024×1024 기준 한 장당 약 $0.04. 재생성마다 새로 호출되므로 적절히 사용.

### B-1.5.a. PLATFORM-8 사내 라이브러리 우선 매칭 (v4.1)

팝업/배너에 `[적용 + 이미지 생성]` 을 누르면 AI 호출 전에 사내 이미지 라이브러리를 먼저 조회합니다. 매칭 이미지가 있으면 배너/팝업 sub-tab 안에 **인라인 픽커** 가 나타나며, 썸네일을 한 번 클릭하면 즉시 프레임 fill 로 적용됩니다 (AI 호출 안 함).

**적용 대상**
- 팝업(popup) / 배너(banner) 프레임만
- 소통참여(sotong) 는 실사 사진 목적이라 대상 아님

**검색 키워드 자동 조합**
- 프레임명의 `{promotion}` 부분 (예: `0703_banner_전통시장_984x264` → `전통시장`)
- 프레임 안의 모든 텍스트 노드 (매핑된 문구 전부)
- 둘을 공백으로 합쳐서 subject 매칭
- 매칭 우선순위: exact > 한쪽이 상대 prefix > subject 가 query 안에 포함 > query 가 subject 안에 포함 > 2글자 이상 토큰 부분일치
- 동점 시 favorite 우선 → 최신 순
- 한글 NFC/NFD 자동 정규화 (한글 자모 분리 인코딩 대응)

**AI 스타일 dropdown → 라이브러리 view 필터 매핑**
- **3D 일러스트** → 라이브러리 3D 항목만
- **2D 일러스트** → 라이브러리 2D 항목만 (`.svg` 는 자동 제외 — Figma image fill 은 raster 만 지원)
- **실사 사진** → 전체 (라이브러리엔 실사 없어서 결국 AI 폴백)
- 픽커 안 상단 필터 버튼(전체/3D/2D)으로 재조정 가능
- 픽커 검색창은 자동 조합된 키워드가 pre-fill 돼 있고, 편집 후 `[검색]` 으로 재검색 가능

**자동 후처리 (AI 생성과 동일 룰)**
- 흰 배경(`#ffffff`) 을 4개 코너에서 floodfill 로 자동 투명화 → 오브젝트 안쪽 흰색은 유지
- 투명 처리된 이미지의 dominant color → HSL L 0.87~0.93 clamp → 프레임 배경 파스텔로 자동 세팅

**폴백 흐름**
- 매칭 결과 0개 → 로그에 `PLATFORM-8 매칭 없음` 표시 후 조용히 AI 생성으로 진행
- 픽커에서 `[AI 로 새로 생성]` → 기존 AI 생성 흐름으로
- 픽커에서 `[취소]` → 이미지 생성 자체를 중단
- 네트워크/서버 이슈 (helper 가 `10.10.224.110:3000` 접근 실패) → 로그 경고 후 AI 폴백

**Helper 엔드포인트**
- `GET /promo-images/search?q=...&view=any|2d|3d&limit=60` — 매칭 결과 JSON. 원본 응답을 30초 in-memory TTL 캐시.
- `GET /promo-images/thumbnail?u=...` — raw 이미지 스트림. `<img src>` 용 (mixed-content 우회, 5분 캐시).
- `GET /promo-images/download?u=...&transparent=true` — base64 JSON. Figma fill 용. 투명 처리 + dominant color 반환.

### B-1.6. 소통참여 실사 이미지 생성

앱/이벤트의 **소통참여 배너 (984×552 상단 이미지)** 용 실사 사진을 생성하는 전용 모드. 팝업/배너와 달리 텍스트 placeholder 매핑이 없고 **프레임 자체가 이미지 대상** — 생성된 실사 사진이 프레임 fill 로 바로 깔림.

**프레임명 규칙**

```
MMDD_image_소통참여_{주제}_top_984x552
```

예: `0702_image_소통참여_카페에서_대화하는_두_사람_top_984x552`

- `MMDD`: 4자리 날짜
- `image`, `소통참여`, `top`: 고정 토큰
- `{주제}`: 이미지의 주제 (공백은 `_` 로 치환). 파일명 중간에 `_` 여러 개 있어도 OK — 도구가 앞 3개 · 뒤 2개 토큰을 제외한 나머지를 모두 주제로 인식
- 사이즈는 `984x552` 로 고정

**두 가지 사용 모드**

Plugin 상단 탭에서 **[적용]** → 하단 sub-tab **[소통참여]** 로 이동.

**(Mode A) 이미 만들어진 프레임에 이미지 생성**
1. Figma 캔버스에서 규칙에 맞는 프레임 1개 선택
2. Plugin sub-tab 의 `선택된 프레임에서 감지된 주제` 칸에 파일명에서 뽑아낸 주제가 자동 표시됨
3. **[선택 프레임에 이미지 생성]** 클릭

**(Mode B) 주제로 새 프레임 만들기 + 이미지 생성**
1. sub-tab 하단 `주제로 새 프레임 만들기` 칸에 한국어로 주제 입력 (예: `카페에서 대화하는 두 사람`)
2. **[새 프레임 + 이미지 생성 (984x552)]** 클릭
3. 현재 viewport 중앙 (또는 선택된 프레임 아래) 에 규칙에 맞는 이름의 새 프레임이 자동 생성되고 이미지 생성이 이어짐

**공통 동작**
- 스타일 dropdown / 힌트와 무관하게 **실사 사진 고정** (Photorealistic studio photograph 프롬프트 템플릿)
- helper 가 주제를 GPT-4o-mini 로 정제 후 gpt-image-1 호출
- 미리보기 → 적용 / 재생성 / 취소 흐름은 B-1.5 와 동일. 재생성 코멘트로 "야외로", "더 밝은 톤" 같은 피드백 반영 가능
- 팝업/배너와 달리 배경 파스텔 자동 적용은 없음 — 실사 사진이 프레임 전체를 덮음

### B-2. 시안 작업 + Way 업로드

1. 시안 페이지로 이동 → **올릴 프레임들 선택** (배너 + 팝업 + 랜딩 등)
2. Plugin 의 이슈 키 입력
3. **"선택 프레임 추출 → Way 업로드"** 클릭

자동:
- 프레임 → PNG 추출
- 랜딩 자동 분할 (자세히는 아래 "랜딩 분할 동작")
- UTF-8 zip 패키징 (Mac/Win 한글 안 깨짐)
- Way 이슈에 zip 첨부
- 자동 댓글 등록 (reporter 멘션 + 개수 + zip 다운로드 링크 포함)

처음엔 **"zip 만 만들기 (검수용)"** 으로 zip 내용 확인 후 본 업로드 권장.

---

## frame 이름 규칙 (반드시 지켜야 자동 인식)

| 타입 | 형식 | 예시 |
|---|---|---|
| 배너 | `MMDD_banner_{프로모션명}_{w}x{h}` | `0518_banner_summersale_984x264` |
| 팝업 | `MMDD_popup_{프로모션명}_{w}x{h}` | `0518_popup_summersale_960x1140` |
| 랜딩 | `MMDD_landing_{프로모션명}_{w}` | `0518_landing_summersale_1080` |
| 소통참여 | `MMDD_image_소통참여_{주제}_top_984x552` | `0518_image_소통참여_카페에서_대화하는_두_사람_top_984x552` |

- 날짜 **MMDD 4자리** (5월 18일 → `0518`)
- 타입 **소문자** `banner` / `popup` / `landing`
- 프로모션명 안에 밑줄 가능 (`summer_big_sale`)
- 사이즈는 맨 뒤. 배너/팝업은 `WxH`, 랜딩은 width 만

---

## 랜딩 분할 동작

랜딩 frame 처리 시 도구가 자동으로:

### 1) 자식 frame 이 있는 경우 (디자이너가 분할해둠)

자식 frame 을 Y좌표 순으로 인식해서 각각 export. `_skip` 접미사로 끝나는 자식은 분할 대상에서 제외.

### 2) 자식 frame 이 없는 경우 (평평한 디자인)

자동으로 콘텐츠 사이 빈 공간을 감지해서 분할.

### 3) 분할 결과 PNG 가 3000px 초과 시 추가 균등 분할

자식 한 장이 3000px 초과 → 자동 N등분. 분할점은 **글자가 안 잘리는 위치**로 ±200px 안에서 단색 가로줄을 찾아 자동 이동.

### 4) 폴더 정리 + 글로벌 카운트

zip 안의 랜딩 관련 파일은 한 폴더로 정리, Y좌표 순으로 `img_01`, `img_02`, ... 글로벌 카운트:

```
0515_landing_경기김포인센티브_수정2_1080/
  ├─ 0515_landing_경기김포인센티브_수정2_1080.png   ← 메인 (한 장 전체)
  ├─ img_01.png                                      ← Y좌표 순 1번째
  ├─ img_02.png                                      ← 2번째
  └─ img_03.png                                      ← 3번째
0515_banner_경기인센티브혜택_984x264.png             ← 배너 (zip 루트, 분할 대상 아님)
```

자식 한 장이 분할됐을 때는 그 자리에 펼쳐지면서 뒤 자식들은 자동으로 번호 밀림.

---

## 결과 — Way 댓글 형태

```
[~사번] 매니저님, 배너1개, 팝업1개, 랜딩페이지1개 전달드립니다.

[^0518_summersale.zip]
```

- 개수 0 인 타입은 자동 제외 (배너만 있으면 `배너2개 전달드립니다.`)
- `[^...]` 부분은 Way 에서 자동으로 첨부 다운로드 링크로 렌더링

---

## zip 로컬 보관 위치

```
~/.promo-automation/output/
```

Finder 에서 `Cmd + Shift + G` → 위 경로. macOS TCC 정책으로 launchd 가 `~/Desktop` 에 직접 못 써서 이 위치로 폴백.

Desktop 으로 복사:
```bash
cp ~/.promo-automation/output/0518_*.zip ~/Desktop/
```

---

## 수정본 자동 인식

같은 이슈에 같은 프로모션 zip 다시 올리면 `_수정` 자동 채번:

- 첫 업로드: `0518_summersale.zip`
- 같은 날 수정: `0518_summersale_수정.zip`
- 또 수정: `0518_summersale_수정2.zip`
- 다른 날 새 작업: `0519_summersale.zip` (수정 아닌 새 zip)

도구가 Way 이슈의 기존 첨부 파일명을 보고 알아서 결정. 댓글도 "수정사항 반영하여 ..." 템플릿으로 자동 전환.

---

## 자주 묻는 질문

### Q. 매번 로그인해야 하나요?
아니요. config.json 의 자격증명을 Helper 가 메모리에서 자동 사용. 디자이너 입력은 Way 이슈 키 하나만.

### Q. Plugin UI 에 "Helper 연결 실패"
```bash
launchctl unload ~/Library/LaunchAgents/com.konai.promo-automation.plist
launchctl load ~/Library/LaunchAgents/com.konai.promo-automation.plist
sleep 2
curl -s http://127.0.0.1:7000/health
```

### Q. "Way 오류 401"
config 의 username/password 확인. username 은 영문 ID (사번 숫자 X).

### Q. 비번 바꿨어요
```bash
nano ~/.promo-export/config.json
# 비번 수정 후 저장
launchctl unload ~/Library/LaunchAgents/com.konai.promo-automation.plist
launchctl load ~/Library/LaunchAgents/com.konai.promo-automation.plist
```

### Q. 다른 달 작업으로 넘어갔어요
config 의 `default_file_key` 를 새 마스터 파일 키로 갱신 후 Helper 재시작.

### Q. Helper 코드를 수정했는데 안 반영돼요
helper 가 옛 코드 (옛 install 의 hidden 폴더 main.py 또는 옛 .pyc cache) 를 붙잡고 있을 수 있어요. 다음 순서로 강제 재시작:
```bash
# .pyc cache 삭제
find ~/.promo-automation -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null
find ~/.promo-automation -name '*.pyc' -delete 2>/dev/null
# 재시작
launchctl unload ~/Library/LaunchAgents/com.konai.promo-automation.plist
launchctl load ~/Library/LaunchAgents/com.konai.promo-automation.plist
sleep 2 && curl -s http://127.0.0.1:7000/health
```
그래도 안 되면 `bash install.sh` 한 번 다시 실행. plist 가 새 코드 위치로 갱신됩니다 (venv 재사용).

### Q. helper 코드 위치가 어디인가요?
v3.7 부터:
- **실제 코드**: `~/.promo-automation/helper-src/` (launchd 가 접근 가능한 위치)
- **편의 symlink**: `~/Documents/promo-automation/helper/` → `~/.promo-automation/helper-src/`
  (Finder/VS Code 에서는 같은 위치로 보임. 어느 쪽에서 수정해도 같은 실체)

확인:
```bash
ls -la ~/Documents/promo-automation/helper
# helper -> /Users/.../.promo-automation/helper-src 라고 나오면 정상
```

### Q. 새 zip 받았을 때 어떻게 풀어야 하나요?
**helper 디렉토리는 symlink** 이므로 그냥 unzip 하면 symlink 가 깨질 수 있어요. helper 디렉토리만 따로 처리:

```bash
# 1. figma-plugin + 사용방법.md 는 그대로 unzip
cd ~/Documents
unzip -o ~/Downloads/promo-automation-vX.X.zip \
  'promo-automation/figma-plugin/*' \
  'promo-automation/사용방법.md'

# 2. helper 는 실제 위치 (helper-src) 에 풀기
rm -rf /tmp/extract
unzip -o ~/Downloads/promo-automation-vX.X.zip 'promo-automation/helper/*' -d /tmp/extract
rsync -av --delete \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='.venv' --exclude='venv' \
  /tmp/extract/promo-automation/helper/ ~/.promo-automation/helper-src/
rm -rf /tmp/extract

# 3. helper 재시작
launchctl unload ~/Library/LaunchAgents/com.konai.promo-automation.plist
launchctl load ~/Library/LaunchAgents/com.konai.promo-automation.plist
```

Plugin 코드 (figma-plugin) 는 Figma 가 직접 disk 에서 읽으니 Figma plugin reload 만 하면 끝.

### Q. PPT 슬라이드의 한글 텍스트가 깨짐
LibreOffice 폰트 cache 가 안 빌드된 상태. LibreOffice 를 한 번 GUI 로 실행하면 해결. (Finder → 응용 프로그램 → LibreOffice 더블클릭 → 창 뜨면 닫기)

### Q. work 컴포넌트가 안 보여요
작업 파일에 `[LOCAL] Common` 라이브러리의 work 컴포넌트를 한 번 끌어다 두기. 그 다음부터는 자동.

### Q. PPT 슬라이드 텍스트 추출 순서가 이상해요
도구는 슬라이드를 가로 중앙 기준 좌/우 column 으로 나눠 각 column 을 위→아래로 추출합니다. 3열 이상의 복잡한 레이아웃이면 빗나갈 수 있어요. 그 경우 알려주시면 알고리즘 조정 가능.


### Q. "이름 규칙 불일치" 경고
선택한 프레임 중 일부가 frame 이름 규칙을 안 따르는 거. 해당 프레임은 자동 skip 되고 나머지는 정상 진행.

### Q. 분할 단위가 너무 크거나 너무 작아요
`~/Documents/promo-automation/helper/main.py` 의 `MAX_PNG_HEIGHT = 3000` 값 조정 가능. 2000 → 작게, 5000 → 크게.

### Q. SSO 환경에서 인증 실패
회사 Way 가 SSO 만 받는 환경이면 비번 인증이 막혀서 동작 안 함. 관리자에게 문의.

### Q. AI 이미지 생성 시 "openai_api_key 가 config 에 없습니다" 503
`~/.promo-export/config.json` 에 `"openai_api_key": "sk-..."` 추가하거나 `helper/.env` 에 `OPENAI_API_KEY=sk-...` 한 줄 넣고 helper 재시작:
```bash
launchctl unload ~/Library/LaunchAgents/com.konai.promo-automation.plist
launchctl load ~/Library/LaunchAgents/com.konai.promo-automation.plist
sleep 2
curl -s http://127.0.0.1:7000/health | python3 -m json.tool
```
응답에 `"openai_loaded": true` 보이면 OK.

### Q. AI 이미지 생성 시 "이미지 자리를 찾지 못했습니다"
컴포넌트 안에 이미지 들어갈 RECTANGLE 또는 FRAME 이 있어야 함. 둘 중 하나만 만족하면 자동 인식:
- 노드 이름에 `img` / `image` / `이미지` / `사진` / `photo` 중 하나 포함
- 또는 이미 IMAGE 타입 fill 깔려 있음 (회색 단색 fill 은 인식 안 됨)

라이브러리 컴포넌트 수정 후 publish → 작업 파일에서 컴포넌트 Update 만 받으면 됨. plugin 재등록은 불필요.

### Q. AI 이미지가 마음에 안 들어요
미리보기 박스의 **재생성 코멘트** textarea 에 무엇을 바꾸고 싶은지 적고 **[재생성]** 누르면 그 피드백이 다음 개체명 추출과 프롬프트에 자동 반영. 예:
- `더 귀여운 캐릭터로`, `분홍색 톤으로`, `카드 말고 선물상자로`, `더 단순하게`
- 또는 스타일 dropdown 을 3D → 2D 로 바꾸고 재생성
- 코멘트 비워두고 재생성하면 같은 설정으로 랜덤 재시도 (gpt-image-1 은 매번 다른 결과)

### Q. 지역 이름이 일반 명사로 잘못 그려져요 (예: 양산을 우산으로)
한국 도시명 중 동음이의어가 있는 곳들은 GPT 가 일반 명사로 오역할 수 있어요. helper 에 28개 도시가 사전 등록돼 있고 (`양산`→Yangsan city NOT parasol, `경주`→Gyeongju city NOT race 등) 매치되면 자동으로 영문 음역 + 부정문 어노테이션을 주입합니다.

새 도시가 누락된 경우 `helper/main.py` 의 `KOREAN_PLACE_NAMES` dict 에 한 줄 추가하고 helper 재시작:
```python
KOREAN_PLACE_NAMES = {
    ...
    "신규도시": "Singyu city in South Korea (NOT the Korean word for '...')",  # 동음이의어 있으면 부연
}
```

### Q. AI 이미지에 글자가 너무 작게/안 들어가요
**금액·% 숫자 강조** 체크박스 (배너/팝업 sub-tab 안, 힌트 입력 바로 아래) 켜고 재생성. 텍스트에 `20,000원` / `5%` 같은 패턴이 있을 때만 동작 — 그 숫자를 캔버스 대부분 차지하도록 크게 그립니다. 일반 텍스트는 강조 안 함.

### Q. 생성된 이미지 배경이 투명이 아니에요
이미 helper 에서 `background="transparent"` 옵션으로 호출하고 있어요. Figma 에서 fill 로 들어갈 때 자동으로 알파 채널 처리됨. 만약 회색 배경이 보인다면 컴포넌트의 이미지 대상 RECTANGLE 뒤에 다른 fill 노드가 가려져 있거나 scaleMode 이슈일 수 있음 — 해당 노드 선택 후 Figma 우측 패널에서 fill 직접 확인.

### Q. OpenAI 사용 비용이 걱정돼요
- gpt-image-1: 1024×1024 한 장당 약 $0.04 (1024×1536 / 1536×1024 도 비슷)
- gpt-4o-mini (프롬프트 추출용): 한 호출당 100 토큰 미만 → 거의 무시 가능 ($0.001 미만)
- 재생성마다 새로 호출되므로 미리보기에서 OK 인 시점에만 [적용] 권장
- OpenAI 콘솔 https://platform.openai.com/usage 에서 일별 비용 모니터링 가능

---

## 도움 요청 시 알려주실 것

1. 어느 단계에서 막혔는지
2. 터미널 에러 메시지 / Plugin UI 로그 스크린샷
3. Helper 로그:
   ```bash
   tail -30 ~/.promo-automation/helper.err.log
   tail -30 ~/.promo-automation/helper.log
   ```
