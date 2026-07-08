# 프로모션 자동화 — 사용 가이드

Figma 시안 작업부터 Way(Jira) 이슈 첨부 + 댓글 등록까지 한 흐름으로 처리하는 사내 Figma 플러그인. 사업부 PPT 자동 가져오기, 팝업/배너 컴포넌트 자동 적용, 이미지 자동 삽입(사내 라이브러리 우선 → AI 생성 폴백), 소통참여 실사 이미지까지 지원.

- 저장소: https://github.com/waterb1024/promo_automation
- 현재 버전: **v4.1**

---

## 목차

1. [주요 기능](#주요-기능)
2. [최근 업데이트 (v4.1)](#최근-업데이트-v41)
3. [사전 준비물](#사전-준비물)
4. [설치](#설치-약-10분)
5. [사용 흐름](#사용-흐름)
6. [프레임 이름 규칙](#프레임-이름-규칙)
7. [랜딩 분할 동작](#랜딩-분할-동작)
8. [결과 — Way 댓글 형태](#결과--way-댓글-형태)
9. [zip 로컬 보관 위치](#zip-로컬-보관-위치)
10. [수정본 자동 인식](#수정본-자동-인식)
11. [자주 묻는 질문](#자주-묻는-질문)

---

## 주요 기능

- **Way(Jira) 이슈 연동** — 이슈 키 입력 또는 `[내 이슈 ▾]` 드롭다운에서 본인 assignee 이슈 선택 → PPT 첨부 자동 가져오기 + LibreOffice/poppler 로 슬라이드 PNG + 텍스트 추출 → Figma 캔버스 자동 배치
- **팝업/배너 컴포넌트 자동 적용** — PPT 영역 sub-frame 또는 텍스트 다중 선택 → 등록된 팝업 종류(홈팝업/진입팝업/등) 로 자동 인스턴스 생성 + placeholder 채움. 텍스트 개수에 따라 자동 매핑 (마지막 텍스트는 마지막 placeholder 우선)
- **이미지 자동 삽입** — `[적용 + 이미지 생성]` 한 번에:
  1. 사내 이미지 라이브러리 (PLATFORM-8) 먼저 매칭 → 있으면 인라인 픽커에서 썸네일 클릭으로 즉시 적용
  2. 없으면 GPT-4o-mini 로 한국어 문구에서 영어 개체명 추출 → gpt-image-1 으로 투명 배경 PNG 생성
  3. 흰 배경 자동 투명화 + dominant color 파스텔로 프레임 배경 자동 세팅
- **소통참여 실사 이미지 생성** — `MMDD_image_소통참여_{주제}_top_984x552` 프레임에 실사 사진 자동 fill (프레임 선택 or 주제 입력으로 새 프레임 생성)
- **부가서비스 이미지 세트** — 지자체별 홈 상단/중단, 생활편의 상단/하단, 지원금혜택 하단, 소통참여 하단 프레임 + 3D 아이콘화까지 하나의 서브탭에서 생성. 기획 셀 선택 → 코드 빌더가 새 템플릿 그림 + 텍스트·이미지·버튼색·배경 자동 반영. 여러 프레임 multi-select 시 크기로 위치 자동 판별 (일괄 적용). 상세: [`docs/addon-service.md`](docs/addon-service.md)
- **일괄 처리** — 프레임 여러 개 multi-select 후 이미지 생성 트리거 → 순차 실행 (미리보기 자동 스킵)
- **재생성 코멘트** — 미리보기 박스에 "분홍색 톤으로" 같은 피드백 적으면 GPT 가 반영해 재생성
- **한국 지역명 자동 인식** (28개 도시) — `양산`(parasol), `경주`(race), `영광`(glory) 같은 동음이의어 도시명을 GPT 가 오역하지 않게 어노테이션 자동 주입
- **금액·% 숫자 강조** — 텍스트의 `20,000원` / `5%` 같은 패턴 추출해 이미지에 크게 그림 (옵트인)
- **시안 추출 → Way 자동 업로드** — 프레임 다중 선택 → PNG 추출 + 랜딩 자동 분할 + UTF-8 zip → Way 이슈에 첨부 + reporter 멘션 댓글 자동 등록
- **수정본 자동 인식** — 같은 프로모션 재업로드 시 `_수정`, `_수정2` 자동 채번 + 수정 템플릿 댓글로 자동 전환

---

## 최근 업데이트 (v4.1)

- **`[내 이슈 ▾]` 드롭다운** — Way 이슈 키 input 옆 버튼 → 본인 assignee 미해결 이슈 최대 30개 (updated 최근순) 표시 → 클릭하면 이슈키 자동 입력
- **PLATFORM-8 사내 이미지 라이브러리 우선 매칭** — 팝업/배너 이미지 생성 시 AI 호출 전에 `http://10.10.224.110:3000/api/images` 조회 → 매칭 있으면 인라인 픽커에서 썸네일 클릭으로 즉시 적용 (AI 호출 안 함, 비용 절감)
  - **라이브러리 탭 항목만** (`favorite=true`) — `생성 피드` 는 자동 제외
  - 검색 키워드 = 프레임명의 promotion + 프레임 내 모든 텍스트 노드 자동 조합 (한글 NFC/NFD 정규화)
  - AI 스타일 dropdown (3D/2D/실사) 이 라이브러리 view 필터로 그대로 매핑
- **흰 배경 투명 처리 개선** — 8-seed floodfill (thresh=32) + anti-alias fringe alpha 감쇠 (soften=40) 로 halo 없이 부드러운 페더 edge
- **UI 폰트 Pretendard + 최소 12px** — 가독성 향상, 포인트 컬러 `#6172DD`, 타이틀 컬러 `#222222`

---

## 사전 준비물

- **macOS** (Windows 미지원)
- **Figma 데스크톱 앱** (웹 브라우저 X)
- **Python 3.9 이상** — 확인: `python3 --version`
- **Homebrew** — 확인: `brew --version`
- **Way 계정** (영문 ID + 비밀번호)
- **Pretendard 폰트** (사내 표준, 보통 설치돼 있음)
- **OpenAI API 키** *(선택)* — AI 이미지 생성 기능 쓸 경우. https://platform.openai.com/api-keys 에서 발급. `gpt-image-1` 사용 권한 + 결제수단 필요. 한 장당 약 $0.04. 라이브러리 매칭만 쓰거나 이미지 생성 안 쓰면 생략 가능
- **PLATFORM-8 접근** — 사내망 (`http://10.10.224.110:3000`) 접근 가능해야 라이브러리 매칭 기능 사용 가능

---

## 설치 (약 10분)

### Step 1. 코드 받기

`promo-automation` 폴더를 받아서 `~/Documents/` 안에 두기:

```
~/Documents/promo-automation/
├── figma-plugin/   ← Figma 가 사용 (이 위치 그대로 OK)
└── helper/         ← 백그라운드 서버 (install.sh 가 알아서 hidden 폴더로 옮김)
```

> **macOS TCC 경고**: helper 디렉토리는 `~/Documents` 안에 그대로 두면 launchd 가 접근 차단해서 helper 가 동작 안 합니다 (`Operation not permitted`). Step 4 의 `install.sh` 가 이 문제를 감지하고 자동으로 `~/.promo-automation/helper-src` 로 이동 + 원 위치에 symlink 를 생성합니다.

### Step 2. LibreOffice + Poppler 설치

```bash
brew install --cask libreoffice
brew install poppler
```

Gatekeeper 차단 풀기 (LibreOffice 만):
```bash
sudo xattr -rd com.apple.quarantine /Applications/LibreOffice.app
```

**중요**: LibreOffice 를 한 번 GUI 로 실행 (Finder → 응용 프로그램 → LibreOffice 더블클릭). 첫 실행으로 폰트 cache 가 빌드되어야 한글 텍스트 변환이 정상. 창이 뜨면 바로 닫아도 OK.

### Step 3. Way 인증 정보 작성

```bash
mkdir -p ~/.promo-export && chmod 700 ~/.promo-export
```

`~/.promo-export/config.json`:

```json
{
  "way_base_url":     "https://konaway.konai.com",
  "way_username":     "본인영문ID",
  "way_password":     "본인비밀번호",
  "default_file_key": "이번달 마스터 파일 fileKey",
  "openai_api_key":   "sk-..."
}
```

- `way_username` 은 **영문 ID** (예: `sb.shin14`). 사번 숫자 아님
- 매월 마스터 파일이 바뀌면 `default_file_key` 갱신
- `openai_api_key` 는 AI 이미지 생성 쓸 때만 필요. `helper/.env` 에 `OPENAI_API_KEY=sk-...` 한 줄로 넣어도 OK
- 팀 템플릿 공유 워크플로우 쓸 거면 `templates_sync_url` (+ private repo 면 `templates_sync_token`) 추가 (Step 7-보너스 참고)

권한 잠금:
```bash
chmod 600 ~/.promo-export/config.json
```

> 평문 비밀번호이므로 절대 git/슬랙에 공유 금지.

### Step 4. Helper 설치 (백그라운드 서버)

```bash
cd ~/Documents/promo-automation/helper
bash install.sh
```

자동으로:
- **TCC 감지** → `y` + Enter 로 `~/.promo-automation/helper-src/` 로 이동 + symlink 생성
- Python 가상환경 + 라이브러리 (FastAPI, Pillow, pdf2image, python-pptx 등) 설치
- macOS 로그인 시 자동 시작 등록 (launchd)
- `http://127.0.0.1:7000` 에서 백그라운드 상시 실행

`설치 완료` 메시지 + `코드 위치: /Users/.../.promo-automation/helper-src` 보이면 OK.

확인:
```bash
curl -s http://127.0.0.1:7000/health
```
`"config_loaded":true` 보이면 정상.

### Step 5. Figma Plugin 등록

1. Figma 데스크톱 앱 → **Plugins → Development → Import plugin from manifest...**
2. `~/Documents/promo-automation/figma-plugin/manifest.json` 선택
3. 등록되면 어느 파일에서든 **Plugins → Development → Promotion Automation** 으로 사용 가능

### Step 6. work 컴포넌트 배치

라이브러리 자동 import 는 Figma plugin 정적 검사가 막아서, **작업 파일에 work 컴포넌트 인스턴스를 한 번 끌어다 둡니다**:

1. Figma 좌측 **Assets** 탭
2. **Libraries** 에 `[LOCAL] Common` 활성화
3. 검색에 `work` → 컴포넌트 드래그해서 캔버스 어디든 한 번 두기

도구가 그 인스턴스의 main 을 찾아 새 인스턴스를 자동 생성합니다.

### Step 7. 팝업/배너 컴포넌트 등록 (종류마다 1회)

컴포넌트 안의 모든 TEXT 노드를 **위→아래 위치 순서** 로 정렬해서 매핑하므로, 자식 노드 이름과 무관하게 동작:

| 컴포넌트 종류 | placeholder 예시 (위→아래) |
|---|---|
| 팝업 | 상단 텍스트 / 메인텍스트 / 설명 / 설명 서브 / 버튼명 |
| 배너 | 서브텍스트 / 메인텍스트 |

**(1) 템플릿 파일에서 컴포넌트로 변환 + publish**

1. 템플릿 파일에서 frame 우클릭 → **컴포넌트로 만들기** (Cmd+Opt+K)
2. 좌측 **Assets** 탭 → **Libraries** → 해당 라이브러리 **Publish**
3. 작업 파일에 그 라이브러리 활성화

**(2) 작업 파일에서 plugin 에 등록 (종류마다 반복)**

1. 작업 파일 → Assets → 라이브러리에서 등록할 팝업 컴포넌트 한 번 드래그 (인스턴스 생성)
2. 그 인스턴스 선택 + Plugin **[(라이브러리 인스턴스 선택) 팝업 종류 등록]** 클릭
3. 로그에 `✓ 팝업 종류 등록 완료 (총 N종)` + 자식 TEXT 노드 이름들 + 매칭된 placeholder 표시
4. 다른 사이즈/종류 팝업도 같은 방식으로 누적 등록. Plugin UI 의 dropdown 에 자동 반영

**잘못 등록된 경우**: dropdown 에서 해당 종류 선택 + **[(선택된 종류) 등록 삭제]** — 컴포넌트 자체는 안 지워지고 plugin 의 등록 정보만 제거.

### Step 7-보너스. 템플릿 설정 팀 공유 (선택)

한 명이 등록한 팝업/배너/상세 템플릿 묶음을 팀에서 공유:

**방식 1 — 수동**

1. plugin → **설정 백업** → **[↑ 내보내기]** → JSON 다운로드
2. 사내 공유폴더/슬랙으로 전달
3. 다른 사람은 같은 영역 → **[↓ 가져오기]** → JSON 선택

**방식 2 — 원격 자동 동기화 (권장)**

1. 위에서 받은 JSON 을 팀 git repo 에 `templates.json` 으로 commit/push
2. 각자 `~/.promo-export/config.json` 에 추가:
   ```json
   {
     "templates_sync_url":   "https://raw.githubusercontent.com/<org>/<repo>/<branch>/templates.json",
     "templates_sync_token": "ghp_..."
   }
   ```
   public repo/gist 면 `templates_sync_token` 생략 가능. private 이면 GitHub PAT (repo read 권한) 필요
3. Helper 재시작: `launchctl kickstart -k gui/$(id -u)/com.konai.promo-automation`
4. Plugin → **설정 백업** → **[⟳ 원격 설정 동기화]** 클릭

동기화는 버튼을 직접 누를 때만 실행되어 의도치 않은 덮어쓰기를 막습니다.

---

## 사용 흐름

### A. 사업부 이슈에서 작업 시작

1. Figma 데스크톱에서 작업 파일 열기
2. Plugin 실행 → 상단 **Way 이슈 키** 입력 (예: `KONASALES-72525`)
   - **또는** `[내 이슈 ▾]` 클릭 → 본인 assignee 미해결 이슈 최대 30개 (updated 최근순) 목록에서 선택
3. **[이슈 PPT 슬라이드 가져오기]** 클릭

자동으로:
- Helper 가 Way 에서 PPT 다운로드
- LibreOffice 로 PPT → PDF, poppler 로 PDF → 슬라이드별 PNG
- python-pptx 로 슬라이드별 텍스트 추출 (좌→우, 위→아래 순서)
- Figma 캔버스 빈 공간에 상단 라벨 (`{MMDD}_{이슈키}_{이슈명}`) + work 컴포넌트 + 슬라이드 PNG/텍스트 자동 배치

### B. 팝업/배너 자동 적용

PPT slide 의 mockup 이 팝업/배너면 다음 두 방법 중 하나로:

**방법 1** — 영역 sub-frame 1개 선택 (자동 영역 인식이 정확할 때)
**방법 2 (권장)** — 팝업에 들어갈 텍스트 노드들을 Shift+클릭 다중 선택

이후:
1. 적용 탭 → 팝업(또는 배너) sub-tab
2. **팝업 종류** dropdown 선택 (홈팝업 / 진입팝업 / …)
3. **[팝업 적용]** 또는 **[적용 + 이미지 생성]**

**텍스트 개수별 자동 매핑:**

| 텍스트 수 | 매핑 |
|---|---|
| 1개 | 메인 |
| 2개 | 메인 / 버튼 |
| 3개 | 상단 / 메인 / 버튼 |
| 4개 | 상단 / 메인 / 설명 / 버튼 |
| 5개 | 상단 / 메인 / 설명 / 설명 서브 / 버튼 |
| 6개 이상 | 처음 5개만 매핑, 나머지 무시 |

핵심 규칙: **"마지막 텍스트는 마지막 placeholder"** — 팝업의 버튼 자리 / 배너의 메인 강조 자리에 자동 매핑

**자동 제외 텍스트**: `img` / `IMG` / `image` / `이미지` / `사진` / `photo` (대소문자 무관), `(쿠폰 이미지)` 같은 괄호 안 이미지 설명, 1~2자 자투리 영문

### C. 이미지 자동 삽입

`[적용 + 이미지 생성]` 한 번 누르면 아래 순서로 진행:

**1) PLATFORM-8 사내 라이브러리 매칭 시도**

- **검색 키워드** = 프레임명의 `{promotion}` + 프레임 내 모든 텍스트 노드 (자동 조합, 한글 NFC/NFD 정규화)
  - 예: `0703_banner_전통시장_984x264` + 텍스트 "최대 10,000원 혜택" → `전통시장 최대 10,000원 혜택`
- **라이브러리 탭 항목만** 후보 (사이트의 `favorite=true`, `생성 피드` 는 제외)
- **AI 스타일 dropdown 이 view 필터로 매핑**:
  - 3D 일러스트 → 라이브러리 3D 만
  - 2D 일러스트 → 라이브러리 2D 만 (SVG 자동 제외 — Figma image fill 은 raster 만)
  - 실사 사진 → 전체 (라이브러리에 실사 없어서 결국 AI 폴백)
- 매칭 결과가 있으면 팝업/배너 sub-tab 안에 **인라인 픽커** 노출 → 썸네일 한 번 클릭으로 즉시 적용
- 픽커 안 상단 필터(전체/3D/2D) 로 재조정, 검색어 편집 후 재검색 가능
- `[취소]` — 이미지 생성 중단, `[AI 로 새로 생성]` — 아래 AI 흐름으로

**2) AI 이미지 생성 (라이브러리 매칭 없거나 폴백 시)**

**선행 조건**
- 컴포넌트 안에 이미지 자리 RECTANGLE 또는 FRAME. 이름에 `img` / `image` / `이미지` / `사진` / `photo` 포함 or 이미 IMAGE 타입 fill. 후보 여러 개면 면적 큰 노드 선택
- `openai_api_key` 설정돼 있어야 함

**옵션**
- **AI 이미지 스타일** — 3D 일러스트 (기본) / 실사 사진 / 2D 일러스트
- **금액·% 숫자 강조** — 텍스트의 `20,000원` / `5%` 패턴을 이미지에 크게 그리게 강제 (옵트인)
- **미리보기 없이 바로 적용** — 확인 스킵, 즉시 프레임 fill (일괄 모드에선 자동 활성)

**흐름**
1. GPT-4o-mini 가 한국어 문구에서 영어 개체명 추출 (예: "여름 카드 할인 쿠폰 이벤트" → `a summer discount coupon`)
2. 스타일별 고정 템플릿에 개체명 삽입 → gpt-image-1 이 투명 배경 PNG 생성 (약 20~30초)
3. 미리보기 → **[적용]** / **[재생성]** / **[취소]**
4. 재생성 시 미리보기 박스의 textarea 에 "분홍색 톤으로", "카드 말고 선물상자로" 같은 피드백 입력 (GPT 가 반영)

**자동 후처리 (라이브러리/AI 공통)**
- **흰 배경 자동 투명화** — 코너 4개 + 변 중앙 4개 = 8-seed floodfill (thresh=32) + anti-alias fringe alpha 감쇠 (soften=40) → halo 없이 부드러운 페더 edge
- **프레임 배경 파스텔 자동 적용** — 투명 처리된 이미지의 dominant color → HSL Lightness 0.87~0.93 clamp

**비용** — gpt-image-1 1024×1024 한 장당 약 $0.04. 재생성마다 새로 호출되므로 적절히 사용.

### D. 소통참여 실사 이미지 생성

**프레임명 규칙**: `MMDD_image_소통참여_{주제}_top_984x552`  
예: `0702_image_소통참여_카페에서_대화하는_두_사람_top_984x552`

Plugin 상단 탭 → **[적용]** → sub-tab **[소통참여]**.

**Mode A — 기존 프레임에 이미지 생성**
1. 규칙에 맞는 프레임 1개 선택
2. `선택된 프레임에서 감지된 주제` 칸에 파일명에서 뽑은 주제 자동 표시
3. **[선택 프레임에 이미지 생성]** 클릭

**Mode B — 주제로 새 프레임 만들기 + 이미지 생성**
1. `주제로 새 프레임 만들기` 칸에 한국어 주제 입력
2. **[새 프레임 + 이미지 생성 (984x552)]** 클릭 → 새 프레임 자동 생성 + 이미지 생성 이어감

- 스타일과 무관하게 **실사 사진 고정** (Photorealistic studio photograph 프롬프트)
- 프레임 자체가 이미지 대상 (팝업/배너와 달리 배경 파스텔 없음)
- 미리보기 / 재생성 / 취소 흐름은 팝업/배너 이미지 생성과 동일
- PLATFORM-8 라이브러리 매칭 대상 아님 (실사 사진 목적)

### E. 부가서비스 이미지 생성

Plugin 상단 탭 → **[적용]** → sub-tab **[부가서비스]**.

지자체별 부가서비스 이미지 세트를 하나의 서브탭에서 생성. 서비스명은 지자체마다 달라 프레임 텍스트에서 자동 추출하거나 사용자가 수정.

**위치 (프레임 크기)**
- 홈 상단 (1080×528)
- 홈 중단 (360×378)
- 생활편의 상단 (984×840)
- 생활편의 하단 (1080×가변)
- 지원금혜택 하단 (984×264)
- 소통참여 하단 (480×348)
- 3D 아이콘화 (48×48) — 2D 아이콘을 3D matte plastic 렌더로 재변환

**Mode 1 — 기획 셀에서 새 템플릿 자동 생성 (권장)**
1. 기획 파일의 스펙 셀 프레임 선택 (크기 자유)
2. 위치 선택 → **[적용 + 이미지 생성]**
3. 우측에 코드 빌더가 새 템플릿을 그리고 → 원 프레임의 텍스트 자동 채움 → 이미지 생성 + 배경/버튼 파스텔 자동 반영 + 프레임명 hex suffix 자동

**Mode 2 — 기존 결과물 재생성**
1. `image_홈_{서비스명}_top_1080x528_#hex` 같은 기존 프레임 선택
2. 같은 흐름 → 이미지·프레임 배경·버튼 그라데이션·프레임명(hex) 만 갱신

**옵션**
- **프롬프트 코멘트** — "더 밝은 톤으로", "카드 요소 추가" 같은 자유 힌트 (선택)
- **미리보기 없이 바로 적용** — 확인 스킵 (일괄 모드에선 자동 활성)

**Mode 3 — 일괄 적용 (별도 카드)**
1. 여러 프레임 multi-select
2. 카드 하단 **[일괄 적용 실행]** 클릭
3. 각 프레임의 width/height 로 위치를 자동 판별해 순차 실행
   - 이미 완성된 결과물(`image_홈_..._top_`, `image_지원금혜택_..._bottom_` 등) → "이미 생성된 템플릿" 사유로 스킵
   - 크기 시그니처 매칭 실패 → "크기 매칭 실패" 사유로 스킵
4. 진행 중에는 버튼이 `일괄 적용 진행 중…` 으로 바뀌고 비활성화, 카드 하단 status box 에 `일괄 3/7 · 홈 상단`, 현재 프레임명, 경과 시간, 진행 바 표시

**Mode 4 — 3D 아이콘화**
1. 위치 = `3D 아이콘화` 선택 → 2D 아이콘 프레임 1개 선택
2. **[선택 프레임 3D 재변환]** 클릭
3. gpt-image-1 (`images.edit`) 이 실루엣·주제를 유지한 채 3D matte plastic 스타일로 재해석 → 같은 프레임 fill 로 적용

**PLATFORM-8 매칭**: 부가서비스도 사내 이미지 라이브러리 우선 조회 대상 (3D 아이콘화는 제외). AI 호출 전에 라이브러리에서 매칭되면 인라인 픽커에서 썸네일 클릭 즉시 적용.

상세는 [`docs/addon-service.md`](docs/addon-service.md) 참고.

### F. 시안 작업 + Way 업로드

1. 시안 페이지로 이동 → 올릴 프레임들 선택 (배너 + 팝업 + 랜딩 등)
2. Plugin 의 이슈 키 확인
3. **[선택 프레임 추출 → Way 업로드]** 클릭

자동으로:
- 프레임 → PNG 추출
- 랜딩 자동 분할 (아래 "랜딩 분할 동작" 참고)
- UTF-8 zip 패키징 (Mac/Win 한글 안 깨짐)
- Way 이슈에 zip 첨부
- 자동 댓글 등록 (reporter 멘션 + 개수 + 다운로드 링크)

처음엔 **[zip 만 만들기 (검수용)]** 로 zip 내용 확인 후 본 업로드 권장.

---

## 프레임 이름 규칙

밑줄 `_` 로 구분:

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

랜딩 프레임 처리 시 도구가 자동으로:

**1) 자식 프레임이 있는 경우 (디자이너가 분할해둠)**  
자식 프레임을 Y좌표 순으로 인식해서 각각 export. `_skip` 접미사로 끝나는 자식은 제외.

**2) 자식 프레임이 없는 경우 (평평한 디자인)**  
자동으로 콘텐츠 사이 빈 공간을 감지해서 분할.

**3) 분할 결과 PNG 가 3000px 초과 시 추가 균등 분할**  
자식 한 장이 3000px 초과 → 자동 N등분. 분할점은 **글자가 안 잘리는 위치**로 ±200px 안에서 단색 가로줄을 찾아 자동 이동.

**4) 폴더 정리 + 글로벌 카운트**  
zip 안의 랜딩 관련 파일은 한 폴더로 정리, Y좌표 순으로 `img_01`, `img_02`, … 글로벌 카운트:

```
0515_landing_경기김포인센티브_수정2_1080/
  ├─ 0515_landing_경기김포인센티브_수정2_1080.png   ← 메인 (한 장 전체)
  ├─ img_01.png                                      ← Y좌표 순 1번째
  ├─ img_02.png                                      ← 2번째
  └─ img_03.png                                      ← 3번째
0515_banner_경기인센티브혜택_984x264.png             ← 배너 (zip 루트, 분할 대상 아님)
```

자식 한 장이 분할됐을 때는 그 자리에 펼쳐지면서 뒤 자식들은 자동으로 번호가 밀립니다.

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

도구가 Way 이슈의 기존 첨부 파일명을 보고 알아서 결정. 댓글도 "수정사항 반영하여 …" 템플릿으로 자동 전환.

---

## 자주 묻는 질문

### Q. 매번 로그인해야 하나요?
아니요. `config.json` 의 자격증명을 Helper 가 메모리에서 자동 사용. 디자이너 입력은 Way 이슈 키 하나만.

### Q. Plugin UI 에 "Helper 연결 실패"
```bash
launchctl kickstart -k gui/$(id -u)/com.konai.promo-automation
sleep 2 && curl -s http://127.0.0.1:7000/health
```

### Q. "Way 오류 401"
`config` 의 username/password 확인. `way_username` 은 영문 ID (사번 숫자 X).

### Q. 비번 바꿨어요
```bash
nano ~/.promo-export/config.json
# 저장 후 helper 재시작
launchctl kickstart -k gui/$(id -u)/com.konai.promo-automation
```

### Q. 다른 달 작업으로 넘어갔어요
`config` 의 `default_file_key` 를 새 마스터 파일 키로 갱신 후 helper 재시작.

### Q. Helper 코드를 수정했는데 반영이 안 돼요
launchctl 로 helper 강제 재시작:
```bash
# .pyc cache 삭제 (필요 시)
find ~/.promo-automation -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null
find ~/.promo-automation -name '*.pyc' -delete 2>/dev/null
# 재시작
launchctl kickstart -k gui/$(id -u)/com.konai.promo-automation
sleep 2 && curl -s http://127.0.0.1:7000/health
```
그래도 안 되면 `bash install.sh` 재실행 (plist 가 새 코드 위치로 갱신, venv 재사용).

### Q. Helper 코드 위치가 어디인가요?
- **실제 코드**: `~/.promo-automation/helper-src/` (launchd 가 접근 가능한 위치)
- **편의 symlink**: `~/Documents/promo-automation/helper/` → `~/.promo-automation/helper-src/` (Finder/VS Code 에서는 같은 위치로 보임)

확인:
```bash
ls -la ~/Documents/promo-automation/helper
# helper -> /Users/.../.promo-automation/helper-src 라고 나오면 정상
```

### Q. 새 zip 받았을 때 어떻게 풀어야 하나요?
`helper` 디렉토리는 symlink 이므로 그냥 unzip 하면 symlink 가 깨질 수 있어요:

```bash
# 1. figma-plugin 은 그대로 unzip
cd ~/Documents
unzip -o ~/Downloads/promo-automation-vX.X.zip 'promo-automation/figma-plugin/*'

# 2. helper 는 실제 위치(helper-src)에 풀기
rm -rf /tmp/extract
unzip -o ~/Downloads/promo-automation-vX.X.zip 'promo-automation/helper/*' -d /tmp/extract
rsync -av --delete \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='.venv' --exclude='venv' \
  /tmp/extract/promo-automation/helper/ ~/.promo-automation/helper-src/
rm -rf /tmp/extract

# 3. helper 재시작
launchctl kickstart -k gui/$(id -u)/com.konai.promo-automation
```

Plugin 코드 (figma-plugin) 는 Figma 가 직접 disk 에서 읽으니 Figma 에서 plugin reload 만.

### Q. PLATFORM-8 라이브러리 매칭이 안 뜹니다
확인 순서:
1. helper 살아있나 — `curl http://127.0.0.1:7000/health`
2. PLATFORM-8 접근 가능 — 브라우저에서 `http://10.10.224.110:3000` 열리는지
3. 프레임명이 `MMDD_banner_...` / `MMDD_popup_...` 형식인지
4. 프레임 내 텍스트에 라이브러리 subject 와 매칭될 단어가 있는지
5. 하단 ▸ 로그 펼치고 `PLATFORM-8 매칭 없음` / `PLATFORM-8 검색 실패` 메시지 확인
6. 소통참여 프레임은 의도적으로 라이브러리 매칭 안 함 (실사 사진 목적)

### Q. AI 이미지 생성 시 "openai_api_key 가 config 에 없습니다" 503
`~/.promo-export/config.json` 에 `"openai_api_key": "sk-..."` 추가하거나 `helper/.env` 에 `OPENAI_API_KEY=sk-...` 한 줄. 그 후 helper 재시작:
```bash
launchctl kickstart -k gui/$(id -u)/com.konai.promo-automation
sleep 2 && curl -s http://127.0.0.1:7000/health | python3 -m json.tool
```
응답에 `"openai_loaded": true` 보이면 OK.

### Q. AI 이미지 생성 시 "이미지 자리를 찾지 못했습니다"
컴포넌트 안에 이미지 들어갈 RECTANGLE 또는 FRAME 이 있어야 함. 다음 중 하나 만족하면 자동 인식:
- 노드 이름에 `img` / `image` / `이미지` / `사진` / `photo` 중 하나
- 또는 이미 IMAGE 타입 fill 이 깔려 있음 (회색 단색 fill 은 인식 안 됨)

### Q. AI 이미지가 마음에 안 들어요
- 미리보기 박스의 **재생성 코멘트** textarea 에 피드백 적고 `[재생성]`: `더 귀여운 캐릭터로`, `분홍색 톤으로`, `카드 말고 선물상자로`
- 스타일 dropdown 을 3D → 2D 로 바꾸고 재생성
- 코멘트 비워두고 재생성 → 같은 설정으로 랜덤 재시도

### Q. 지역 이름이 일반 명사로 잘못 그려져요 (예: 양산을 우산으로)
한국 도시명 중 동음이의어(양산/경주/영광/…)는 helper 에 28개가 사전 등록돼 있고 자동으로 영문 음역 + 부정문 어노테이션 주입. 새 도시가 누락된 경우 `helper/main.py` 의 `KOREAN_PLACE_NAMES` dict 에 한 줄 추가 후 재시작:
```python
KOREAN_PLACE_NAMES = {
    ...
    "신규도시": "Singyu city in South Korea (NOT the Korean word for '...')",
}
```

### Q. AI 이미지에 글자가 너무 작게/안 들어가요
**금액·% 숫자 강조** 체크박스 (배너/팝업 sub-tab) 켜고 재생성. 텍스트에 `20,000원` / `5%` 패턴이 있을 때만 동작 — 그 숫자를 이미지에 크게 그림.

### Q. OpenAI 사용 비용이 걱정돼요
- gpt-image-1: 1024×1024 한 장당 약 $0.04
- gpt-4o-mini (프롬프트 추출): 한 호출당 100 토큰 미만 → 거의 무시 가능 ($0.001 미만)
- **PLATFORM-8 라이브러리 매칭이 되면 AI 호출을 아예 안 하니 절약됨**
- 재생성마다 새로 호출되므로 미리보기에서 OK 인 시점에만 [적용] 권장
- 콘솔 https://platform.openai.com/usage 에서 일별 비용 모니터링

### Q. PPT 슬라이드의 한글 텍스트가 깨짐
LibreOffice 폰트 cache 가 안 빌드된 상태. LibreOffice 를 한 번 GUI 로 실행하면 해결.

### Q. work 컴포넌트가 안 보여요
작업 파일에 `[LOCAL] Common` 라이브러리의 work 컴포넌트를 한 번 끌어다 두기.

### Q. PPT 슬라이드 텍스트 추출 순서가 이상해요
도구는 슬라이드를 가로 중앙 기준 좌/우 column 으로 나눠 각 column 을 위→아래로 추출. 3열 이상의 복잡한 레이아웃이면 빗나갈 수 있음.

### Q. "이름 규칙 불일치" 경고
선택한 프레임 중 일부가 이름 규칙을 안 따르는 것. 해당 프레임은 자동 skip 되고 나머지는 정상 진행.

### Q. 분할 단위가 너무 크거나 너무 작아요
`~/Documents/promo-automation/helper/main.py` 의 `MAX_PNG_HEIGHT = 3000` 값 조정 가능. 2000 → 작게, 5000 → 크게.

### Q. SSO 환경에서 인증 실패
회사 Way 가 SSO 만 받는 환경이면 비번 인증이 막혀서 동작 안 함. 관리자에게 문의.
