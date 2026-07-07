# 부가서비스 (Addon) 기능

배너·팝업 자동화와 별개로 지자체별 부가서비스 이미지 세트를 자동 생성하는 기능. 서비스명은 지자체마다 달라 자유 입력이며, 위치 5개(홈 상단/중단, 생활편의 상단/하단, 소통참여 하단) + 아이콘까지 하나의 서브탭에서 다룬다.

## UI 구조

### 적용 탭 · 부가서비스 서브탭

`위치` select 하나로 흐름 분기. `아이콘` 선택 시 UI가 자동 간소화되고 메인 버튼 라벨이 `선택 프레임 3D 재변환`으로 바뀐다.

| 위치 값 | 라벨 | 프레임 규격 |
|---|---|---|
| `icon` | 아이콘 (48×48) | 2D → 3D 변환 |
| `home-top` | 홈 상단 (1080×528) | `image_홈_{서비스명}_top_1080x528_#hex` |
| `home-middle` | 홈 중단 (360×378) | 미구현 |
| `life-top` | 생활편의 상단 (984×840) | 미구현 |
| `life-bottom` | 생활편의 하단 (1080×가변) | 미구현 |
| `sotong-bottom` | 소통참여 하단 (480×348) | 미구현 |

### 설정 탭 · 부가서비스 템플릿

위치별로 라이브러리 인스턴스 1개씩 등록. `clientStorage:addon_templates` 에 `{ position: { name, key, registered_at } }` 형태로 저장. 지자체마다 서비스명만 다르고 프레임 규격은 같아서 위치당 1 템플릿을 재사용.

## 프롬프트 템플릿 (helper `IMAGE_PROMPT_TEMPLATES`)

위치별로 별도의 프롬프트 템플릿을 쓴다. UI 의 `POSITION_STYLE_MAP` 이 position 값을 style key 로 매핑해서 `/generate-image` body 의 `style` 필드에 실어 보냄.

| Style key | 대상 위치 | 프롬프트 | 배경 |
|---|---|---|---|
| `3d-solid-pastel` | 홈 상단 · 생활편의 상단 | `Simple 3D illustration of {subject}, cute and minimal, no text, no letters, smooth matte plastic texture, solid pastel background, high quality, 3D render` | opaque (baked-in pastel) |
| `2d-flat-solid` | 홈 중단 | `Flat design illustration of {subject}, no text, no letters, solid color fills only, no outline, no stroke, no line art, simple clean vector style` | opaque |
| `3d` | 배너·팝업 (기존) | `Simple 3D illustration of {subject}, cute and minimal, no text, no letters, smooth matte plastic texture, isolated subject on transparent background, no shadow ground plane, high quality, 3D render` | transparent |
| `photoreal` | 배너·팝업 실사 (기존) | (변경 없음) | transparent |
| `illustration` | 배너·팝업 flat (기존) | (변경 없음) | transparent |
| `ICON_3D_PROMPT` | 아이콘 3D 변환 (`/transform-icon`) | `smooth matte plastic texture, cute and minimal, 3D render` | transparent |

### 자동 opaque 처리

`3d-solid-pastel` 은 프롬프트 자체가 solid background 를 요구해서 `client.images.generate` 호출 시 `background="transparent"` 를 붙이면 프롬프트와 충돌한다. helper 가 style 을 보고 자동으로 opaque 처리:

```python
wants_transparent = req.transparent_background and req.style != "3d-solid-pastel"
if wants_transparent:
    gen_kwargs["background"] = "transparent"
```

## 홈 상단 (home-top) 흐름

### 이미지 생성 로직

배너와 동일한 helper `/generate-image` 파이프라인 재사용. GPT-4o-mini 로 텍스트 → 영어 명사구 추출 → gpt-image-1 이 위 표의 `3d-solid-pastel` 프롬프트로 PNG 생성 (opaque).

생성 이미지에서 dominant color 를 추출해 두 값을 도출:
- **배경색** (`background_color`): pastel — HSL Lightness clamp 0.87~0.93 (기존 `_extract_dominant_color_pastel`)
- **버튼색** (`button_color`): 같은 hue, Saturation 최소 0.55, Lightness 0.50 (신규 `_derive_button_from_pastel`)

### Apply 결과

`applyMode="addon-home-top"` 로 code.js 에 전달되면:
1. **이미지**: 프레임 내 `name === "image"` descendant 를 우선 탐색 (없으면 root 제외 area picker). area picker 만 쓰면 외곽 프레임(`image_홈_...`) 이 걸려서 pastel 로 덮어써지는 버그가 있었음 — descendant 우선으로 해결.
2. **버튼색**: `Button/small` descendant 를 BFS 로 탐색, 발견 시 SOLID fill 로 적용 (visible)
3. **프레임 배경색**: 외곽 프레임 fill 을 SOLID pastel + `visible: false` 로 설정 (레이어 눈은 꺼짐)
4. **프레임명**: 끝의 `_#RRGGBB` 를 새 hex 로 교체 (없으면 append). 예: `image_홈_배달서구_top_1080x528_#e1f3f9` → `..._#f8e2ec`

### 기획 셀 → 새 템플릿 자동 생성 (Smart dispatch)

`적용 + 이미지 생성` 클릭 시 UI 가 선택 프레임 이름을 확인:
- `^image_홈_.+_top_/` 매치 → 기존 흐름 (`image_generate_prepare`)
- 매치 안 됨 (기획 셀로 판단) → `addon_from_spec` → code.js `createAddonFromSpec`:
  1. 선택 프레임에서 텍스트 top-down 추출 (placeholder 자동 제외)
  2. `addon_templates[home-top]` 에 등록된 라이브러리 컴포넌트 `importComponentByKeyAsync` → 인스턴스 생성
  3. 선택 셀 우측 (`x + width + 24`, 같은 y) 에 배치
  4. 인스턴스의 placeholder 텍스트 슬롯을 top-down 순서로 채움
  5. 새 인스턴스를 selection 으로 설정 → 자동으로 `image_generate_prepare` 체인 → 이미지 생성 흐름 이어감

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
2. `아이콘` 선택 → `선택 프레임 3D 재변환`
3. helper 가 `images.edit` 로 3D 렌더 → 같은 프레임에 fill 로 적용

## 향후 작업

- 홈 중단·생활편의 상단/하단·소통참여 하단 위치별 apply 로직 (홈 상단 패턴 확장)
- 기획 스펙 시트(Excel/CSV) 파싱 → 지자체 × 위치 × 서비스 배치 자동 생성
- 지자체 컨텍스트 저장 (서비스 목록·3D 아이콘 캐시·컬러)
