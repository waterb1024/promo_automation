# 부가서비스 (Addon) 기능

배너·팝업 자동화와 별개로 지자체별 부가서비스 이미지 세트를 자동 생성하는 기능. 서비스명은 지자체마다 달라 자유 입력이며, 위치 6개(홈 상단/중단, 생활편의 상단/하단, 지원금혜택 하단, 소통참여 하단) + 3D 아이콘화까지 하나의 서브탭에서 다룬다.

## UI 구조

### 적용 탭 서브탭 순서 (2026-07-08 변경)

`배너 → 팝업 → 부가서비스 → 소통참여 → 상세페이지` 로 재배치 (이전: `배너-팝업-상세페이지-소통참여-부가서비스`). 부가서비스가 상세페이지보다 사용 빈도가 높아 앞으로 이동. `ui.html:428-432` 참고.

### 적용 탭 · 부가서비스 서브탭

`위치` select 하나로 흐름 분기. `3D 아이콘화` 선택 시 UI가 자동 간소화되고 메인 버튼 라벨이 `선택 프레임 3D 재변환`으로 바뀐다. 드롭다운은 사용 빈도가 낮은 `3D 아이콘화` 를 최하단으로 배치 (2026-07-08).

| 위치 값 | 라벨 | 프레임 규격 |
|---|---|---|
| `home-top` | 홈 상단 (1080×528) | `image_홈_{서비스명}_top_1080x528_#hex` |
| `home-middle` | 홈 중단 (360×378) | 미구현 |
| `life-top` | 생활편의 상단 (984×840) | 미구현 |
| `life-bottom` | 생활편의 하단 (1080×가변) | 미구현 |
| `support-bottom` | 지원금혜택 하단 (984×264) | `image_지원금혜택_{서비스명}_bottom_984x264` (Figma display 350×88 = 1/3 스케일) |
| `sotong-bottom` | 소통참여 하단 (480×348) | 미구현 |
| `icon` | 3D 아이콘화 (48×48) | 2D → 3D 변환 |

### 설정 탭 · 부가서비스 템플릿 (2026-07-08 이후 vestigial)

`clientStorage:addon_templates` 에 위치별 라이브러리 인스턴스 등록/삭제 UI 는 남아있으나 **`createAddonFromSpec` 은 이 값을 참조하지 않는다.** 라이브러리 템플릿의 `whitespace-nowrap`·`overflow-clip` 등 디자인 세부가 코드 빌더와 어긋나 텍스트 잘림/영역 불일치가 반복돼서 경로를 코드 빌더 단일로 통일했다.

### 코드 내장 builder (`ADDON_BUILDERS`)

라이브러리 컴포넌트 없이 5개 위치 프레임을 100% 코드로 생성. `figma.createFrame` / `figma.createText` / `.resize()` / `.fills` / `.cornerRadius` 로 구조·크기·기본 스타일 지정.

| Position | Builder | 명명 규칙 (초기값) | 주요 슬롯 |
|---|---|---|---|
| `home-top` | `buildAddonHomeTop` | `image_홈_{svc}_top_1080x528` | txt/TEXT (18/24 Bold) · area/image (122×107, centered in 148×132) · Button/small rounded-8 (+ TEXT Bold 14/20) |
| `home-middle` | `buildAddonHomeMiddle` | `image_홈_{svc}_middle_360x378` | bg 파스텔 카드(120×120) · img/image 아이콘 슬롯(96×52) · text 흰 카드(120×80, y=46) — sub_text 13/18 Regular #666 + TEXT 14/20 Bold #000 (센터) |
| `life-top` | `buildAddonLifeTop` | `image_생활편의_{svc}_top_984x840` | Figma 148:5610 그대로 · 외곽 파스텔 카드(패딩 16) · con 296×196 (sub_tit 20 + tit 44 (2줄) + area 118) · area/image **220×118 (1.86:1)** 센터 (38, 0) · apply 시 `FIT` 로 렌더 → image 118×118 로 슬롯 안에 들어오고 좌우 51px 씩은 외곽 파스텔이 채움 · **AD_IMG (292, 200, 20×12) — `figma.createNodeFromSvg` 로 생성한 벡터 배지 (사용자 제공 SVG, 2026-07-08), 기본 hidden** · Button/small gradient rounded-8 (16, 228, 296) (+ TEXT 13/20 Bold) |
| `life-bottom` | `buildAddonLifeBottom` | `image_생활편의_{svc}_bottom_1080` | tit/head (icon_20 + svc_name + TEXT) · image · Button/medium |
| `support-bottom` | `buildAddonSupportBottom` | `image_지원금혜택_{svc}_bottom_984x264` | li · icon(56×56 bg + 40×40 image) · txt-con (TEXT Bold 14/22) · Button/small (54×22 pill, svc 라벨) |
| `sotong-bottom` | `buildAddonSotongBottom` | `banner_소통참여_{svc}_bottom_480x348` | head (icon_20 + svc_name) · txt/TEXT · image |

**스타일 defaults** (모두 Pretendard 기반, 사후 수정 가능):
- 메인 카피: Bold, 14~16px, `#222222`
- 서브 라벨(svc_name): SemiBold, 13px, `#666666`
- 버튼 배경: `#6172DD` (KONA primary — apply 시 saturated 파생색으로 덮어써짐)
- 버튼 텍스트: SemiBold, 14px, `#ffffff`
- 코너 라운드: 6~12px

**서비스명 힌트 자동 추출** (`_guessServiceNameFromTexts`): 스펙 셀 텍스트 중 `^[가-힣][가-힣0-9A-Za-z]{2,9}$` 정규식 매치 첫 항목을 서비스명 후보로 사용. 매치 없으면 `"서비스명"` placeholder → 사용자가 수정. **추출된 서비스명은 `texts` 배열에서도 즉시 제거** — 그렇지 않으면 이후 slot 매핑에서 tit(메인 타이틀) 등 다른 슬롯을 중복 침범 (2026-07-08 fix).

**Slot skip 이름 규칙**: `createAddonFromSpec` 은 스펙 셀 텍스트를 빌더 프레임의 placeholder 슬롯에 top-down 순서로 채우는데, 특정 이름 패턴은 자동 제외한다. 정규식: `/^(svc_|static_|label_|logo_|badge_)|_static$|_label$/i`. AD_IMG 안의 텍스트는 `badge_ad` 로 명명해 자동 제외되게 한다.

### 생성 경로 (단일화)

`createAddonFromSpec(position)` 은 `buildAddonTemplateByPosition(position, { serviceName })` 만 호출한다. 응답 `templateSource` 는 항상 `"code"`.

### 일괄 적용 (기획 템플릿) — 2026-07-08 추가

**UI 배치**: 위치 카드와 시각적으로 분리된 별도 카드. 위치 드롭다운·단건 적용 버튼과 논리적으로 무관하기 때문에 (배치는 선택 프레임의 width/height 로 위치를 자동 판별) 같은 카드에 두면 위치 select 에 종속되는 것처럼 오해를 줌 → 카드 분리. 버튼 라벨 `일괄 적용 실행`, 배경 `#444` 진한 회색.

**동작**: 여러 프레임을 선택 → `일괄 적용 실행` 클릭 → 각 프레임 크기를 `ADDON_SIZE_SIGNATURES` 와 매칭해 위치를 자동 판별하고 순차 실행.

**시그니처 테이블** (`ui.html · ADDON_SIZE_SIGNATURES`)

| 위치 | center (w×h) | tolerance (±w / ±h) |
|---|---|---|
| home-top | 378×185 | 60 / 30 |
| home-middle | 124×130 | 20 / 20 |
| life-top | 342×292 | 40 / 40 |
| life-bottom | 378×340 | 40 / 120 |
| support-bottom | 350×88 | 30 / 20 |
| sotong-bottom | 163×119 | 25 / 25 |

**스킵 조건**
- 프레임명이 이미 생성된 addon 결과물 규칙에 매치 (`POSITION_EXISTING_RE`, 예: `^image_홈_.+_top_/`, `^image_지원금혜택_.+_bottom_/` 등) → "이미 생성된 템플릿" 사유로 스킵
- 시그니처 매칭 실패 → "크기 매칭 실패" 사유로 스킵

**진행 상태 표시**
- 배치 시작 시 `일괄 적용 실행` 버튼이 `일괄 적용 진행 중…` 로 바뀌고 비활성화 (`_setAddonBatchBtnRunning`)
- 배치 카드 하단 자체 status box (`.img-gen-status` 재사용, id `addon-batch-img-gen-status`) 에 timer / stage / substep / animated bar 표시
- stage: `일괄 {idx}/{total} · {label}` (예: `일괄 3/7 · 홈 상단`), substep: 현재 프레임 이름
- 기존 addon status 갱신이 배치 박스에도 자동 미러링 (`_imgGenStart` / `_imgGenSetStage` / `_imgGenStop` 확장) — `템플릿 적용 중…` `재생성 중…` 같은 세부 진행도 배치 카드에서 노출
- 종료 시 버튼 라벨/활성화 복구, `.active` 해제

**프롬프트 코멘트**: 위치 카드의 `addon-feedback` textarea 값이 그대로 각 아이템에 전달.

## 프롬프트 템플릿 (helper `IMAGE_PROMPT_TEMPLATES`)

위치별로 별도의 프롬프트 템플릿을 쓴다. UI 의 `POSITION_STYLE_MAP` 이 position 값을 style key 로 매핑해서 `/generate-image` body 의 `style` 필드에 실어 보냄. **모든 위치가 transparent 배경 (isolated subject) 로 생성 → pastel 은 프레임 배경 fill 로 별도 적용.**

| Style key | 대상 위치 | 프롬프트 | 배경 |
|---|---|---|---|
| `3d` | 홈 상단 · 생활편의 상단 · 생활편의 하단 · 지원금혜택 하단 · 소통참여 하단 · 배너·팝업 | `Simple 3D illustration of {subject}, cute and minimal, no text, no letters, smooth matte plastic texture, isolated subject on transparent background, no shadow ground plane, high quality, 3D render` | transparent |
| `2d-flat-solid` | 홈 중단 | `Flat design illustration of {subject}, no text, no letters, solid color fills only, no outline, no stroke, no line art, simple clean vector style` | transparent |
| `photoreal` | 배너·팝업 실사 (기존) | (변경 없음) | transparent |
| `illustration` | 배너·팝업 flat (기존) | (변경 없음) | transparent |
| `ICON_3D_PROMPT` | 3D 아이콘화 (`/transform-icon`) | `smooth matte plastic texture, cute and minimal, 3D render` | transparent |

## 버튼 그라데이션 (`_derive_button_gradient_from_pastel`)

기존 solid `_derive_button_from_pastel` 대신, Figma 참조 그라데이션 (node `137:5016`) 의 S/L 값을 유지하고 **hue 만 이미지의 dominant color 로 대체**한 좌→우 수평 그라데이션 생성.

- 참조 gradient stop:
  - start `#0fb7d5` (HSL 189° 87% 45%)
  - end   `#0979b2` (HSL 200° 90% 37%)
- 파생 결과: 두 stop 모두 `H = imageHue`, S/L 은 위 값 그대로 유지.

응답 필드:
```json
{
  "background_color": "#f9e0c3",
  "button_color": "#e88f4a",              // solid (backward compat)
  "button_gradient": {
    "start": "#e8a04a",
    "end":   "#c26612"
  }
}
```

code.js 는 `buttonGradient` 가 있으면 `GRADIENT_LINEAR` fill 로 적용, 없으면 `button_color` solid 로 폴백.

## 홈 상단 (home-top) 흐름

### 이미지 생성 로직

배너와 동일한 helper `/generate-image` 파이프라인 재사용. GPT-4o-mini 로 텍스트 → 영어 명사구 추출 → gpt-image-1 이 위 표의 `3d-solid-pastel` 프롬프트로 PNG 생성 (opaque).

생성 이미지에서 dominant color 를 추출해 두 값을 도출:
- **배경색** (`background_color`): pastel — HSL Lightness clamp 0.87~0.93 (기존 `_extract_dominant_color_pastel`)
- **버튼색** (`button_color`): 같은 hue, Saturation 최소 0.55, Lightness 0.50 (신규 `_derive_button_from_pastel`)

### Apply 결과

`applyMode` 가 `addon-*` 계열 (`addon-home-top`, `addon-home-middle`, `addon-life-top`, `addon-life-bottom`, `addon-sotong-bottom`) 이면 아래가 모두 적용됨:
1. **이미지**: 프레임 내 `name === "image"` descendant 를 우선 탐색 (없으면 root 제외 area picker). area picker 만 쓰면 외곽 프레임(`image_홈_...`) 이 걸려서 pastel 로 덮어써지는 버그가 있었음 — descendant 우선으로 해결. **scaleMode**: 기본 `FILL`, 슬롯이 소스(1024×1024 square) 와 크게 다른 aspect 면 `fitScaleModes` 화이트리스트에 등록해 `FIT` 로 전환. 현재 `addon-life-top`(220×118, 1.86:1) 이 등록됨 — 이미지 118×118 로 렌더되고 좌우 51px 씩은 외곽 파스텔 (apply 시 image dominant color 로 세팅) 이 자연스럽게 채움.
2. **버튼 그라데이션**: `_findButtonDescendant` 로 fuzzy 매칭 (`Button/small`, `Button/medium`, `Button`, `Button/...`, `button *`, `btn*` 등). 발견 시 `GRADIENT_LINEAR` fill 을 적용 (좌→우, 두 stop 은 helper 가 파생한 `button_gradient`). `button_gradient` 없고 `button_color` 만 있으면 SOLID 로 폴백.
3. **프레임 배경색**: 외곽 프레임 fill 을 SOLID pastel + `visible: false` 로 설정 (레이어 눈은 꺼짐). 예외들:
   - **addon-home-middle**: 외곽 프레임 대신 내부 `bg` descendant 에 pastel 을 `visible:true` 로 적용. 홈 중단은 하단 흰색 텍스트 카드가 오버레이되기 때문에 외곽 fill 이 보이지 않아 별도 파스텔 카드가 필요.
   - **addon-life-top**: 외곽 프레임 자체가 파스텔 카드이므로 `visible:true` 로 유지 (`outerVisibleAddons` 화이트리스트 참조).
4. **프레임명**: 홈 상단(`addon-home-top`) 에만 끝의 `_#RRGGBB` 를 새 hex 로 교체 (없으면 append). 예: `image_홈_배달서구_top_1080x528_#e1f3f9` → `..._#f8e2ec`. 다른 addon-* 는 프레임명 유지 (사용자 지침 2026-07-08).
5. ~~라이브러리 인스턴스 자동 detach~~ (2026-07-08 라이브러리 경로 제거로 무의미).

### 기획 셀 → 새 템플릿 자동 생성 (Smart dispatch)

`적용 + 이미지 생성` 클릭 시 UI 가 선택 프레임 이름을 확인:
- `^image_홈_.+_top_/` 매치 → 기존 흐름 (`image_generate_prepare`)
- 매치 안 됨 (기획 셀로 판단) → `addon_from_spec` → code.js `createAddonFromSpec`:
  1. 선택 프레임에서 텍스트 top-down 추출 (placeholder 자동 제외)
  2. `buildAddonTemplateByPosition(position, { serviceName })` 로 코드 빌더가 새 FRAME 생성 (2026-07-08 이후 라이브러리 경로 제거)
  3. 선택 셀 우측 (`x + width + 24`, 같은 y) 에 배치
  4. 새 프레임의 placeholder 텍스트 슬롯을 top-down 순서로 채움
  5. 새 프레임을 selection 으로 설정 → 자동으로 `image_generate_prepare` 체인 → 이미지 생성 흐름 이어감

## 아이콘 (icon) 흐름

배너와 완전히 다른 image-to-image 변환. 프레임 export → gpt-image-1 `images.edit`.

### 흐름

1. 사용자가 캔버스에서 2D 아이콘 프레임 1개 선택
2. `선택 프레임 3D 재변환` 클릭 → code.js `prepareIconTransform`:
   - `target.exportAsync({ format: "PNG" })` → base64
   - UI 로 `icon_transform_context` 전달
3. UI 가 helper `/transform-icon` POST → 폴링 → 미리보기 → apply
4. helper `_run_icon_transform_job`:
   ```
   ICON_3D_PROMPT = "smooth matte plastic texture, cute and minimal, 3D render"
   ```
   - `client.images.edit(model="gpt-image-1", image=..., prompt=..., background="transparent")`
   - `images.edit` 은 입력 이미지의 실루엣·주제를 그대로 유지하고 스타일만 재해석하므로 프롬프트는 스타일 지시만 담김
5. `image_generate_apply` (applyMode 없음 · frameNodeId 없음) → code.js 는 target 노드 fill 만 교체. 배경·버튼·프레임명 처리 skip.

## Helper 확장 (`helper/main.py`)

### 새 함수
- `_derive_button_from_pastel(pastel_hex, l_target=0.50, s_min=0.55) -> Optional[str]`  
  Pastel hex 를 받아 같은 hue 의 saturated variant 반환.

### 새 엔드포인트
- `POST /transform-icon`  
  Body: `TransformIconRequest { image_base64, feedback? }`  
  Return: `{ job_id, status }` (기존 `_IMAGE_JOBS` 인프라 재사용)

### 기존 확장
- `_run_image_job`: bg_color 추출 후 `button_color = _derive_button_from_pastel(bg_color)` 도 저장
- `GET /generate-image/{job_id}`: response 에 `button_color` 필드 포함

## Plugin 메시지 프로토콜 (신규)

### UI → code.js
- `image_generate_prepare` (기존, `kind` 에 `addon-home-top` 추가)
- `image_generate_apply` (기존, `applyMode`·`buttonColor` 필드 추가)
- `icon_transform_prepare` (신규)
- `addon_register` `{ position }` (신규)
- `addon_delete` `{ position }` (신규)
- `addon_get_templates` (신규)
- `addon_from_spec` `{ position }` (신규)

### code.js → UI
- `image_generate_done` (기존, `buttonColorApplied` `frameRenamedFrom` `frameRenamedTo` 추가)
- `icon_transform_context` (신규)
- `addon_templates_loaded` `{ templates }` (신규)
- `addon_template_registered` `{ position, name, key, templates }` (신규)
- `addon_template_deleted` `{ position, removedName, templates }` (신규)
- `addon_from_spec_done` `{ position, newNodeId, newNodeName, specNodeId, texts_extracted, slots_available, slots_filled, font_fallbacks, templateName }` (신규)

## 사용 시나리오

### 시나리오 1 · 기획 셀에서 자동 생성 (권장)
1. 설정 탭에서 `홈 상단` 라이브러리 인스턴스 캔버스에 드래그 → 선택 → `+ 등록`
2. 기획 파일의 sub-frame (예: 택시 배너 스펙 셀 378×185) 선택
3. 부가서비스 서브탭에서 `홈 상단` 선택 → `적용 + 이미지 생성`
4. 우측에 새 홈 상단 템플릿 인스턴스가 자동 생성 + 텍스트·이미지·버튼색·배경색·프레임명 모두 자동 반영

### 시나리오 2 · 기존 템플릿 인스턴스에 이미지만
1. 캔버스에 있는 `image_홈_{서비스명}_top_1080x528_#hex` 인스턴스 선택
2. `홈 상단` + `적용 + 이미지 생성` → 이미지·색·이름만 갱신

### 시나리오 3 · 아이콘 3D 변환
1. 2D 아이콘 프레임 선택
2. `3D 아이콘화` 선택 → `선택 프레임 3D 재변환`
3. helper 가 `images.edit` 로 3D 렌더 → 같은 프레임에 fill 로 적용

## PLATFORM-8 사내 라이브러리 매칭 (부가서비스 확장)

배너·팝업에서 이미 쓰던 PLATFORM-8(`http://10.10.224.110:3000`) 매칭 흐름을 부가서비스에도 확장 (아이콘 position 제외).

**게이트 판정 (2026-07-08 수정)**: `pending.kind` 는 부가서비스 전체가 `"addon"` 하나로 세팅돼 있어 세부 위치를 구분할 수 없었다. 이전 코드가 `pending.kind.indexOf("addon-") === 0` 로 판정해 항상 false → PLATFORM-8 검색을 한 번도 안 탔음. 이제 `pending.applyMode`(`"addon-home-top"` 등)를 기준으로 판정하며 apply payload 도 `_plibApplyMode` 를 그대로 전달한다.

### 흐름
1. **검색어** = 프레임명의 promotion 키워드 + 프레임 내 모든 텍스트 노드 (자동 조합, 한글 NFC/NFD 정규화)
2. **부가서비스 프레임명 파싱** (`_plibExtractPromotion` 확장):
   - `image_홈_{svc}_top_1080x528_#hex` → `{svc}` 추출
   - `image_생활편의_{svc}_top_984x840` → `{svc}` 추출
   - `banner_소통참여_{svc}_bottom_480x348` → `{svc}` 추출
   - 끝에 붙는 hex 접미사 / 크기 토큰 / 위치 토큰 (`top`·`middle`·`bottom`) 자동 제거
3. **스타일 → view 매핑**:
   - `3d` → `3d`
   - `2d-flat-solid` / `illustration` → `2d`
   - `photoreal` / 기타 → `any`
4. 매칭 결과 있으면 인라인 픽커 (썸네일 클릭 → 즉시 적용). 없으면 AI 생성 폴백.
5. **부가서비스 apply 시**: PLATFORM-8 매칭 결과에도 `applyMode`, `buttonColor`, `buttonGradient` 를 전달해서 프레임 배경 hidden · 프레임명 rename · 버튼 그라데이션 채색까지 자동 실행 (helper `/promo-images/download` 응답에 `button_color`·`button_gradient` 포함).

## 향후 작업

- 코드 내장 builder 의 스타일 defaults 를 지자체 브랜딩에 맞게 튜닝하는 옵션(폰트 크기·컬러 오버라이드)
- 기획 스펙 시트(Excel/CSV) 파싱 → 지자체 × 위치 × 서비스 배치 자동 생성
- 지자체 컨텍스트 저장 (서비스 목록·3D 아이콘 캐시·컬러)
- 홈 상단·생활편의 상단 이미지에 baked-in 된 pastel bg 를 이미지 슬롯 크기에 맞게 crop 하는 후처리

## 변경 이력

### 2026-07-08

**PLATFORM-8 부가서비스 매칭 활성화 (버그 수정)**
- 게이트가 `pending.kind === "addon"` 을 `.indexOf("addon-")` 로 검사해 항상 false 였음 → 부가서비스에서 PLATFORM-8 검색이 한 번도 안 탔던 상태. `pending.applyMode`(`"addon-home-top"` 등) 기준으로 재판정. apply payload 도 `applyMode` 를 그대로 전달.
- `_openPromoLibPicker` 가 addon 일 때 `sub-popup` 탭으로 이동시키던 문제 해결 → `sub-addon` 으로 relocate.

**생성 경로 단일화**
- `createAddonFromSpec` 에서 라이브러리 임포트 branch 제거. `addon_templates` clientStorage 저장은 UI 호환용으로 남기되 실제 참조 안 함.
- 이유: Figma 라이브러리 템플릿의 `whitespace-nowrap`·`overflow-clip` 등 세부가 코드 빌더와 어긋나 텍스트 잘림/영역 불일치가 반복.

**서비스명 힌트 이중 삽입 버그 수정**
- `_guessServiceNameFromTexts` 로 뽑은 서비스명 후보가 `texts` 배열에 그대로 남아 있어 이후 slot filling 에서 tit(메인 타이틀) 슬롯을 중복 침범 → svc 후보 매칭 즉시 `texts.splice` 로 제거.

**Slot skip 이름 규칙**
- `createAddonFromSpec` 정규식 `/^(svc_|static_|label_|logo_|badge_)|_static$|_label$/i` 유지.
- AD_IMG 안의 텍스트를 `badge_ad` 로 명명해 자동 제외 (SVG 화 이후엔 벡터 path 라 무관).

**홈 상단 (`addon-home-top`)**
- TEXT 를 `textAutoResize: "WIDTH_AND_HEIGHT"` 로 두어 wrap 방지 → 3번째 라인 잘림 방지.
- 이미지 슬롯을 `area` (148×132) + 내부 `image` (122×107, centered) 로 재구조화.
- Button/small `cornerRadius: 8`, 텍스트 Bold 14/20.
- `_addonMkText` 가 `lineHeight` 옵션 지원 (숫자/객체 모두).

**홈 중단 (`addon-home-middle`)** — Figma 132:21489 반영
- `bg` 파스텔 카드(120×120, #d8e6ff, rounded 12) — apply 시 dominant color 로 덮어써짐.
- `img/image` 아이콘 슬롯 96×52 중첩.
- 하단 흰색 텍스트 카드 120×80(y=46) — sub_text (13/18 Regular #666) + TEXT (14/20 Bold #000), 둘 다 `textAlignHorizontal: "CENTER"` + 폭 240 · x=-60 트릭으로 자동 wrap 방지 (부모 clipsContent 가 극단 케이스만 잘라줌).
- **apply 예외**: outer 대신 `bg` descendant 에 pastel `visible:true` 로 적용. 흰 카드가 outer fill 을 가리기 때문.

**생활편의 상단 (`addon-life-top`)** — Figma 148:5610 반영
- 외곽 파스텔 카드(패딩 16, #def8fd 기본, apply 시 dominant 로 덮어써짐).
- con 296×196 (y=16), sub_tit 20 + tit 44 (2줄) + area/image 220×118 (y=78, image at x=38 센터).
- Button/small gradient `#0fb7d5→#0979b2` (Figma 참조), rounded 8.
- AD_IMG (292, 200, 20×12) — 사용자 제공 SVG 로 벡터 배지 생성 (`figma.createNodeFromSvg`), 기본 hidden.
- **apply 예외 (scaleMode)**: 220×118 슬롯(1.86:1) 과 소스(1024 square) aspect 차이 → `fitScaleModes` 화이트리스트에 등록해 `FIT` 로 렌더 → 이미지 118×118 로 슬롯에 완전히 들어오고 좌우 51px 여백은 외곽 파스텔이 이어짐.
- **apply 예외 (outerVisible)**: outer 자체가 파스텔 카드이므로 `visible:true` 로 유지 (`outerVisibleAddons` 화이트리스트).

**프레임명 hex 접미사 규칙 변경**
- 이전: 모든 `addon-*` apply 시 프레임명 끝에 `_#RRGGBB` 교체/추가.
- 변경: **`addon-home-top` 에만** 적용. 다른 위치는 이름 유지 (사용자 지침).

**bg 라우팅 로직**
- apply 시 pastel bg 를 outer 프레임 vs 내부 `bg` descendant 중 어디에 얹을지 applyMode 기반으로 결정 (`applyMode === "addon-home-middle"` 만 descendant).

**scaleMode 라우팅 로직**
- `fitScaleModes` 화이트리스트 도입 — 특정 addon 위치는 FILL 대신 FIT.

**진단 로그**
- `applyGeneratedImage` 진입 시 target/frame/applyMode/base64 크기를 log 로 출력해 apply 흐름 실패 지점 진단 가능.

**AD_IMG SVG 벡터화**
- 기존 `_addonMkFrame` + 6px 텍스트로 만들던 AD 배지를 사용자 제공 SVG (`figma.createNodeFromSvg`) 벡터 노드로 대체. 스케일링에도 안 깨지고 렌더 품질 개선.
