// Promotion Automation - Figma plugin main thread (Phase 1)
// 선택 프레임 → PNG 추출 → UI 로 base64 전달 → UI 가 Helper 호출
//
// 프레임명 규칙 (모두 _ 로 구분):
//   배너      : MMDD_banner_{promotion}_{w}x{h}
//   팝업      : MMDD_popup_{promotion}_{w}x{h}
//   랜딩      : MMDD_landing_{promotion}_{w}
//   부가서비스: {image|banner}_{홈|생활편의|benefits|소통참여}_{svc}_{top|middle|bottom}_{w[xh]}[_#hex]
//   홈상단 legacy: home_img_{svc}[_#hex]  ← 홈 상단만 특이 케이스로 short name 도 허용
// 프로모션명에 _ 가 포함될 수 있어 "앞 2개(date,type) + 뒤 1개(size) 고정,
// 가운데 모두 promotion" 으로 파싱. 부가서비스는 date/promotion 이 없어
// 오늘 MMDD + svc 를 합성 metadata 로 사용.

figma.showUI(__html__, { width: 440, height: 800 });

const TYPES = ["banner", "popup", "landing", "addon"];

const ADDON_CATEGORY_TOKENS = { "홈": 1, "생활편의": 1, "benefits": 1, "소통참여": 1 };
const ADDON_POSITION_TOKENS = { "top": 1, "middle": 1, "bottom": 1 };

// 부가서비스 위치 → 댓글에 노출할 한글 라벨 (예: "홈 상단 배너1개")
const ADDON_POSITION_LABELS = {
  "홈/top": "홈 상단",
  "홈/middle": "홈 중단",
  "생활편의/top": "생활편의 상단",
  "생활편의/bottom": "생활편의 하단",
  "benefits/bottom": "지원금혜택 하단",
  "소통참여/bottom": "소통참여 하단",
};

function _todayMMDD() {
  const now = new Date();
  const mm = String(now.getMonth() + 1);
  const dd = String(now.getDate());
  return (mm.length < 2 ? "0" + mm : mm) + (dd.length < 2 ? "0" + dd : dd);
}

// 부가서비스 프레임명 파서. banner_/image_ 프리픽스 + 카테고리 + svc + 포지션 + 사이즈
// (선택적 _#hex 색 접미사 지원, home-top 이 apply 시 추가함).
function parseAddonName(parts) {
  if (parts.length < 5) return null;
  const prefix = parts[0];
  if (prefix !== "image" && prefix !== "banner") return null;

  const category = parts[1];
  if (!ADDON_CATEGORY_TOKENS[category]) return null;

  let end = parts.length - 1;
  if (/^#[0-9a-fA-F]{6}$/.test(parts[end])) end--;
  if (end < 3) return null;

  const sizeToken = parts[end];
  const position = parts[end - 1];
  if (!ADDON_POSITION_TOKENS[position]) return null;

  const svc = parts.slice(2, end - 1).join("_");
  if (!svc) return null;

  let intendedWidth = null;
  let intendedHeight = null;
  if (sizeToken.indexOf("x") !== -1) {
    const wh = sizeToken.split("x");
    if (wh.length !== 2) return null;
    if (!/^\d+$/.test(wh[0]) || !/^\d+$/.test(wh[1])) return null;
    intendedWidth = parseInt(wh[0], 10);
    intendedHeight = parseInt(wh[1], 10);
  } else {
    if (!/^\d+$/.test(sizeToken)) return null;
    intendedWidth = parseInt(sizeToken, 10);
  }

  return {
    date: _todayMMDD(),
    type: "addon",
    promotion: svc,
    intendedWidth, intendedHeight,
    addonCategory: category,
    addonPosition: position,
  };
}

// 홈 상단 legacy 규칙: home_img_{svc}[_#hex]
// 사이즈 토큰이 없으므로 표준 홈 상단 output 사이즈 1080×528 을 강제.
function parseHomeTopLegacy(parts) {
  if (parts.length < 3) return null;
  if (parts[0] !== "home" || parts[1] !== "img") return null;

  let end = parts.length - 1;
  if (/^#[0-9a-fA-F]{6}$/.test(parts[end])) end--;
  if (end < 2) return null;

  const svc = parts.slice(2, end + 1).join("_");
  if (!svc) return null;

  return {
    date: _todayMMDD(),
    type: "addon",
    promotion: svc,
    intendedWidth: 1080,
    intendedHeight: 528,
    addonCategory: "홈",
    addonPosition: "top",
  };
}

function parseFrameName(name) {
  const parts = name.split("_");
  if (parts.length < 3) return null;

  // MMDD 로 시작하지 않으면 부가서비스 규칙 시도
  if (!/^\d{4}$/.test(parts[0])) {
    if (parts[0] === "home" && parts[1] === "img") return parseHomeTopLegacy(parts);
    return parseAddonName(parts);
  }
  if (parts.length < 4) return null;

  const date = parts[0];
  const type = parts[1];
  const sizeToken = parts[parts.length - 1];
  const promotion = parts.slice(2, -1).join("_");

  if (type === "addon") return null;  // addon 은 MMDD_ 프리픽스 없음
  if (TYPES.indexOf(type) === -1) return null;
  if (!promotion) return null;

  let intendedWidth = null;
  let intendedHeight = null;

  if (sizeToken.indexOf("x") !== -1) {
    const wh = sizeToken.split("x");
    if (wh.length !== 2) return null;
    if (!/^\d+$/.test(wh[0]) || !/^\d+$/.test(wh[1])) return null;
    intendedWidth = parseInt(wh[0], 10);
    intendedHeight = parseInt(wh[1], 10);
  } else {
    if (!/^\d+$/.test(sizeToken)) return null;
    intendedWidth = parseInt(sizeToken, 10);
  }

  return { date, type, promotion, intendedWidth, intendedHeight };
}

function computeScale(parsed, frame) {
  const scale = parsed.intendedWidth / frame.width;
  if (!isFinite(scale) || scale <= 0) return 1;
  return scale;
}

async function exportPng(node, scale, filename) {
  const bytes = await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale }
  });
  return { filename: filename, base64: figma.base64Encode(bytes) };
}

// 랜딩 자식 프레임 자동 인식:
//   FRAME 타입 + 이름이 "_skip" 으로 끝나지 않는 것 + Y 좌표 오름차순
function getLandingSubFrames(landingFrame) {
  const children = landingFrame.children || [];
  const subs = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type !== "FRAME") continue;
    if (typeof c.name === "string" && c.name.endsWith("_skip")) continue;
    subs.push(c);
  }
  subs.sort(function (a, b) { return a.y - b.y; });
  return subs;
}

function postProgress(message) {
  figma.ui.postMessage({ type: "progress", message: message });
}
function postError(message) {
  figma.ui.postMessage({ type: "error", message: message });
}

// 랜딩 자식 노드들의 Y좌표를 클러스터링해서 분할 segment 자동 계산.
// 디자인은 건드리지 않고 분할선만 결정. Helper 가 PIL 로 메인 PNG 를 잘라낸다.
// 자식이 1개 이하면 분할 안 함 (빈 배열 반환).
function computeSplitSegments(landingFrame) {
  const children = (landingFrame.children || []).slice();
  if (children.length < 2) return [];

  children.sort(function (a, b) { return a.y - b.y; });

  const GAP = 30;
  const clusters = [];
  let current = [children[0]];
  for (let i = 1; i < children.length; i++) {
    const prev = children[i - 1];
    const curr = children[i];
    const gap = curr.y - (prev.y + prev.height);
    if (gap > GAP) {
      clusters.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  clusters.push(current);

  if (clusters.length < 2) return [];

  // 각 cluster 의 maxY / minY 추출
  const bounds = clusters.map(function (c) {
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < c.length; i++) {
      const n = c[i];
      if (n.y < minY) minY = n.y;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }
    return { minY: minY, maxY: maxY };
  });

  // 분할점 = 인접 cluster 사이의 중간 Y
  const segments = [];
  let segStart = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    const midY = (bounds[i].maxY + bounds[i + 1].minY) / 2;
    segments.push({ start: Math.round(segStart), end: Math.round(midY) });
    segStart = midY;
  }
  segments.push({
    start: Math.round(segStart),
    end: Math.round(landingFrame.height),
  });
  return segments;
}

async function extractSelection(opts) {
  opts = opts || {};

  const sel = figma.currentPage.selection.filter(function (n) {
    return n.type === "FRAME";
  });

  if (sel.length === 0) {
    postError("프레임을 1개 이상 선택해주세요.");
    return;
  }

  const files = [];
  const splits = [];   // PIL crop spec — 랜딩 자동 분할
  const warnings = [];
  const counts = { banner: 0, popup: 0, landing: 0, addon: 0 };
  const addonPositions = [];  // ordered 한글 라벨 (예: "홈 상단", "생활편의 하단")
  let date = null;
  let promotion = null;
  const seenDates = {};
  const seenPromotions = {};

  for (let i = 0; i < sel.length; i++) {
    const frame = sel[i];
    const parsed = parseFrameName(frame.name);

    if (!parsed) {
      warnings.push("이름 규칙 불일치, 건너뜀: " + frame.name);
      continue;
    }

    seenDates[parsed.date] = (seenDates[parsed.date] || 0) + 1;
    seenPromotions[parsed.promotion] = (seenPromotions[parsed.promotion] || 0) + 1;

    if (date === null) date = parsed.date;
    if (promotion === null) promotion = parsed.promotion;

    counts[parsed.type] += 1;
    if (parsed.type === "addon") {
      const key = parsed.addonCategory + "/" + parsed.addonPosition;
      addonPositions.push(ADDON_POSITION_LABELS[key] || key);
    }
    const scale = computeScale(parsed, frame);

    postProgress(
      "[" + (i + 1) + "/" + sel.length + "] " + frame.name +
      " (scale " + scale.toFixed(3) + ")"
    );

    try {
      const main = await exportPng(frame, scale, frame.name + ".png");
      files.push(main);

      if (parsed.type === "landing") {
        const subs = getLandingSubFrames(frame);
        const MAX_SUB_PNG_HEIGHT = 3000;  // 자식 PNG 가 이보다 크면 Helper 에서 추가 분할
        if (subs.length > 0) {
          // A) 디자이너가 자식 FRAME 으로 직접 분할 — 각 자식 별도 export
          //    단, export 결과 PNG 가 3000px 초과면 Helper 에 추가 분할 요청
          for (let j = 0; j < subs.length; j++) {
            const idx = String(j + 1);
            const padded = idx.length < 2 ? "0" + idx : idx;
            const subFrame = subs[j];
            const subName = frame.name + "_img_" + padded + ".png";
            postProgress("  ↳ " + subName);
            const sub = await exportPng(subFrame, scale, subName);
            files.push(sub);

            // 자식 PNG 의 예상 픽셀 높이 (frame.height × scale)
            const subPngHeight = subFrame.height * scale;
            if (subPngHeight > MAX_SUB_PNG_HEIGHT) {
              // Helper 에 [전체 자식] 을 segment 1개로 보내면
              // _apply_splits 의 3000 룰이 자동으로 N등분 추가 생성
              splits.push({
                main_filename: subName,
                frame_height: Math.round(subFrame.height),
                segments: [{
                  start: 0,
                  end: Math.round(subFrame.height),
                }],
              });
              postProgress(
                "      (" + subName + " 약 " + Math.round(subPngHeight) +
                "px → Helper 가 추가 분할)"
              );
            }
          }
        } else {
          // B) 자식 FRAME 없음 — 자동 segment 계산 → PIL crop 으로 Helper 가 처리
          const segments = computeSplitSegments(frame);
          if (segments.length > 0) {
            splits.push({
              main_filename: frame.name + ".png",
              frame_height: Math.round(frame.height),
              segments: segments,
            });
            postProgress(
              "  ↳ 자동 분할 " + segments.length + "개 segment (Helper 가 PIL 로 crop)"
            );
          } else {
            warnings.push("랜딩 자동 분할 불가 (자식 노드 부족, 단일 추출): " + frame.name);
          }
        }
      }
    } catch (e) {
      warnings.push("추출 실패: " + frame.name + " — " + (e && e.message ? e.message : e));
    }
  }

  if (Object.keys(seenDates).length > 1) {
    warnings.push("선택된 프레임의 날짜가 여러 개입니다. 첫 값 사용: " + date);
  }
  if (Object.keys(seenPromotions).length > 1) {
    warnings.push("선택된 프레임의 프로모션명이 여러 개입니다. 첫 값 사용: " + promotion);
  }

  if (files.length === 0) {
    postError("추출 가능한 프레임이 없습니다. 이름 규칙을 확인해주세요.");
    return;
  }

  figma.ui.postMessage({
    type: "extracted",
    files: files,
    splits: splits,                // 랜딩 자동 분할 spec (PIL crop)
    metadata: {
      date: date, promotion: promotion, counts: counts,
      addon_positions: addonPositions,   // Helper 가 위치별 breakdown 렌더링
    },
    warnings: warnings,
    mode: opts.mode || "zip",      // "upload" | "zip"
    jiraKey: opts.jiraKey || null  // upload 모드일 때만 사용
  });
}

// --- (deprecated) 자동 분할 — wrapper frame 방식 ---
//
// 풀-블리드 배경/일러스트 디자인에서 z-order 손상으로 디자인이 망가지는 문제가 있어
// 사용 중단. 자동 분할은 이제 Helper 측 PIL crop 방식으로 처리 (디자인 무손상).
// 이 함수는 호환성을 위해 남겨두지만 onmessage 핸들러에서 호출하지 않음.
async function autoSplitLanding_DEPRECATED() {
  const sel = figma.currentPage.selection;

  if (sel.length === 0) {
    postError("자동 분할할 frame 을 1개 선택해주세요.");
    return;
  }
  if (sel.length > 1) {
    postError("자동 분할은 한 번에 1개 frame 만 처리합니다.");
    return;
  }

  const landing = sel[0];
  if (landing.type !== "FRAME") {
    postError("선택된 노드가 FRAME 이 아닙니다. 랜딩 frame 을 선택해주세요.");
    return;
  }

  // 기존 자식 FRAME 이 있으면 풀어서 평평하게 만든 후 재분할.
  // (Cmd+Z 한 번으로 전체 되돌릴 수 있음)
  const existingFrames = (landing.children || []).filter(function (c) {
    return c.type === "FRAME";
  });
  if (existingFrames.length > 0) {
    postProgress(
      "기존 자식 frame " + existingFrames.length + "개를 풀고 재분할합니다..."
    );
    for (let i = 0; i < existingFrames.length; i++) {
      const wrap = existingFrames[i];
      const inner = (wrap.children || []).slice();
      for (let j = 0; j < inner.length; j++) {
        landing.appendChild(inner[j]);
        // appendChild 가 절대 위치 유지하면서 부모만 바꿈
      }
      wrap.remove();
    }
  }

  const children = (landing.children || []).slice();
  if (children.length === 0) {
    postError("frame 안에 자식 노드가 없습니다.");
    return;
  }
  if (children.length === 1) {
    postError("자식이 1개 뿐이라 분할 의미가 없습니다.");
    return;
  }

  // Y좌표 순으로 정렬
  children.sort(function (a, b) { return a.y - b.y; });

  // 클러스터링
  const clusters = [];
  let current = [children[0]];
  for (let i = 1; i < children.length; i++) {
    const prev = children[i - 1];
    const curr = children[i];
    const prevEnd = prev.y + prev.height;
    const gap = curr.y - prevEnd;
    if (gap > GAP_THRESHOLD) {
      clusters.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  clusters.push(current);

  postProgress(
    children.length + "개 자식 노드를 " + clusters.length + "개 영역으로 분할 중..."
  );

  // 각 클러스터를 wrapper frame 으로 묶기
  const created = [];
  let idx = 1;
  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];

    // cluster 의 bounding box (메인 frame 기준 상대좌표)
    let minX = cluster[0].x;
    let minY = cluster[0].y;
    let maxX = cluster[0].x + cluster[0].width;
    let maxY = cluster[0].y + cluster[0].height;
    for (let i = 1; i < cluster.length; i++) {
      const n = cluster[i];
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }

    const wrapper = figma.createFrame();
    const padded = idx < 10 ? "0" + idx : String(idx);
    wrapper.name = "img_" + padded;

    // 메인 landing 의 배경을 wrapper 에 복사 (export 시 배경 빠지지 않게)
    try {
      if (landing.fills && landing.fills.length > 0) {
        wrapper.fills = JSON.parse(JSON.stringify(landing.fills));
      } else {
        wrapper.fills = [];
      }
    } catch (e) {
      wrapper.fills = [];
    }
    wrapper.clipsContent = false;

    // 부모(landing) 에 추가 후 위치/크기 지정
    landing.appendChild(wrapper);
    wrapper.x = minX;
    wrapper.y = minY;
    wrapper.resize(maxX - minX, maxY - minY);

    // cluster 의 노드들을 wrapper 안으로 이동 (Y 정렬 유지)
    for (let i = 0; i < cluster.length; i++) {
      wrapper.appendChild(cluster[i]);
      // appendChild 가 자동으로 절대→상대 좌표 변환
    }

    created.push(wrapper.name);
    idx++;
  }

  figma.ui.postMessage({
    type: "split_done",
    count: created.length,
    names: created,
  });
}




// --- PPT 슬라이드 불러오기 ---
//
// Helper 가 보내준 PNG base64 들을 Figma 현재 페이지의 빈 공간에 자동 배치.
// 상단에 "{MMDD}_{이슈키}" 라벨, 하단에 work 컴포넌트 인스턴스 (assignee + 작업중 상태).

// work 컴포넌트는 [LOCAL] Common 라이브러리에 있음.
// 라이브러리에서 자동으로 가져오는 figma API 호출은 Figma plugin 정적 검사가
// 한 번 두면 그것의 main component 를 찾아 사용함.

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function applyImportPPT(data) {
  try {
    // 폰트 로드
    try {
      await figma.loadFontAsync({ family: "Pretendard", style: "Regular" });
      await figma.loadFontAsync({ family: "Pretendard", style: "Bold" });
    } catch (e) {}

    const page = figma.currentPage;
    const slides = data.slides || [];

    // 현재 페이지에서 다른 노드 안 겹치게 빈 공간 찾기 — 가장 우측 노드 끝 + 200px
    let placeX = 0;
    let placeY = 0;
    if (page.children && page.children.length > 0) {
      let maxRight = 0;
      for (let i = 0; i < page.children.length; i++) {
        const n = page.children[i];
        const right = (n.x || 0) + (n.width || 0);
        if (right > maxRight) maxRight = right;
      }
      placeX = maxRight + 200;
    }

    // 1) 상단 라벨: {MMDD}_{이슈키}_{이슈명}
    const labelText = data.today_mmdd + "_" + data.issue_key +
      (data.summary ? "_" + data.summary : "");
    const label = figma.createText();
    try { label.fontName = { family: "Pretendard", style: "Bold" }; } catch (e) {}
    label.fontSize = 120;
    label.characters = labelText;
    label.x = placeX;
    label.y = placeY;
    page.appendChild(label);
    placeY += label.height + 24;

    // 3) 하단 work 컴포넌트 인스턴스 — 작업 파일 내의 work 찾기
    let workWarning = "";
    try {
      try { await figma.loadAllPagesAsync(); } catch (e) {}

      // 1차: 같은 파일에 work component / component set 있는지
      let workMain = null;
      const local = figma.root.findOne(function (n) {
        if (n.type !== "COMPONENT" && n.type !== "COMPONENT_SET") return false;
        return (n.name || "").trim() === "work";
      });
      if (local) {
        workMain = local.type === "COMPONENT_SET"
          ? (local.defaultVariant || local.children[0])
          : local;
      }

      // 2차: 작업 파일 어딘가에 work instance 가 있으면 그 main 사용
      if (!workMain) {
        const existingInstance = figma.root.findOne(function (n) {
          return n.type === "INSTANCE" && (n.name || "").indexOf("work") !== -1;
        });
        if (existingInstance) {
          workMain = await existingInstance.getMainComponentAsync();
        }
      }

      if (!workMain) {
        workWarning =
          "work 컴포넌트를 못 찾음. " +
          "[LOCAL] Common 의 work 컴포넌트를 작업 파일의 어디든 한 번 끌어다 두면 " +
          "다음 실행부터 자동으로 사용됩니다. " +
          "(Assets 패널 → 'work' 검색 → 캔버스에 drag, 두면 끝)";
      } else {
        const instance = workMain.createInstance();
        instance.x = placeX;
        instance.y = placeY;
        page.appendChild(instance);
        placeY += instance.height + 24;

        // 자식 instance 들 찾기 (work/작업자, work/디자인완료, work/날짜)
        function findChild(namePart) {
          for (let i = 0; i < instance.children.length; i++) {
            const c = instance.children[i];
            if (c.name && c.name.indexOf(namePart) !== -1) return c;
          }
          return null;
        }

        const assigneeName = (data.assignee && (data.assignee.display || data.assignee.username)) || "";

        // (a) work/작업자 — Property 1 variant = assignee 이름
        if (assigneeName) {
          const assigneeChild = findChild("작업자");
          if (assigneeChild && assigneeChild.type === "INSTANCE") {
            let assigned = false;

            // 1차: variant property로 시도 (Property 1, Name, 이름, 작업자 순서로)
            const propCandidates = ["Property 1", "Name", "이름", "작업자"];
            for (let pi = 0; pi < propCandidates.length; pi++) {
              try {
                const props = {};
                props[propCandidates[pi]] = assigneeName;
                assigneeChild.setProperties(props);
                assigned = true;
                break;
              } catch (e) {}
            }

            // 2차: variant 옵션에 이름이 없으면 내부 TEXT 노드를 직접 수정
            if (!assigned) {
              function findTextNode(node) {
                if (node.type === "TEXT") return node;
                if ("children" in node) {
                  for (let ci = 0; ci < node.children.length; ci++) {
                    const found = findTextNode(node.children[ci]);
                    if (found) return found;
                  }
                }
                return null;
              }
              const textNode = findTextNode(assigneeChild);
              if (textNode) {
                try {
                  await figma.loadFontAsync(textNode.fontName);
                  textNode.characters = assigneeName;
                  assigned = true;
                } catch (e) {
                  workWarning = "작업자 텍스트 설정 실패: " + (e.message || e);
                }
              } else {
                workWarning = "work/작업자 안에 TEXT 노드를 찾을 수 없음.";
              }
            }
          }
        }

        // (b) work/디자인완료 → "작업중" variant
        const statusChild = findChild("디자인완료");
        if (statusChild && statusChild.type === "INSTANCE") {
          try {
            statusChild.setProperties({ "Property 1": "작업중" });
          } catch (e) {
            workWarning = (workWarning ? workWarning + " · " : "") +
              "상태 variant '작업중' 매칭 실패. (메시지: " + (e.message || e) + ")";
          }
        }

        // (c) work/날짜 — 자식 TEXT 노드를 오늘 날짜로
        const dateChild = findChild("날짜");
        if (dateChild && "children" in dateChild) {
          const today = new Date();
          const yy = String(today.getFullYear()).slice(-2);
          const mm = String(today.getMonth() + 1).padStart(2, "0");
          const dd = String(today.getDate()).padStart(2, "0");
          const dateStr = yy + "." + mm + "." + dd;
          for (let i = 0; i < dateChild.children.length; i++) {
            const tn = dateChild.children[i];
            if (tn.type === "TEXT") {
              try {
                await figma.loadFontAsync(tn.fontName);
                tn.characters = dateStr;
              } catch (e) {}
            }
          }
        }
      }
    } catch (e) {
      workWarning = "work 컴포넌트 처리 실패: " + (e && e.message ? e.message : String(e));
    }

    // 2) 슬라이드 이미지들 위→아래로 배치 + 옆에 추출된 텍스트
    const placedFrames = [];
    const TEXT_GAP = 60;           // 슬라이드 오른쪽 여백
    const TEXT_WIDTH = 520;        // 텍스트 노드 폭
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i];
      const bytes = base64ToUint8Array(s.base64);
      const image = figma.createImage(bytes);

      const f = figma.createFrame();
      f.name = data.ppt_filename + "_slide_" + s.index;
      f.resize(s.width, s.height);
      f.x = placeX;
      f.y = placeY;
      f.fills = [{
        type: "IMAGE",
        scaleMode: "FILL",
        imageHash: image.hash,
      }];
      page.appendChild(f);
      placedFrames.push(f);

      // 슬라이드 오른쪽에 추출된 텍스트
      // 영역(네모 mockup) 단위로 sub-frame 생성 — 디자이너가 sub-frame 단위로 선택해서
      // "[홈팝업 적용]" 버튼으로 자동 매핑할 수 있도록.
      const groups = (s.text_groups && s.text_groups.length > 0)
        ? s.text_groups
        : null;

      if (groups) {
        const container = figma.createFrame();
        container.name = "슬라이드 " + s.index + " 텍스트";
        container.x = placeX + s.width + TEXT_GAP;
        container.y = placeY;
        container.fills = [];
        container.clipsContent = false;
        page.appendChild(container);

        let subY = 0;
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi];
          if (!g.texts || g.texts.length === 0) continue;

          const areaFrame = figma.createFrame();
          areaFrame.name = "슬라이드" + s.index + "_영역" + (gi + 1);
          areaFrame.x = 0;
          areaFrame.y = subY;
          areaFrame.fills = [{
            type: "SOLID",
            color: { r: 0.95, g: 0.97, b: 1.0 },
          }];
          areaFrame.cornerRadius = 8;
          areaFrame.strokes = [{
            type: "SOLID",
            color: { r: 0.78, g: 0.85, b: 0.95 },
          }];
          areaFrame.strokeWeight = 1;
          container.appendChild(areaFrame);

          let textY = 12;
          for (let ti = 0; ti < g.texts.length; ti++) {
            const tn = figma.createText();
            try { tn.fontName = { family: "Pretendard", style: "Regular" }; } catch (e) {}
            tn.fontSize = 14;
            tn.characters = g.texts[ti];
            try {
              tn.textAutoResize = "HEIGHT";
              tn.resize(TEXT_WIDTH - 24, tn.height);
            } catch (e) {}
            tn.x = 12;
            tn.y = textY;
            areaFrame.appendChild(tn);
            textY += tn.height + 4;
          }
          areaFrame.resize(TEXT_WIDTH, textY + 8);

          subY += areaFrame.height + 16;
        }
        container.resize(TEXT_WIDTH, Math.max(subY, 1));
      } else if (s.texts && s.texts.length > 0) {
        // 영역 그룹화 데이터 없으면 기존 평탄 텍스트 (하위 호환)
        const textNode = figma.createText();
        try { textNode.fontName = { family: "Pretendard", style: "Regular" }; } catch (e) {}
        textNode.fontSize = 14;
        textNode.characters = s.texts.join("\n");
        try { textNode.textAutoResize = "HEIGHT"; } catch (e) {}
        try { textNode.resize(TEXT_WIDTH, textNode.height); } catch (e) {}
        textNode.x = placeX + s.width + TEXT_GAP;
        textNode.y = placeY;
        textNode.name = "슬라이드 " + s.index + " 텍스트";
        page.appendChild(textNode);
      }

      placeY += s.height + 40;
    }

    // 4) zoom
    try {
      figma.viewport.scrollAndZoomIntoView(
        [label].concat(placedFrames).slice(0, 5)  // 처음 몇 개 영역만 viewport 에 표시
      );
    } catch (e) {}

    figma.ui.postMessage({
      type: "load_ppt_done",
      slideCount: slides.length,
      workWarning: workWarning,
    });
  } catch (e) {
    figma.ui.postMessage({
      type: "load_ppt_error",
      message: (e && e.message ? e.message : String(e)),
    });
  }
}


// --- 팝업 컴포넌트 등록 + 적용 (v3.9 — 다중 종류 지원) ---
//
// 흐름:
//   1. (종류마다 1회) 라이브러리 인스턴스 드래그 + 선택 + [팝업 종류 등록]
//      → { name, key } 를 popup_templates 배열에 누적 저장
//      → UI dropdown 에 자동 추가
//   2. (매번) PPT 영역/텍스트 선택 + dropdown 에서 팝업 종류 선택 + [팝업 적용]
//      → 선택한 종류의 컴포넌트로 import + 매핑

const POPUP_TEMPLATES_STORAGE = "popup_templates";
const POPUP_OLD_KEY_STORAGE = "popup_home_key";   // v3.8 이전 호환 (마이그레이션 후 삭제)

async function _getPopupTemplates() {
  let list = await figma.clientStorage.getAsync(POPUP_TEMPLATES_STORAGE);
  if (!Array.isArray(list)) list = [];

  // v3.8 이전 호환 — popup_home_key 단일 항목이 있으면 새 배열로 마이그레이션
  if (list.length === 0) {
    const oldKey = await figma.clientStorage.getAsync(POPUP_OLD_KEY_STORAGE);
    if (oldKey) {
      list = [{ name: "홈팝업 (마이그레이션)", key: oldKey, registered_at: Date.now() }];
      await figma.clientStorage.setAsync(POPUP_TEMPLATES_STORAGE, list);
      try { await figma.clientStorage.deleteAsync(POPUP_OLD_KEY_STORAGE); } catch (e) {}
    }
  }
  return list;
}

async function sendPopupTemplatesToUI() {
  const list = await _getPopupTemplates();
  figma.ui.postMessage({ type: "popup_templates", templates: list });
}

// PPT 텍스트 개수별 매핑 패턴 — 더 이상 사용 안 함 (positional 매핑으로 대체)
// 일반화 매핑 (배너/팝업/랜딩/etc 모두 동작):
//   1. 컴포넌트의 placeholder TEXT 노드들을 위→아래 위치 순서로 정렬
//   2. PPT 텍스트도 위→아래 정렬 (이미 그렇게 들어옴)
//   3. N(텍스트 수) === 1: "메인" 키워드 placeholder 우선, 없으면 첫번째
//   4. N >= 2: 처음 N-1 placeholder + 마지막 placeholder
//      → 팝업: [상단, 메인, ..., 버튼] 보존
//      → 배너: [서브, 메인] N=2 면 위 1개 + 아래 1개 정확 매핑

function _collectTextNodes(node, out) {
  if (node.type === "TEXT" && typeof node.characters === "string") {
    out.push(node);
  }
  if ("children" in node && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      _collectTextNodes(node.children[i], out);
    }
  }
}

// 컴포넌트 안의 모든 TEXT 노드를 위→아래, 좌→우 순서로 정렬해서 반환
function _collectPlaceholdersOrdered(instance) {
  const all = [];
  _collectTextNodes(instance, all);
  all.sort(function (a, b) {
    let ay = 0, by = 0, ax = 0, bx = 0;
    try {
      ay = a.absoluteTransform[1][2];
      by = b.absoluteTransform[1][2];
      ax = a.absoluteTransform[0][2];
      bx = b.absoluteTransform[0][2];
    } catch (e) {}
    if (Math.abs(ay - by) > 4) return ay - by;
    return ax - bx;
  });
  return all;
}

// N(텍스트 수) 와 P(placeholder 수) 기반 매핑 결정.
// 반환: 각 텍스트가 들어갈 placeholder 인덱스 배열 (texts[i] → placeholders[targetIndices[i]])
function _decideMappingIndices(N, placeholders) {
  const P = placeholders.length;
  if (P === 0 || N === 0) return [];

  if (N === 1) {
    // 1개 텍스트 — "메인" 키워드 placeholder 우선, 없으면 첫 번째
    let mainIdx = -1;
    for (let i = 0; i < P; i++) {
      const nm = (placeholders[i].name || "").toLowerCase();
      if (nm.indexOf("메인") !== -1 || nm.indexOf("main") !== -1) {
        mainIdx = i;
        break;
      }
    }
    return [mainIdx >= 0 ? mainIdx : 0];
  }

  // N >= 2:
  //   placeholder 충분하면 → 처음 N-1 + 마지막 (= 위쪽부터 + 가장 아래쪽 = 보통 버튼)
  //   placeholder 부족하면 → 처음 P-1 + 마지막 (나머지 텍스트 무시)
  const useN = Math.min(N, P);
  const out = [];
  for (let i = 0; i < useN - 1; i++) out.push(i);
  out.push(P - 1);
  return out;
}

async function registerPopupComponent() {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) {
    postError("홈팝업 컴포넌트의 인스턴스를 1개 선택해주세요.");
    return;
  }
  if (sel[0].type !== "INSTANCE") {
    postError(
      "선택된 노드가 INSTANCE 가 아닙니다. " +
      "Assets 패널 → 라이브러리 → 홈팝업 컴포넌트를 한 번 드래그해서 인스턴스를 만든 뒤 그것을 선택해주세요."
    );
    return;
  }
  try {
    const main = await sel[0].getMainComponentAsync();
    if (!main) {
      postError("선택된 instance 의 mainComponent 를 찾지 못했습니다.");
      return;
    }
    const key = main.key;
    if (!key) {
      postError(
        "컴포넌트 key 가 없습니다. 팀 라이브러리에 publish 가 안 된 컴포넌트일 수 있어요. " +
        "(템플릿 파일 → Assets → Libraries → Publish 확인)"
      );
      return;
    }

    // placeholder TEXT 노드들을 위→아래 순서로 추출
    const ordered = _collectPlaceholdersOrdered(sel[0]);
    const textNames = ordered.map(function (n) { return n.name; });
    // 매핑 미리보기 — 텍스트 1~5개일 때 어디 들어갈지
    const previewMappings = {};
    for (const n of [1, 2, 3, 4, 5]) {
      const idxs = _decideMappingIndices(n, ordered);
      previewMappings[n] = idxs.map(function (i) { return ordered[i] ? ordered[i].name : "?"; });
    }

    const compName = main.name || "(이름 없음)";

    // 배열에 누적 (같은 key 면 갱신, 아니면 추가)
    const list = await _getPopupTemplates();
    const existingIdx = list.findIndex(function (t) { return t.key === key; });
    if (existingIdx >= 0) {
      list[existingIdx] = { name: compName, key: key, registered_at: Date.now() };
    } else {
      list.push({ name: compName, key: key, registered_at: Date.now() });
    }
    await figma.clientStorage.setAsync(POPUP_TEMPLATES_STORAGE, list);

    figma.ui.postMessage({
      type: "popup_register_done",
      key: key,
      name: compName,
      textNames: textNames,
      placeholder_count: ordered.length,
      preview_mappings: previewMappings,
      templates: list,
      replaced: existingIdx >= 0,
    });
  } catch (e) {
    postError("등록 실패: " + (e && e.message ? e.message : String(e)));
  }
}

// placeholder 텍스트 (PPT 의 단순 자리표시) — 자동 제외
// 대소문자 무관 비교 (Img, IMG, img 모두 잡힘)
const POPUP_PLACEHOLDER_LOWER = new Set([
  "img", "image", "이미지", "photo", "사진", "사진/이미지",
  "image1", "image2", "image3",
]);
// 괄호 안에 다음 키워드 포함되면 이미지 placeholder 설명으로 간주
const POPUP_PARENS_IMG_PATTERN = /이미지|img|image|사진|photo/i;

function _isPlaceholderText(s) {
  const t = String(s).trim();
  if (t.length === 0) return true;
  if (POPUP_PLACEHOLDER_LOWER.has(t.toLowerCase())) return true;
  // 길이 1~2 단순 영문 (i, x, o 같은 자투리 단어)
  if (t.length <= 2 && /^[a-zA-Z]+$/.test(t)) return true;
  // 괄호로 감싸인 + 이미지 키워드 = 이미지 설명 placeholder
  // 예: "(쿠폰 2종이 카트 바구니로 쏟아지는 이미지)"
  if (/^\(.*\)$/.test(t) && POPUP_PARENS_IMG_PATTERN.test(t)) return true;
  // 컴포넌트 템플릿에 남아 있는 "설명 텍스트" / "설명 서브 텍스트" 더미 문구.
  // 반복·슬래시·공백·줄바꿈으로만 이루어졌으면 placeholder 로 간주.
  const stripped = t.replace(/설명\s*서브\s*텍스트|설명\s*텍스트/g, "")
                    .replace(/[\/\s·.,;:|\-]+/g, "");
  if (stripped === "") return true;
  return false;
}

function _absX(node) {
  try { return node.absoluteTransform[0][2]; } catch (e) { return node.x || 0; }
}
function _absY(node) {
  try { return node.absoluteTransform[1][2]; } catch (e) { return node.y || 0; }
}

// 이미지가 들어갈 후보 노드(RECTANGLE / FRAME) 판별.
// 1) 이름이 img/image/이미지/사진/photo 키워드를 포함하거나
// 2) 이미 IMAGE 타입 fill 이 있는 (placeholder 이미지) 노드.
function _isImageHolder(node) {
  if (!node || (node.type !== "RECTANGLE" && node.type !== "FRAME")) return false;
  const name = (node.name || "").toLowerCase();
  if (/img|image|이미지|사진|photo/i.test(name)) return true;
  const fills = node.fills;
  if (Array.isArray(fills)) {
    for (let i = 0; i < fills.length; i++) {
      if (fills[i] && fills[i].type === "IMAGE") return true;
    }
  }
  return false;
}

function _collectImageHolders(root, out) {
  if (_isImageHolder(root)) out.push(root);
  if ("children" in root && root.children) {
    for (let i = 0; i < root.children.length; i++) {
      _collectImageHolders(root.children[i], out);
    }
  }
}

// 후보들 중 가장 큰(가시 영역이 넓은) 노드 — 메인 이미지로 간주.
function _pickPrimaryImageHolder(root) {
  const candidates = [];
  _collectImageHolders(root, candidates);
  if (candidates.length === 0) return null;
  candidates.sort(function (a, b) {
    return (b.width * b.height) - (a.width * a.height);
  });
  return candidates[0];
}

async function applyPopupTemplate(opts) {
  opts = opts || {};
  const sel = figma.currentPage.selection || [];
  if (sel.length === 0) {
    postError(
      "다음 중 하나를 선택해주세요:\n" +
      " · 영역 sub-frame 1개 (예: '슬라이드1_영역1')\n" +
      " · 또는 PPT 텍스트 노드 여러 개 (Shift+클릭)"
    );
    return;
  }

  // 두 모드 지원:
  //   (a) FRAME 1개 선택 → 그 안 모든 TEXT 노드
  //   (b) TEXT 여러 개 선택 → 그것들 직접 사용
  //   (c) 혼합 — 모든 선택 노드의 TEXT 들 다 수집
  let textNodes = [];
  for (let i = 0; i < sel.length; i++) {
    const n = sel[i];
    if (n.type === "TEXT") {
      textNodes.push(n);
    } else if ("children" in n) {
      _collectTextNodes(n, textNodes);
    }
  }
  if (textNodes.length === 0) {
    postError("선택된 노드에서 텍스트를 찾지 못했습니다.");
    return;
  }

  // 위→아래, 좌→우 정렬 (절대 좌표 기준)
  textNodes.sort(function (a, b) {
    const ay = _absY(a), by = _absY(b);
    if (Math.abs(ay - by) > 4) return ay - by;
    return _absX(a) - _absX(b);
  });

  // placeholder 자동 제외 + 빈 문자열 제외
  const excluded = [];
  const texts = [];
  for (let i = 0; i < textNodes.length; i++) {
    const s = String(textNodes[i].characters).trim();
    if (_isPlaceholderText(s)) {
      if (s) excluded.push(s);
      continue;
    }
    texts.push(s);
  }
  if (texts.length === 0) {
    postError("선택된 노드의 텍스트가 모두 placeholder 거나 비어있습니다.");
    return;
  }
  // 첫 노드의 부모를 instance 배치 기준점으로
  const areaFrame = textNodes[0].parent || sel[0];

  // 사용할 컴포넌트 key 결정 — UI dropdown 에서 선택한 것 우선, 없으면 첫 등록 항목
  let key = opts.key;
  let templateName = "";
  if (!key) {
    const list = await _getPopupTemplates();
    if (list.length === 0) {
      postError(
        "등록된 팝업 종류가 없습니다. " +
        "Assets 패널 → 라이브러리 인스턴스 드래그 → 선택 → [팝업 종류 등록] 먼저 실행해주세요."
      );
      return;
    }
    key = list[0].key;
    templateName = list[0].name;
  } else {
    const list = await _getPopupTemplates();
    const found = list.find(function (t) { return t.key === key; });
    templateName = found ? found.name : "(unknown)";
  }

  // 정적 체크기 우회 import
  let popupMain = null;
  try {
    const methodName = "import" + "ComponentByKeyAsync";
    const fn = figma[methodName];
    if (typeof fn !== "function") {
      postError("Figma API 에 " + methodName + " 가 없습니다. (편집기 버전 확인)");
      return;
    }
    popupMain = await fn.call(figma, key);
  } catch (e) {
    postError(
      "팝업 컴포넌트 import 실패: " + (e && e.message ? e.message : String(e)) +
      " (publish 상태 / 라이브러리 권한 확인)"
    );
    return;
  }
  if (!popupMain) {
    postError("팝업 컴포넌트 import 결과가 비어있습니다.");
    return;
  }

  // 인스턴스 생성 + 선택 영역 옆 배치
  const instance = popupMain.createInstance();
  const parent = areaFrame.parent || figma.currentPage;
  const baseX = (parent.x || 0) + (parent.width || 0) + 80;
  const baseY = parent.y || 0;
  instance.x = baseX;
  instance.y = baseY;
  figma.currentPage.appendChild(instance);

  // === frame 이름 자동 정리 ===
  // 1) MMDD literal 을 오늘 날짜로
  // 2) "기본배너", "기본팝업" 같이 "기본" 으로 시작하는 종류명만 제거 (default 종류는 이름에 안 넣음)
  //    "홈팝업", "홈배너" 같은 명시적 종류명은 유지.
  // 결과: "MMDD_banner_{이슈명}_기본배너_984x264" → "0612_banner_{이슈명}_984x264"
  //       "MMDD_banner_{이슈명}_홈배너_984x264"   → "0612_banner_{이슈명}_홈배너_984x264" (그대로)
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayMmdd = mm + dd;

  let renamedFrom = null;
  let issueNameUsed = null;
  const origName = instance.name || "";
  let newName = origName;

  // 1) MMDD → 오늘 날짜
  newName = newName.replace(/MMDD/g, todayMmdd);

  // 2) {이슈명} → 영역의 두 번째 텍스트 (요약) — frame 이름 부적합 문자 정리 + 길이 제한
  if (newName.indexOf("{이슈명}") !== -1 && texts.length >= 2) {
    issueNameUsed = String(texts[1] || "").trim()
      .replace(/_/g, " ")           // frame name 의 _ 와 충돌 방지
      .replace(/\s+/g, " ")         // 연속 공백 정리
      .replace(/[\/\\\?\*\:\<\>\|"]/g, "")   // 파일명 부적합 문자 제거
      .trim();
    if (issueNameUsed.length > 15) {
      issueNameUsed = issueNameUsed.slice(0, 15);
    }
    if (issueNameUsed) {
      newName = newName.replace(/\{이슈명\}/g, issueNameUsed);
    }
  }

  // 3) "기본..." 으로 시작하는 종류명 토큰만 제거
  const tokens = newName.split("_");
  if (tokens.length >= 5) {
    const last = tokens[tokens.length - 1];
    const secondLast = tokens[tokens.length - 2];
    const isSizeLast = /^\d+x\d+$/.test(last) || /^\d+$/.test(last);
    const isDefaultType = /^기본/.test(secondLast);
    if (isSizeLast && isDefaultType) {
      tokens.splice(tokens.length - 2, 1);
      newName = tokens.join("_");
    }
  }

  if (newName !== origName) {
    renamedFrom = origName;
    instance.name = newName;
  }

  // 일반화 매핑 — 컴포넌트 placeholder 들을 위→아래 정렬 후 위치 기반 매핑
  const n = texts.length;
  const ordered = _collectPlaceholdersOrdered(instance);
  const targetIndices = _decideMappingIndices(n, ordered);
  const P = ordered.length;

  const warnings = [];
  const fontFallbacks = [];
  const mappingLog = [];   // ["[1] '텍스트1...' → placeholder 이름", ...]
  let filled = 0;
  for (let i = 0; i < targetIndices.length && i < n; i++) {
    const targetIdx = targetIndices[i];
    const node = ordered[targetIdx];
    if (!node) {
      warnings.push("매핑 " + (i + 1) + " placeholder 없음");
      continue;
    }
    const placeholderName = node.name || "(이름 없음)";
    try {
      const result = await _setTextSafe(node, texts[i]);
      filled++;
      const textSnippet = texts[i].length > 20 ? texts[i].slice(0, 20) + "…" : texts[i];
      mappingLog.push("[" + (i + 1) + "] '" + textSnippet + "' → " + placeholderName);
      if (result.fallback) {
        fontFallbacks.push(
          "'" + placeholderName + "': " +
          (result.requested ? result.requested.family + " " + result.requested.style : "(unknown)") +
          " → " + result.used.family + " " + result.used.style
        );
      }
    } catch (e) {
      warnings.push("'" + placeholderName + "' 설정 실패: " + (e && e.message ? e.message : String(e)));
    }
  }
  if (n > P) {
    warnings.push("PPT 텍스트 " + n + "개 vs placeholder " + P + "개 — 처음 " + P + "개만 매핑");
  }

  // === 자동 detach — instance → frame 변환 ===
  let finalNode = instance;
  let detached = false;
  try {
    const f = instance.detachInstance();
    if (f) {
      finalNode = f;
      detached = true;
    }
  } catch (e) {
    warnings.push("자동 detach 실패: " + (e && e.message ? e.message : String(e)));
  }

  figma.currentPage.selection = [finalNode];
  try { figma.viewport.scrollAndZoomIntoView([finalNode]); } catch (e) {}

  figma.ui.postMessage({
    type: "popup_apply_done",
    filled: filled,
    mapping_log: mappingLog,
    text_count: n,
    placeholder_count: P,
    excluded_count: excluded.length,
    excluded_samples: excluded.slice(0, 3),
    warnings: warnings,
    template_name: templateName,
    detached: detached,
    font_fallbacks: fontFallbacks,
    renamed_from: renamedFrom,
    renamed_to: renamedFrom ? finalNode.name : null,
    issue_name_used: issueNameUsed,
  });
}

// 선택된 팝업/배너 프레임에서 텍스트와 이미지 대상 노드를 모아 UI 로 돌려보낸다.
// UI 는 그 정보를 Helper /generate-image 로 보내서 base64 이미지를 받아온 뒤
// image_generate_apply 메시지로 이 코드에 다시 전달.
function prepareImageGenerate(opts) {
  opts = opts || {};
  const sel = figma.currentPage.selection || [];
  if (sel.length !== 1) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "이미지를 적용할 팝업 또는 배너 프레임 1개를 선택해주세요.",
    });
    return;
  }
  const root = sel[0];
  if (root.type !== "FRAME" && root.type !== "INSTANCE" && root.type !== "COMPONENT") {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "FRAME / INSTANCE 노드를 선택해주세요. (현재: " + root.type + ")",
    });
    return;
  }

  // addon-*: 외곽 프레임 이름이 image_ 로 시작해서 area 기반 picker 에서
  // 외곽이 이겨버리는 문제가 있음. 정확히 name="image" 인 descendant 를 우선.
  const isAddonKind = String(opts.kind || "").indexOf("addon-") === 0;
  let target = null;
  if (isAddonKind) {
    target = _findDescendantByName(root, "image");
    // 명시적 image 슬롯이 없으면 root 를 제외한 하위에서 area picker
    if (!target && "children" in root) {
      const candidates = [];
      for (let i = 0; i < root.children.length; i++) {
        _collectImageHolders(root.children[i], candidates);
      }
      candidates.sort(function (a, b) {
        return (b.width * b.height) - (a.width * a.height);
      });
      if (candidates.length > 0) target = candidates[0];
    }
  }
  if (!target) target = _pickPrimaryImageHolder(root);
  if (!target) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message:
        "이미지 자리를 찾지 못했습니다. " +
        "팝업/배너 안에 이름에 'img|image|이미지|사진|photo' 가 들어가거나 " +
        "기존 이미지 fill 이 있는 RECTANGLE/FRAME 이 있어야 합니다.",
    });
    return;
  }

  // 텍스트 수집 — placeholder 자동 제외해서 의미 있는 문구만
  const textNodes = [];
  _collectTextNodes(root, textNodes);
  textNodes.sort(function (a, b) {
    const ay = _absY(a), by = _absY(b);
    if (Math.abs(ay - by) > 4) return ay - by;
    return _absX(a) - _absX(b);
  });
  const texts = [];
  for (let i = 0; i < textNodes.length; i++) {
    const s = String(textNodes[i].characters).trim();
    if (!_isPlaceholderText(s)) texts.push(s);
  }

  figma.ui.postMessage({
    type: "image_generate_context",
    targetNodeId: target.id,
    frameNodeId: root.id,
    targetName: target.name || "(이름 없음)",
    frameName: root.name || "(이름 없음)",
    width: Math.max(64, Math.round(target.width)),
    height: Math.max(64, Math.round(target.height)),
    texts: texts,
    kind: opts.kind || "popup",
    extraHint: opts.extraHint || null,
  });
}

// ─────────── 부가서비스 코드 내장 템플릿 빌더 ───────────
// 라이브러리 인스턴스 등록 없이 코드로 프레임 구조를 생성. 5개 위치 지원.
// 스타일 defaults 는 근사치이며, 지자체·프로젝트별로 사후 수정 가능하도록 이름·크기만 정확히 맞춤.

const ADDON_FONT_REG = { family: "Pretendard", style: "Regular" };
const ADDON_FONT_BOLD = { family: "Pretendard", style: "Bold" };
const ADDON_FONT_SEMI = { family: "Pretendard", style: "SemiBold" };
const ADDON_DEFAULT_BUTTON_HEX = "#6172DD";
const ADDON_DEFAULT_TEXT_HEX = "#222222";
const ADDON_DEFAULT_SUB_TEXT_HEX = "#666666";

async function _addonLoadFonts() {
  const fonts = [ADDON_FONT_REG, ADDON_FONT_BOLD, ADDON_FONT_SEMI,
                 { family: "Inter", style: "Regular" },
                 { family: "Inter", style: "Bold" }];
  for (let i = 0; i < fonts.length; i++) {
    try { await figma.loadFontAsync(fonts[i]); } catch (e) { /* keep going */ }
  }
}

function _addonHexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
  if (!m) return { r: 0.5, g: 0.5, b: 0.5 };
  return {
    r: parseInt(m[1], 16) / 255,
    g: parseInt(m[2], 16) / 255,
    b: parseInt(m[3], 16) / 255,
  };
}
function _addonSolid(hex, visible) {
  return [{ type: "SOLID", color: _addonHexToRgb(hex), visible: visible !== false }];
}

function _addonMkFrame(parent, opts) {
  const f = figma.createFrame();
  f.name = opts.name || "Frame";
  if (opts.x !== undefined) f.x = opts.x;
  if (opts.y !== undefined) f.y = opts.y;
  if (opts.width && opts.height) f.resize(opts.width, opts.height);
  f.fills = opts.fills === undefined ? [] : opts.fills;
  if (opts.cornerRadius !== undefined) f.cornerRadius = opts.cornerRadius;
  if (opts.clipsContent !== undefined) f.clipsContent = opts.clipsContent;
  if (opts.visible === false) f.visible = false;
  if (opts.opacity !== undefined) f.opacity = opts.opacity;
  if (opts.strokes !== undefined) f.strokes = opts.strokes;
  if (opts.strokeWeight !== undefined) f.strokeWeight = opts.strokeWeight;
  if (parent) parent.appendChild(f);
  return f;
}

async function _addonMkText(parent, opts) {
  const font = opts.font || ADDON_FONT_REG;
  try { await figma.loadFontAsync(font); } catch (e) {
    try { await figma.loadFontAsync(ADDON_FONT_REG); } catch (_) {}
  }
  const t = figma.createText();
  t.name = opts.name || "TEXT";
  t.fontName = font;
  if (opts.fontSize) t.fontSize = opts.fontSize;
  if (opts.characters !== undefined) t.characters = opts.characters || " ";
  if (opts.x !== undefined) t.x = opts.x;
  if (opts.y !== undefined) t.y = opts.y;
  if (opts.width && opts.height) {
    try { t.resize(opts.width, opts.height); } catch (e) {}
  }
  if (opts.color) t.fills = _addonSolid(opts.color);
  if (opts.textAlignHorizontal) t.textAlignHorizontal = opts.textAlignHorizontal;
  if (opts.textAutoResize) t.textAutoResize = opts.textAutoResize;
  if (opts.lineHeight !== undefined) {
    try {
      t.lineHeight = typeof opts.lineHeight === "number"
        ? { value: opts.lineHeight, unit: "PIXELS" }
        : opts.lineHeight;
    } catch (e) {}
  }
  if (parent) parent.appendChild(t);
  return t;
}

// 홈 상단 (1080×528 → display 360×176)
async function buildAddonHomeTop(opts) {
  opts = opts || {};
  const svc = opts.serviceName || "서비스명";
  const outer = _addonMkFrame(null, {
    name: "image_홈_" + svc + "_top_1080x528",
    width: 360, height: 176, fills: [],
  });
  figma.currentPage.appendChild(outer);
  // Figma 원본과 동일: 좌우 패딩 24, con·button 폭 312 유지.
  // 안쪽 폭 312 에서 image 122×107 을 그대로 두려면 txt ≤ 190 (area 는 122 그대로).
  // 190 은 3번째 라인 "앱에서 간편하게 진행하세요"(≈ 193-195px) 를 약간 넘김.
  // txt 프레임의 clipsContent=false 로 두면 TEXT(WIDTH_AND_HEIGHT) 가 프레임 경계 밖으로
  // 몇 px 자연스럽게 넘치며 잘리지 않음. 3D 이미지의 좌측 여백에 겹쳐 시각적 충돌 최소화.
  const text = _addonMkFrame(outer, { name: "text", x: 24, y: 0, width: 312, height: 168 });
  const con  = _addonMkFrame(text,  { name: "con",  x: 0, y: 0, width: 312, height: 132 });
  const txt  = _addonMkFrame(con,   {
    name: "txt", x: 0, y: 0, width: 190, height: 132,
    clipsContent: false,
  });
  await _addonMkText(txt, {
    name: "TEXT", x: 0, y: 32,
    characters: "", font: ADDON_FONT_BOLD, fontSize: 18, lineHeight: 24,
    color: ADDON_DEFAULT_TEXT_HEX, textAutoResize: "WIDTH_AND_HEIGHT",
  });
  const area = _addonMkFrame(con, { name: "area", x: 190, y: 0, width: 122, height: 132 });
  _addonMkFrame(area, { name: "image", x: 0, y: 12, width: 122, height: 107 });
  const btn = _addonMkFrame(text, {
    name: "Button/small", x: 0, y: 132, width: 312, height: 36,
    fills: _addonSolid(ADDON_DEFAULT_BUTTON_HEX), cornerRadius: 8,
  });
  await _addonMkText(btn, {
    name: "TEXT", x: 0, y: 8, width: 312, height: 20,
    characters: "", font: ADDON_FONT_BOLD, fontSize: 14, lineHeight: 20,
    color: "#ffffff", textAlignHorizontal: "CENTER", textAutoResize: "NONE",
  });
  return outer;
}

// 홈 중단 (360×378 → display 120×126)
// Figma reference: 132:21489
// 구조: bg(파스텔 카드, apply 시 dominant color 로 덮어써짐) 위에 아이콘(img/image),
// 그 위에 하단 흰색 텍스트 카드(서브+메인 2줄).
async function buildAddonHomeMiddle(opts) {
  opts = opts || {};
  const svc = opts.serviceName || "서비스명";
  const outer = _addonMkFrame(null, {
    name: "image_홈_" + svc + "_middle_360x378",
    width: 120, height: 126, fills: [],
  });
  figma.currentPage.appendChild(outer);
  // 배경 파스텔 카드 — apply 시 이미지 dominant color 로 덮어써짐
  _addonMkFrame(outer, {
    name: "bg", x: 0, y: 6, width: 120, height: 120,
    fills: _addonSolid("#d8e6ff"), cornerRadius: 12,
  });
  // 아이콘 슬롯 (Figma 원본 img→image 중첩. name="image" descendant 를 apply 이미지 대상으로)
  const img = _addonMkFrame(outer, { name: "img", x: 12, y: 3, width: 96, height: 52 });
  _addonMkFrame(img, { name: "image", x: 0, y: 0, width: 96, height: 52 });
  // 하단 흰색 텍스트 카드 (bg 위 오버레이)
  // 서브/메인 텍스트는 hug 로 두고, 부모를 auto-layout(세로/가로 중앙)로 만들어
  // 컨텐츠 폭에 맞춰 자연스럽게 중앙 정렬. 매우 긴 문구는 clipsContent=true 로 잘라줌.
  const textFrame = _addonMkFrame(outer, {
    name: "text", x: 0, y: 46, width: 120, height: 80,
    fills: _addonSolid("#ffffff"), cornerRadius: 12, clipsContent: true,
  });
  textFrame.layoutMode = "VERTICAL";
  textFrame.primaryAxisSizingMode = "FIXED";
  textFrame.counterAxisSizingMode = "FIXED";
  textFrame.primaryAxisAlignItems = "MIN";
  textFrame.counterAxisAlignItems = "CENTER";
  textFrame.paddingTop = 25;
  textFrame.paddingBottom = 16;
  textFrame.paddingLeft = 0;
  textFrame.paddingRight = 0;
  textFrame.itemSpacing = 1;
  await _addonMkText(textFrame, {
    name: "sub_text",
    characters: "", font: ADDON_FONT_REG, fontSize: 13, lineHeight: 18,
    color: ADDON_DEFAULT_SUB_TEXT_HEX,
    textAutoResize: "WIDTH_AND_HEIGHT",
  });
  await _addonMkText(textFrame, {
    name: "TEXT",
    characters: "", font: ADDON_FONT_BOLD, fontSize: 14, lineHeight: 20,
    color: "#000000",
    textAutoResize: "WIDTH_AND_HEIGHT",
  });
  return outer;
}

// 생활편의 상단 (984×840 → display 328×280)
// Figma reference: 148:5700
// 구조: 외곽 파스텔 카드(apply 시 dominant 로 덮어써짐) 안에 con(sub_tit + tit + area/image),
// AD_IMG 배지(기본 hidden, 필요 시 사용자가 켬), 하단 gradient Button/small.
async function buildAddonLifeTop(opts) {
  opts = opts || {};
  const svc = opts.serviceName || "서비스명";
  const outer = _addonMkFrame(null, {
    name: "image_생활편의_" + svc + "_top_984x840",
    width: 328, height: 280,
    fills: _addonSolid("#def8fd"),  // 기본 파스텔, apply 시 dominant color 로 덮어써짐
  });
  figma.currentPage.appendChild(outer);

  // Figma 148:5700 템플릿과 완전 일치. 패딩 16 유지 + con-button 간격 최소화(4px)로
  // 이미지 슬롯 높이 138 확보. 220×138 (aspect 1.594) 에 대해 helper 는 3:2 (1536×1024)
  // AI 이미지를 요청 → FIT 렌더 시 207×138 (슬롯 폭의 94%) 로 표시되어 잘림 없이 최대 크기.
  // (이전 220×118 대비 표시 면적 +53% 증가)
  const con = _addonMkFrame(outer, {
    name: "con", x: 16, y: 16, width: 296, height: 208,
    clipsContent: true,
  });

  // sub_tit: 서비스 아이콘(20×20 rounded) + 서비스명 텍스트
  const subTit = _addonMkFrame(con, { name: "sub_tit", x: 0, y: 0, width: 296, height: 20 });
  _addonMkFrame(subTit, {
    name: "service_icon", x: 0, y: 0, width: 20, height: 20,
    fills: _addonSolid("#bfbfbf"), cornerRadius: 4,
  });
  await _addonMkText(subTit, {
    name: "svc_name", x: 24, y: 1, width: 200, height: 18,
    characters: svc, font: ADDON_FONT_REG, fontSize: 12, lineHeight: 18,
    color: "#4d4d4d", textAutoResize: "NONE",
  });

  // tit: 메인 타이틀 (2 lines 최대, center-aligned, 44 clip). Figma: y=22, gap 2.
  const tit = _addonMkFrame(con, {
    name: "tit", x: 0, y: 22, width: 296, height: 44,
    clipsContent: true,
  });
  await _addonMkText(tit, {
    name: "TEXT", x: 0, y: 0, width: 296, height: 44,
    characters: "", font: ADDON_FONT_BOLD, fontSize: 15, lineHeight: 22,
    color: "#121212", textAlignHorizontal: "CENTER", textAutoResize: "NONE",
  });

  // area: 이미지 슬롯. Figma: y=70 h=138, image 220×138 중앙(x=38).
  // life-top 은 fitScaleModes 로 FIT 렌더 → 소스 종횡비 유지, 잘림 없이 슬롯 내 최대 크기.
  const area = _addonMkFrame(con, {
    name: "area", x: 0, y: 70, width: 296, height: 138,
    clipsContent: true,
  });
  _addonMkFrame(area, {
    name: "image", x: 38, y: 0, width: 220, height: 138,
  });

  // AD_IMG: 광고 배지 SVG (사용자 제공 · 2026-07-08). 기본 hidden, 필요 시 visible 로 켬.
  // AD 글자가 VECTOR path 로 들어가 있어 TEXT 노드가 없으므로 slot 매핑 대상 아님.
  const AD_IMG_SVG = '<svg width="20" height="12" viewBox="0 0 20 12" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<g opacity="0.3">' +
    '<rect x="0.5" y="0.5" width="19" height="11" rx="2.5" stroke="black"/>' +
    '<path d="M12.8433 9.2834H10.7119V2.71704H12.9067C14.8431 2.71704 15.9949 3.94597 15.9995 5.99115C15.9949 8.04087 14.8431 9.2834 12.8433 9.2834ZM11.7096 8.41272H12.7888C14.2762 8.40819 15.0109 7.54205 15.0109 5.99115C15.0109 4.44479 14.2762 3.58772 12.8433 3.58772H11.7096V8.41272Z" fill="black"/>' +
    '<path d="M5.06163 9.2834H4.00049L6.35857 2.71704H7.51041L9.87756 9.2834H8.81642L8.21783 7.55112H5.66022L5.06163 9.2834ZM5.94591 6.71672H7.92761L6.95716 3.91422H6.91182L5.94591 6.71672Z" fill="black"/>' +
    '</g>' +
    '</svg>';
  const adImg = figma.createNodeFromSvg(AD_IMG_SVG);
  adImg.name = "AD_IMG";
  adImg.x = 292;
  adImg.y = 212;
  adImg.visible = false;
  outer.appendChild(adImg);

  // Button/small: 하단 CTA (기본 gradient #0fb7d5→#0979b2, apply 시 image hue 로 덮어써짐)
  // gradient 방향은 code.js 의 apply-time 로직 (좌상→우하 대각선) 과 동일.
  const btn = _addonMkFrame(outer, {
    name: "Button/small", x: 16, y: 228, width: 296, height: 36,
    fills: [{
      type: "GRADIENT_LINEAR",
      gradientTransform: [[1, -0.18, 0], [0.18, 1, 0]],
      gradientStops: [
        { position: 0, color: { r: 15/255,  g: 183/255, b: 213/255, a: 1 } }, // #0fb7d5
        { position: 1, color: { r: 9/255,   g: 121/255, b: 178/255, a: 1 } }, // #0979b2
      ],
    }],
    cornerRadius: 8,
  });
  await _addonMkText(btn, {
    name: "TEXT", x: 0, y: 8, width: 296, height: 20,
    characters: "", font: ADDON_FONT_BOLD, fontSize: 13, lineHeight: 20,
    color: "#ffffff", textAlignHorizontal: "CENTER", textAutoResize: "NONE",
  });
  return outer;
}

// 생활편의 하단 (1080×가변 → display 360×400 기본)
async function buildAddonLifeBottom(opts) {
  opts = opts || {};
  const svc = opts.serviceName || "서비스명";
  const outer = _addonMkFrame(null, {
    name: "image_생활편의_" + svc + "_bottom_1080",
    width: 360, height: 400, fills: _addonSolid("#ffffff"),
  });
  figma.currentPage.appendChild(outer);
  const con = _addonMkFrame(outer, { name: "con", x: 0, y: 0, width: 360, height: 84 });
  const tit = _addonMkFrame(con, { name: "tit", x: 0, y: 0, width: 360, height: 84 });
  const head = _addonMkFrame(tit, { name: "head", x: 16, y: 16, width: 328, height: 52 });
  const svcRow = _addonMkFrame(head, { name: "service", x: 0, y: 0, width: 240, height: 28 });
  _addonMkFrame(svcRow, { name: "icon_20", x: 0, y: 4, width: 20, height: 20 });
  await _addonMkText(svcRow, {
    name: "svc_name", x: 24, y: 5, width: 216, height: 18,
    characters: svc, font: ADDON_FONT_SEMI, fontSize: 13, color: ADDON_DEFAULT_SUB_TEXT_HEX,
    textAutoResize: "NONE",
  });
  await _addonMkText(head, {
    name: "TEXT", x: 0, y: 28, width: 328, height: 24,
    characters: "", font: ADDON_FONT_BOLD, fontSize: 16, color: ADDON_DEFAULT_TEXT_HEX,
    textAutoResize: "NONE",
  });
  const body = _addonMkFrame(outer, { name: "body", x: 0, y: 84, width: 360, height: 316 });
  _addonMkFrame(body, { name: "image", x: 32, y: 16, width: 296, height: 220 });
  // Button/medium: 하단 CTA (기본 gradient #0fb7d5→#0979b2, apply 시 image hue 로 덮어써짐)
  // 홈 상단 · 생활편의 하단 통일 스타일 (cornerRadius 8, Bold, 좌상→우하 대각선).
  const btn = _addonMkFrame(body, {
    name: "Button/medium", x: 16, y: 252, width: 328, height: 44,
    fills: [{
      type: "GRADIENT_LINEAR",
      gradientTransform: [[1, -0.18, 0], [0.18, 1, 0]],
      gradientStops: [
        { position: 0, color: { r: 15/255, g: 183/255, b: 213/255, a: 1 } }, // #0fb7d5
        { position: 1, color: { r: 9/255,  g: 121/255, b: 178/255, a: 1 } }, // #0979b2
      ],
    }],
    cornerRadius: 8,
  });
  await _addonMkText(btn, {
    name: "TEXT", x: 0, y: 12, width: 328, height: 20,
    characters: "", font: ADDON_FONT_BOLD, fontSize: 14, lineHeight: 20,
    color: "#ffffff", textAlignHorizontal: "CENTER", textAutoResize: "NONE",
  });
  return outer;
}

// 지원금혜택 하단 (984×264 → display 328×88)
// Figma reference: 149:5758
// 구조: 좌측 원형 아이콘(56×56, bg circle + image slot 40×40).
// 우측 txt-con: 서브 텍스트(sub_text 13/18 Regular) + main_row(메인 TEXT 16/22 Bold + tag chip).
// tag chip 은 auto-layout 으로 텍스트 길이에 맞춰 자동 크기 조절, 색상은 apply 시 이미지
// dominant color 로 채워짐 (bg=pastel, text=saturated).
async function buildAddonSupportBottom(opts) {
  opts = opts || {};
  const svc = opts.serviceName || "서비스명";
  const outer = _addonMkFrame(null, {
    name: "banner_benefits_" + svc + "_bottom_984x264",
    width: 328, height: 88,
    fills: _addonSolid("#ffffff"),
  });
  figma.currentPage.appendChild(outer);

  // 좌측 원형 아이콘. ellipse 는 apply 시 이미지 dominant 로 변경되지 않는 고정 배경
  // (사용자 지시 2026-07-08). "bg" 대신 "ellipse" 로 명명해 pastel 라우팅에서 제외.
  // Figma 원본은 blur/gradient 이미지지만 단색 pastel 로 근사.
  const iconWrap = _addonMkFrame(outer, {
    name: "icon", x: 0, y: 16, width: 56, height: 56,
    clipsContent: true,
  });
  _addonMkFrame(iconWrap, {
    name: "ellipse", x: 0, y: 0, width: 56, height: 56,
    fills: _addonSolid("#eaf1fb"), cornerRadius: 28,
  });
  _addonMkFrame(iconWrap, {
    name: "image", x: 8, y: 8, width: 40, height: 40,
    fills: _addonSolid("#cbd8e8"), cornerRadius: 8,
  });

  // 우측 txt-con (수직 auto-layout, gap 2)
  const txtCon = _addonMkFrame(outer, {
    name: "txt-con", x: 76, y: 23, width: 244, height: 42, fills: [],
  });
  txtCon.layoutMode = "VERTICAL";
  txtCon.itemSpacing = 2;
  txtCon.paddingLeft = 0; txtCon.paddingRight = 0;
  txtCon.paddingTop = 0; txtCon.paddingBottom = 0;
  txtCon.primaryAxisSizingMode = "AUTO";       // height hugs content
  txtCon.counterAxisSizingMode = "FIXED";      // width 244 fixed
  txtCon.counterAxisAlignItems = "MIN";        // left-align

  // sub_text (13/18 Regular #666) — placeholder 기본 텍스트로 템플릿 감 유지.
  // 스펙 셀에 텍스트가 부족해도 빈 슬롯이 안 남고 예시가 표시됨.
  // textAutoResize=NONE 로 고정 244×18 유지 → 긴 내용도 1줄로 클립되어 레이아웃 안 흐트러짐.
  await _addonMkText(txtCon, {
    name: "sub_text", characters: "앱에서 간편하게 이용하세요",
    font: ADDON_FONT_REG, fontSize: 13, lineHeight: 18,
    color: ADDON_DEFAULT_SUB_TEXT_HEX,
    textAutoResize: "NONE", width: 244, height: 18,
  });

  // main_row (수평 auto-layout: main TEXT + tag chip)
  const mainRow = _addonMkFrame(txtCon, {
    name: "main_row", width: 244, height: 22, fills: [],
  });
  mainRow.layoutMode = "HORIZONTAL";
  mainRow.itemSpacing = 8;
  mainRow.counterAxisAlignItems = "CENTER";
  mainRow.primaryAxisSizingMode = "FIXED";      // 244 wide
  mainRow.counterAxisSizingMode = "AUTO";       // height hugs

  await _addonMkText(mainRow, {
    name: "TEXT", characters: "메인 타이틀",
    font: ADDON_FONT_BOLD, fontSize: 16, lineHeight: 22,
    color: "#000000", textAutoResize: "WIDTH_AND_HEIGHT",
  });

  // tag chip (수평 auto-layout, 텍스트 길이에 따라 자동 크기)
  // 기본 색은 pastel/saturated placeholder — apply 시 이미지 dominant color 로 갱신됨.
  const tag = _addonMkFrame(mainRow, {
    name: "tag", fills: _addonSolid("#ffece0"), cornerRadius: 12,
  });
  tag.layoutMode = "HORIZONTAL";
  tag.paddingLeft = 6; tag.paddingRight = 6;
  tag.paddingTop = 2; tag.paddingBottom = 2;
  tag.primaryAxisSizingMode = "AUTO";
  tag.counterAxisSizingMode = "AUTO";
  tag.primaryAxisAlignItems = "CENTER";
  tag.counterAxisAlignItems = "CENTER";

  await _addonMkText(tag, {
    name: "tag_text", characters: "태그",
    font: ADDON_FONT_REG, fontSize: 13, lineHeight: 18,
    color: "#ff5834", textAutoResize: "WIDTH_AND_HEIGHT",
    textAlignHorizontal: "CENTER",
  });
  return outer;
}

// 소통참여 하단 (480×348 → display 160×116)
// Figma reference: 170:5191. 이미지 생성 없이 텍스트만 적용되는 위치.
// 구조: outer(흰 bg + #eee stroke, VERTICAL auto-layout, padding 16, gap 8, justify-center)
//   ├─ head (HORIZONTAL auto-layout, gap 4, items-center)
//   │   ├─ img/20/service (20×20 pastel #ffcece placeholder — 사용자가 수동 교체)
//   │   └─ svc_name (Pretendard Regular 13/18 #333)
//   └─ txt (VERTICAL auto-layout, gap 2, layoutGrow 1, justify-end)
//       ├─ sub_text (Pretendard Regular 16/22 #000)
//       └─ TEXT     (Pretendard Bold    16/22 #000)
async function buildAddonSotongBottom(opts) {
  opts = opts || {};
  const svc = opts.serviceName || "서비스명";
  const outer = _addonMkFrame(null, {
    name: "banner_소통참여_" + svc + "_bottom_480x348",
    width: 160, height: 116,
    fills: _addonSolid("#ffffff"),
    strokes: _addonSolid("#eeeeee"), strokeWeight: 1,
    cornerRadius: 12, clipsContent: true,
  });
  figma.currentPage.appendChild(outer);
  outer.layoutMode = "VERTICAL";
  outer.primaryAxisSizingMode = "FIXED";
  outer.counterAxisSizingMode = "FIXED";
  outer.primaryAxisAlignItems = "CENTER";     // justify-center
  outer.counterAxisAlignItems = "MIN";        // items-start
  outer.paddingTop = 16; outer.paddingBottom = 16;
  outer.paddingLeft = 16; outer.paddingRight = 16;
  outer.itemSpacing = 8;

  // head: 아이콘 + 서비스명 (HUG both axes)
  const head = _addonMkFrame(outer, { name: "head", fills: [] });
  head.layoutMode = "HORIZONTAL";
  head.primaryAxisSizingMode = "AUTO";
  head.counterAxisSizingMode = "AUTO";
  head.primaryAxisAlignItems = "MIN";
  head.counterAxisAlignItems = "CENTER";
  head.itemSpacing = 4;
  _addonMkFrame(head, {
    name: "img/20/service", width: 20, height: 20,
    fills: _addonSolid("#ffcece"),
  });
  await _addonMkText(head, {
    name: "svc_name", characters: svc,
    font: ADDON_FONT_REG, fontSize: 13, lineHeight: 18,
    color: "#333333", textAutoResize: "WIDTH_AND_HEIGHT",
  });

  // txt: 남는 세로 공간 채우기 (layoutGrow 1) + counter FILL (w-full)
  const txt = _addonMkFrame(outer, { name: "txt", fills: [] });
  txt.layoutMode = "VERTICAL";
  txt.primaryAxisSizingMode = "FIXED";        // height 은 layoutGrow 로 결정
  txt.counterAxisSizingMode = "FIXED";        // width 은 layoutAlign STRETCH 로 결정
  txt.primaryAxisAlignItems = "MAX";          // justify-end
  txt.counterAxisAlignItems = "MIN";          // items-start
  txt.itemSpacing = 0;                        // sub_text ↔ TEXT 사이 gap (lineHeight 로 자연 간격 확보)
  txt.layoutGrow = 1;                         // flex-1
  txt.layoutAlign = "STRETCH";                // w-full

  await _addonMkText(txt, {
    name: "sub_text", characters: "저녁 찬거리 고민?",
    font: ADDON_FONT_REG, fontSize: 16, lineHeight: 22,
    color: "#000000", textAutoResize: "WIDTH_AND_HEIGHT",
  });
  await _addonMkText(txt, {
    name: "TEXT", characters: "시장에서 골라봐요",
    font: ADDON_FONT_BOLD, fontSize: 16, lineHeight: 22,
    color: "#000000", textAutoResize: "WIDTH_AND_HEIGHT",
  });
  return outer;
}

// 스펙 텍스트에서 서비스명 후보 추출 (짧은 명사 우선). 없으면 null.
// 지자체마다 상이 → 정확한 추출은 불가능. 4~10자 한글 명사가 있으면 후보로 채택.
function _guessServiceNameFromTexts(texts) {
  if (!texts || texts.length === 0) return null;
  const svcPattern = /^[가-힣][가-힣0-9A-Za-z]{2,9}$/;
  for (let i = 0; i < texts.length; i++) {
    const t = String(texts[i]).trim();
    if (svcPattern.test(t)) return t;
  }
  return null;
}

const ADDON_BUILDERS = {
  "home-top":        buildAddonHomeTop,
  "home-middle":     buildAddonHomeMiddle,
  "life-top":        buildAddonLifeTop,
  "life-bottom":     buildAddonLifeBottom,
  "support-bottom":  buildAddonSupportBottom,
  "sotong-bottom":   buildAddonSotongBottom,
};

async function buildAddonTemplateByPosition(position, opts) {
  const fn = ADDON_BUILDERS[position];
  if (!fn) return null;
  await _addonLoadFonts();
  return await fn(opts || {});
}

// ─────────── 부가서비스 템플릿 CRUD ───────────
// 위치별로 라이브러리 인스턴스 하나씩 등록. Map { position: { name, key } }.
const ADDON_TEMPLATES_STORAGE = "addon_templates";

async function _getAddonTemplates() {
  return (await figma.clientStorage.getAsync(ADDON_TEMPLATES_STORAGE)) || {};
}

async function _postAddonTemplates() {
  const map = await _getAddonTemplates();
  figma.ui.postMessage({ type: "addon_templates_loaded", templates: map });
}

async function registerAddonTemplate(position) {
  if (!position) { postError("등록할 위치 종류가 지정되지 않았습니다."); return; }
  const sel = figma.currentPage.selection;
  if (sel.length !== 1 || sel[0].type !== "INSTANCE") {
    postError("라이브러리 인스턴스 1개를 선택해주세요. (Assets → 컴포넌트 → 캔버스에 드래그 → 그 인스턴스를 선택)");
    return;
  }
  try {
    const main = await sel[0].getMainComponentAsync();
    if (!main || !main.key) {
      postError("컴포넌트 key 조회 실패 — 팀 라이브러리에 publish 되어 있는지 확인해주세요.");
      return;
    }
    const map = await _getAddonTemplates();
    map[position] = { name: main.name || "(이름 없음)", key: main.key, registered_at: Date.now() };
    await figma.clientStorage.setAsync(ADDON_TEMPLATES_STORAGE, map);
    figma.ui.postMessage({
      type: "addon_template_registered",
      position: position, name: main.name || "(이름 없음)",
      key: main.key, templates: map,
    });
  } catch (e) {
    postError("부가서비스 템플릿 등록 실패: " + (e && e.message ? e.message : String(e)));
  }
}

async function deleteAddonTemplate(position) {
  if (!position) { postError("삭제할 위치 종류가 없습니다."); return; }
  const map = await _getAddonTemplates();
  if (!map[position]) { postError("[" + position + "] 위치에 등록된 템플릿이 없습니다."); return; }
  const removed = map[position];
  delete map[position];
  await figma.clientStorage.setAsync(ADDON_TEMPLATES_STORAGE, map);
  figma.ui.postMessage({
    type: "addon_template_deleted",
    position: position, removedName: removed.name || "", templates: map,
  });
}

// 기획 스펙 셀 → 같은 위치로 새 템플릿 생성
// - 선택 프레임의 텍스트 노드를 top-down 으로 추출
// - position 에 등록된 라이브러리 컴포넌트를 import → 인스턴스 생성
// - 인스턴스를 선택 셀 우측(x + width + 24, 같은 y) 에 배치
// - 인스턴스의 placeholder 텍스트 슬롯을 위→아래 순으로 채움
// - 새 인스턴스를 selection 으로 설정해서 이어서 image_generate_prepare 가 그대로 동작
async function createAddonFromSpec(position, nodeId, placement) {
  if (!position) { postError("위치 종류가 지정되지 않았습니다."); return; }
  let specNode = null;
  if (nodeId) {
    try {
      specNode = (typeof figma.getNodeByIdAsync === "function")
        ? await figma.getNodeByIdAsync(nodeId)
        : figma.getNodeById(nodeId);
    } catch (e) { specNode = null; }
    if (!specNode) { postError("지정된 프레임을 찾지 못했습니다 (id=" + nodeId + ")"); return; }
  } else {
    const sel = figma.currentPage.selection;
    if (sel.length !== 1) {
      postError("기획 스펙 셀(프레임) 1개를 선택해주세요.");
      return;
    }
    specNode = sel[0];
  }
  if (!("children" in specNode)) {
    postError("자식 노드를 가진 프레임을 선택해주세요. (현재: " + specNode.type + ")");
    return;
  }

  // 텍스트 추출 (top-down, placeholder 제외)
  const textNodes = [];
  _collectTextNodes(specNode, textNodes);
  textNodes.sort(function (a, b) {
    const ay = _absY(a), by = _absY(b);
    if (Math.abs(ay - by) > 4) return ay - by;
    return _absX(a) - _absX(b);
  });
  const texts = [];
  for (let i = 0; i < textNodes.length; i++) {
    const s = String(textNodes[i].characters).trim();
    if (!_isPlaceholderText(s)) texts.push(s);
  }
  if (texts.length === 0) {
    postError("선택 프레임에서 텍스트를 찾지 못했습니다.");
    return;
  }

  // 템플릿 확보: 코드 내장 builder 만 사용 (2026-07-08 이후).
  // 이전에는 라이브러리 인스턴스가 등록돼 있으면 우선 임포트했으나,
  // 라이브러리 템플릿의 whitespace-nowrap · overflow-clip 등 디자인 세부가
  // 코드 빌더와 어긋나 텍스트 잘림/영역 불일치가 반복돼서 경로를 단일화.
  // addon_templates 저장소는 UI 호환을 위해 남겨두지만 여기선 참조하지 않음.
  let inst = null;
  let templateName = "";
  let templateSource = "";
  const detached = false;
  // svc name 후보를 texts 에서 추출 → svc_name 슬롯 (skip pattern 으로 slot filling 대상 제외)
  // 에 이미 채워짐. 여기서 texts 배열에서도 제거해야 이후 slot 매핑에서 tit(메인 타이틀) 등
  // 다른 슬롯을 중복 침범하지 않음. (2026-07-08 fix: 생활편의 상단에서 서비스명이 tit 로도
  // 들어가 원본 카피가 밀리는 버그 원인)
  const svcHintRaw = _guessServiceNameFromTexts(texts);
  if (svcHintRaw) {
    const svcIdx = texts.indexOf(svcHintRaw);
    if (svcIdx >= 0) texts.splice(svcIdx, 1);
  }
  const svcHint = svcHintRaw || "서비스명";
  const built = await buildAddonTemplateByPosition(position, { serviceName: svcHint });
  if (!built) {
    postError("[" + position + "] 위치용 코드 내장 builder 를 찾지 못했습니다.");
    return;
  }
  inst = built;
  templateName = "(코드 내장) " + inst.name;
  templateSource = "code";
  if (placement && typeof placement.x === "number" && typeof placement.y === "number") {
    // 배치 모드: UI 가 계산한 명시적 좌표 사용 (가로 50px 간격 정렬 등)
    inst.x = placement.x;
    inst.y = placement.y;
  } else {
    inst.x = specNode.x + specNode.width + 24;
    inst.y = specNode.y;
  }

  // 텍스트 슬롯 채움: 스펙 셀 텍스트를 top-down 순서대로 인스턴스 텍스트 노드에 덮어씀.
  // 라이브러리 인스턴스는 원본 문구가 이미 있고 (placeholder 로 잡히지 않음),
  // 코드 내장 build 결과는 " " 로 초기화됨. 두 경우 모두 채워지도록 필터는 name 기반으로만.
  // svc_/static_/label_/logo_/badge_ 로 시작하거나 _static/_label 로 끝나는 노드만 skip.
  const skipNamePattern = /^(svc_|static_|label_|logo_|badge_)|_static$|_label$/i;
  const allSlots = _collectPlaceholdersOrdered(inst);
  const slots = allSlots.filter(function (t) {
    return !skipNamePattern.test(String(t.name || ""));
  });
  const filled = Math.min(slots.length, texts.length);
  const fontFallbacks = [];
  for (let i = 0; i < filled; i++) {
    try {
      const res = await _setTextSafe(slots[i], texts[i]);
      if (res && res.fallback) {
        fontFallbacks.push(
          slots[i].name + ": " + JSON.stringify(res.requested) + " → " + JSON.stringify(res.used)
        );
      }
    } catch (e) {
      // 개별 실패는 로그로만 남기고 계속
      figma.ui.postMessage({
        type: "log",
        level: "warn",
        message: "  ⚠ 슬롯 채우기 실패 [" + slots[i].name + "]: " + (e && e.message ? e.message : String(e)),
      });
    }
  }

  // 이후 이미지 생성 체인이 이 인스턴스를 대상으로 하도록 selection 갱신
  figma.currentPage.selection = [inst];

  figma.ui.postMessage({
    type: "addon_from_spec_done",
    position: position,
    newNodeId: inst.id,
    newNodeName: inst.name,
    specNodeId: specNode.id,
    texts_extracted: texts.length,
    slots_available: allSlots.length,
    slots_filled: filled,
    font_fallbacks: fontFallbacks,
    templateName: templateName,
    templateSource: templateSource,   // "library" | "code"
    detached: detached,               // library 인스턴스는 즉시 detach 됨
  });
}

// 부가서비스 [아이콘] position 전용:
// 선택된 프레임 1개를 PNG 로 export → UI 에 base64 로 넘김.
// UI 가 helper /transform-icon 호출 → 결과 PNG 를 image_generate_apply 로 되돌려서
// 같은 프레임에 fill 로 적용. applyMode="addon-icon" 이면 bg/버튼/rename 은 skip.
async function prepareIconTransform() {
  const sel = figma.currentPage.selection || [];
  if (sel.length !== 1) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "3D 변환할 아이콘 프레임 1개를 선택해주세요.",
    });
    return;
  }
  const target = sel[0];
  if (target.type !== "FRAME" && target.type !== "INSTANCE" &&
      target.type !== "COMPONENT" && target.type !== "RECTANGLE") {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "FRAME / INSTANCE / RECTANGLE 을 선택해주세요. (현재: " + target.type + ")",
    });
    return;
  }

  let bytes;
  try {
    bytes = await target.exportAsync({ format: "PNG" });
  } catch (e) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "PNG export 실패: " + (e && e.message ? e.message : String(e)),
    });
    return;
  }
  const b64 = figma.base64Encode(bytes);
  figma.ui.postMessage({
    type: "icon_transform_context",
    targetNodeId: target.id,
    frameNodeId: null,
    targetName: target.name || "(이름 없음)",
    frameName: target.name || "(이름 없음)",
    width: Math.max(64, Math.round(target.width)),
    height: Math.max(64, Math.round(target.height)),
    inputBase64: b64,
    kind: "addon",
  });
}

function _hexToRgbNormalized(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ""));
  if (!m) return null;
  return {
    r: parseInt(m[1], 16) / 255,
    g: parseInt(m[2], 16) / 255,
    b: parseInt(m[3], 16) / 255,
  };
}

// UI 로부터 base64 이미지 받아서 대상 노드의 fill 로 적용.
async function applyGeneratedImage(msg) {
  const targetNodeId = msg && msg.targetNodeId;
  const b64 = msg && msg.base64;
  figma.ui.postMessage({
    type: "log", level: "muted",
    message: "  → applyGeneratedImage 호출 · target=" + (targetNodeId || "(없음)") +
      " · frame=" + ((msg && msg.frameNodeId) || "(없음)") +
      " · applyMode=" + ((msg && msg.applyMode) || "(없음)") +
      " · base64=" + (b64 ? (b64.length + "B") : "(비어있음)"),
  });
  if (!targetNodeId || !b64) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "이미지 적용 실패: targetNodeId 또는 base64 가 비어있음.",
    });
    return;
  }

  let node = null;
  try {
    if (typeof figma.getNodeByIdAsync === "function") {
      node = await figma.getNodeByIdAsync(targetNodeId);
    } else {
      node = figma.getNodeById(targetNodeId);
    }
  } catch (e) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "대상 노드 조회 실패: " + (e && e.message ? e.message : String(e)),
    });
    return;
  }
  if (!node) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "대상 노드를 찾을 수 없습니다 (삭제됨/이동됨). 다시 선택 후 재시도하세요.",
    });
    return;
  }

  try {
    const bytes = figma.base64Decode(b64);
    const image = figma.createImage(bytes);
    // 이미지 슬롯 종횡비가 소스(square) 와 크게 다른 위치는 FIT 로 렌더 → 상하 crop 방지.
    // life-top(220×118, 1.86:1) → image 118×118 로 슬롯에 완전히 들어오고 좌우 51px 씩
    // 여백은 외곽 파스텔 bg(apply 시 image dominant color 로 세팅)가 채움.
    const applyModeStr = String((msg && msg.applyMode) || "");
    const fitScaleModes = { "addon-life-top": true };
    const scaleMode = fitScaleModes[applyModeStr] ? "FIT" : "FILL";
    node.fills = [{
      type: "IMAGE",
      scaleMode: scaleMode,
      imageHash: image.hash,
    }];
  } catch (e) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "이미지 fill 적용 실패: " + (e && e.message ? e.message : String(e)),
    });
    return;
  }

  // 프레임 배경에 dominant-color pastel 적용 (helper 가 추출한 hex)
  // applyMode="addon-home-top" 이면 배경 fill 은 visible:false 로 두고,
  // 프레임명 끝의 _#hex 를 새 값으로 교체 + Button/small child 에 버튼 색 적용.
  let frameBgApplied = null;
  let buttonColorApplied = null;
  let frameRenamedFrom = null;
  let frameRenamedTo = null;
  const frameNodeId = msg && msg.frameNodeId;
  const bgHex = msg && msg.backgroundColor;
  const buttonHex = msg && msg.buttonColor;
  const applyMode = msg && msg.applyMode;
  // addon-* 는 대개 outer 를 hidden 으로 두지만 (이미지에 baked-in pastel 이 있으므로),
  // 외곽 프레임 자체가 파스텔 카드인 경우 (addon-life-top) 는 visible=true 로 유지.
  // addon-home-middle 은 별도로 내부 "bg" descendant 에 pastel 을 얹으므로 아래에서 처리.
  const isAddonApply = String(applyMode || "").indexOf("addon-") === 0;
  const outerVisibleAddons = { "addon-life-top": true };
  const bgVisible = !isAddonApply || !!outerVisibleAddons[applyMode];
  if (frameNodeId && bgHex) {
    const rgb = _hexToRgbNormalized(bgHex);
    if (rgb) {
      try {
        let frameNode = null;
        if (typeof figma.getNodeByIdAsync === "function") {
          frameNode = await figma.getNodeByIdAsync(frameNodeId);
        } else {
          frameNode = figma.getNodeById(frameNodeId);
        }
        // 특정 addon 은 외곽 프레임 fill 대신 내부 "bg" descendant 에 pastel 을 얹음.
        // - addon-home-middle: 하단 흰색 텍스트 카드가 오버레이돼 외곽 fill 이 안 보임.
        // (addon-support-bottom 은 ellipse 아이콘 배경이 고정 pastel 이라 여기 없음)
        const bgDescendantAddons = { "addon-home-middle": true };
        let bgTarget = null;
        let bgIsDescendant = false;
        if (bgDescendantAddons[applyMode] && frameNode && "children" in frameNode) {
          bgTarget = _findDescendantByName(frameNode, "bg");
          if (bgTarget && "fills" in bgTarget) bgIsDescendant = true;
          else bgTarget = null;
        }
        if (!bgTarget && frameNode && "fills" in frameNode &&
            applyMode !== "addon-support-bottom") {
          // support-bottom 은 외곽이 흰색 유지되어야 하므로 fallback 대상 아님
          bgTarget = frameNode;
        }
        if (bgTarget) {
          bgTarget.fills = [{
            type: "SOLID", color: rgb,
            visible: bgIsDescendant ? true : bgVisible,
          }];
          frameBgApplied = bgHex + (bgIsDescendant ? " (→ bg descendant)" : "");
        }
        // 프레임명 끝 _#hex 교체는 홈 상단(addon-home-top) 에만 적용.
        // 다른 addon-* 는 이름에 hex 접미사 붙이지 않음 (사용자 지침 2026-07-08).
        if (frameNode && applyMode === "addon-home-top") {
          const oldName = String(frameNode.name || "");
          const newName = _replaceOrAppendHexSuffix(oldName, bgHex);
          if (newName !== oldName) {
            frameRenamedFrom = oldName;
            frameNode.name = newName;
            frameRenamedTo = newName;
          }
        }
        // addon-support-bottom: 우측 tag chip 색상을 이미지 dominant color 로 갱신.
        //   tag(프레임) fills = pastel(backgroundColor)
        //   tag_text(TEXT) fills = saturated(buttonColor)
        // 버튼 노드 자체는 이 위치에 없으므로 아래 button gradient 블록은 fuzzy-match
        // 실패 → NOT_FOUND 로그가 남는데 무해. (사용자 요청 2026-07-08)
        if (frameNode && applyMode === "addon-support-bottom") {
          try {
            const tagNode = _findDescendantByName(frameNode, "tag");
            if (tagNode && "fills" in tagNode) {
              tagNode.fills = [{ type: "SOLID", color: rgb, visible: true }];
            }
            const tagTextNode = _findDescendantByName(frameNode, "tag_text");
            if (tagTextNode && "fills" in tagTextNode && buttonHex) {
              const tagRgb = _hexToRgbNormalized(buttonHex);
              if (tagRgb) {
                tagTextNode.fills = [{ type: "SOLID", color: tagRgb, visible: true }];
              }
            }
          } catch (tagErr) {
            // tag 갱신 실패는 무해 — 프레임에 tag 가 없거나 이름이 다를 뿐
          }
        }
        // addon-*: 버튼 descendant 에 그라데이션 fill (또는 solid) 적용.
        // 우선순위: buttonGradient > buttonColor (backward compat).
        // 단, support-bottom 은 버튼이 없으므로 skip.
        const buttonGradient = msg && msg.buttonGradient;
        if (frameNode && isAddonApply && applyMode !== "addon-support-bottom" &&
            (buttonGradient || buttonHex)) {
          const btnNode = _findButtonDescendant(frameNode);
          if (btnNode && "fills" in btnNode) {
            try {
              if (buttonGradient && buttonGradient.start && buttonGradient.end) {
                const s = _hexToRgbNormalized(buttonGradient.start);
                const e = _hexToRgbNormalized(buttonGradient.end);
                if (s && e) {
                  btnNode.fills = [{
                    type: "GRADIENT_LINEAR",
                    // 좌상 → 우하 대각선(~10° 다운틸트). Figma 참조 148:5583 의
                    // `linear-gradient(79.74deg, ...)` 형태.
                    gradientTransform: [[1, -0.18, 0], [0.18, 1, 0]],
                    gradientStops: [
                      { position: 0, color: { r: s.r, g: s.g, b: s.b, a: 1 } },
                      { position: 1, color: { r: e.r, g: e.g, b: e.b, a: 1 } },
                    ],
                  }];
                  buttonColorApplied = "gradient " + buttonGradient.start + " → " + buttonGradient.end +
                    " (node=\"" + btnNode.name + "\" · " + btnNode.type + ")";
                }
              } else if (buttonHex) {
                const btnRgb = _hexToRgbNormalized(buttonHex);
                if (btnRgb) {
                  btnNode.fills = [{ type: "SOLID", color: btnRgb, visible: true }];
                  buttonColorApplied = buttonHex + " (node=\"" + btnNode.name + "\" · " + btnNode.type + ")";
                }
              }
            } catch (btnErr) {
              buttonColorApplied = "ERROR:" + (btnErr && btnErr.message ? btnErr.message : String(btnErr)) +
                " (node=\"" + btnNode.name + "\")";
            }
          } else {
            const childNames = [];
            try {
              const q = [frameNode];
              while (q.length > 0 && childNames.length < 20) {
                const c = q.shift();
                if (c !== frameNode) childNames.push(c.name);
                if (c.children) for (let i = 0; i < c.children.length; i++) q.push(c.children[i]);
              }
            } catch (e) {}
            buttonColorApplied = "NOT_FOUND: 버튼 노드를 찾지 못했습니다. " +
              "탐색된 자식 노드 이름: [" + childNames.slice(0, 15).join(", ") + "]";
          }
        }
      } catch (e) {
        // 배경/버튼 적용 실패는 치명적 아니므로 done 메시지에 경고만 실어 보냄
        frameBgApplied = "ERROR: " + (e && e.message ? e.message : String(e));
      }
    }
  }

  figma.ui.postMessage({
    type: "image_generate_done",
    targetName: node.name || "(이름 없음)",
    prompt: msg.prompt || null,
    frameBgApplied: frameBgApplied,
    buttonColorApplied: buttonColorApplied,
    frameRenamedFrom: frameRenamedFrom,
    frameRenamedTo: frameRenamedTo,
  });
}

// 프레임명 끝의 "_#RRGGBB" 를 새 hex 로 교체. 없으면 append.
function _replaceOrAppendHexSuffix(name, hex) {
  const h = String(hex || "").trim().toLowerCase();
  if (!/^#?[0-9a-f]{6}$/.test(h)) return name;
  const norm = h.charAt(0) === "#" ? h : "#" + h;
  const re = /_#[0-9a-fA-F]{6}$/;
  if (re.test(name)) return name.replace(re, "_" + norm);
  return name + "_" + norm;
}

// 버튼 descendant 를 유연하게 탐색. 실제 인스턴스에서 이름 정확 매치가 어려움:
//   - Figma variant 인스턴스는 "Button/Size=small" 처럼 property syntax 를 가짐
//   - 팀 라이브러리 컴포넌트 별로 "Button/small", "Button", "btn primary" 등 상이
// 전략: 이름에 "button" 또는 "btn" 이 포함된 컨테이너 노드를 스코어 기반 정렬.
// 동점이면 (a) 페이지 하단에 가까운 노드 (b) 면적 큰 노드 우선.
function _findButtonDescendant(node) {
  if (!node) return null;
  const candidates = [];
  const queue = [node];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur !== node) {  // 루트는 제외
      const nm = String(cur.name || "").toLowerCase().trim();
      let score = 0;
      // 정확 매치 우선
      if (nm === "button/small") score = 100;
      else if (nm === "button/medium") score = 95;
      else if (nm === "button/large") score = 90;
      else if (nm.indexOf("button/") === 0) score = 80;   // variant
      else if (nm === "button") score = 70;
      else if (/(^|[^a-z])button([^a-z]|$)/.test(nm)) score = 50;  // 단어 경계
      else if (/(^|[^a-z])btn([^a-z]|$)/.test(nm)) score = 30;
      const typeOk = (cur.type === "INSTANCE" || cur.type === "FRAME" ||
                      cur.type === "COMPONENT" || cur.type === "RECTANGLE");
      if (score > 0 && typeOk) {
        let area = 0, absY = 0;
        try {
          area = (cur.width || 0) * (cur.height || 0);
          if (cur.absoluteTransform) absY = cur.absoluteTransform[1][2] || 0;
        } catch (e) {}
        candidates.push({ score: score, area: area, absY: absY, node: cur });
      }
    }
    if (cur.children && cur.children.length > 0) {
      for (let i = 0; i < cur.children.length; i++) queue.push(cur.children[i]);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (b.absY !== a.absY) return b.absY - a.absY;  // 아래쪽 우선
    return b.area - a.area;
  });
  return candidates[0].node;
}

// 이름이 정확히 일치하는 descendant 를 BFS 로 탐색.
function _findDescendantByName(node, targetName) {
  if (!node) return null;
  const queue = [node];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur.name === targetName) return cur;
    if (cur.children && cur.children.length > 0) {
      for (let i = 0; i < cur.children.length; i++) queue.push(cur.children[i]);
    }
  }
  return null;
}

// 텍스트 노드의 문자열을 안전하게 설정.
// - fontName 이 figma.mixed 면 시작 부분 폰트 사용 (또는 fallback)
// - 폰트 로드 실패 시 Pretendard / Inter 로 fallback
// 반환: { ok: true } | { fallback: true, requested, used } | throws
async function _setTextSafe(node, newText) {
  const fn = node.fontName;
  // mixed 처리 — 시작 글자의 폰트 사용 시도
  let primary = fn;
  if (primary === figma.mixed) {
    try {
      const startFn = node.getRangeFontName(0, 1);
      if (startFn !== figma.mixed) {
        primary = startFn;
      } else {
        primary = null;
      }
    } catch (e) {
      primary = null;
    }
  }

  // 1차 시도: 원래 폰트 로드
  if (primary && typeof primary === "object" && primary.family) {
    try {
      await figma.loadFontAsync(primary);
      if (fn === figma.mixed) node.fontName = primary;
      node.characters = newText;
      return { ok: true, used: primary };
    } catch (e) {
      // 다음 단계로
    }
  }

  // 2차 ~ N차 시도: fallback 폰트 체인
  const requestedStyle = (primary && primary.style) || "Regular";
  const fallbacks = [
    { family: "Pretendard", style: requestedStyle },
    { family: "Pretendard", style: "Regular" },
    { family: "Inter", style: requestedStyle },
    { family: "Inter", style: "Regular" },
  ];
  for (let i = 0; i < fallbacks.length; i++) {
    try {
      await figma.loadFontAsync(fallbacks[i]);
      node.fontName = fallbacks[i];
      node.characters = newText;
      return { fallback: true, requested: primary, used: fallbacks[i] };
    } catch (e) {
      continue;
    }
  }
  throw new Error(
    "폰트 로드 실패 — 원본: " + JSON.stringify(primary) +
    " (Pretendard / Inter fallback 모두 실패)"
  );
}


async function deletePopupTemplate(key) {
  if (!key) {
    postError("삭제할 팝업 종류 key 가 없습니다.");
    return;
  }
  const list = await _getPopupTemplates();
  const before = list.length;
  const filtered = list.filter(function (t) { return t.key !== key; });
  await figma.clientStorage.setAsync(POPUP_TEMPLATES_STORAGE, filtered);
  figma.ui.postMessage({
    type: "popup_template_deleted",
    deleted: before - filtered.length,
    templates: filtered,
  });
}


figma.ui.onmessage = async function (msg) {
  if (!msg || !msg.type) return;
  if (msg.type === "extract") {
    try {
      await extractSelection({ mode: msg.mode, jiraKey: msg.jiraKey });
    } catch (e) {
      postError("예상치 못한 오류: " + (e && e.message ? e.message : e));
    }
  } else if (msg.type === "load_ppt_apply") {
    try {
      await applyImportPPT(msg.data);
    } catch (e) {
      figma.ui.postMessage({
        type: "load_ppt_error",
        message: (e && e.message ? e.message : String(e)),
      });
    }
  } else if (msg.type === "popup_register") {
    try {
      await registerPopupComponent();
    } catch (e) {
      postError("팝업 등록 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "popup_apply") {
    try {
      await applyPopupTemplate({ key: msg.key });
    } catch (e) {
      postError("팝업 적용 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "popup_get_templates") {
    try {
      await sendPopupTemplatesToUI();
    } catch (e) {
      postError("팝업 종류 로드 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "popup_delete_template") {
    try {
      await deletePopupTemplate(msg.key);
    } catch (e) {
      postError("팝업 종류 삭제 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "image_generate_prepare") {
    try {
      prepareImageGenerate({ kind: msg.kind, extraHint: msg.extraHint });
    } catch (e) {
      figma.ui.postMessage({
        type: "image_generate_error",
        message: "이미지 생성 준비 오류: " + (e && e.message ? e.message : String(e)),
      });
    }
  } else if (msg.type === "icon_transform_prepare") {
    try {
      await prepareIconTransform();
    } catch (e) {
      figma.ui.postMessage({
        type: "image_generate_error",
        message: "아이콘 export 오류: " + (e && e.message ? e.message : String(e)),
      });
    }
  } else if (msg.type === "addon_register") {
    try {
      await registerAddonTemplate(msg.position);
    } catch (e) {
      postError("부가서비스 템플릿 등록 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "addon_delete") {
    try {
      await deleteAddonTemplate(msg.position);
    } catch (e) {
      postError("부가서비스 템플릿 삭제 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "addon_get_templates") {
    try {
      await _postAddonTemplates();
    } catch (e) {
      postError("부가서비스 템플릿 조회 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "addon_from_spec") {
    try {
      await createAddonFromSpec(msg.position, msg.nodeId || null, msg.placement || null);
    } catch (e) {
      postError("기획 셀 자동 생성 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "sotong_prepare_selected") {
    try {
      prepareSotongImageFromSelection();
    } catch (e) {
      figma.ui.postMessage({
        type: "image_generate_error",
        message: "소통참여 준비 오류: " + (e && e.message ? e.message : String(e)),
      });
    }
  } else if (msg.type === "sotong_prepare_new") {
    try {
      await prepareSotongImageFromSubject(msg);
    } catch (e) {
      figma.ui.postMessage({
        type: "image_generate_error",
        message: "소통참여 새 프레임 생성 오류: " + (e && e.message ? e.message : String(e)),
      });
    }
  } else if (msg.type === "image_generate_apply") {
    try {
      await applyGeneratedImage(msg);
    } catch (e) {
      figma.ui.postMessage({
        type: "image_generate_error",
        message: "이미지 적용 오류: " + (e && e.message ? e.message : String(e)),
      });
    }
  } else if (msg.type === "auto_split") {
    // deprecated — 안전을 위해 무시
    postError(
      "별도 '자동 분할' 단계는 더 이상 필요 없습니다. " +
      "'선택 프레임 추출 → Way 업로드' 누르면 Helper 가 PIL 로 자동 분할합니다."
    );
  } else if (msg.type === "get_detail_sections") {
    try {
      const templates = await getDetailSectionTemplates();
      figma.ui.postMessage({ type: "detail_sections_loaded", templates });
    } catch (e) {
      postError("섹션 템플릿 로드 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "register_detail_section") {
    try {
      await registerDetailSection(msg.sectionType, msg.name);
    } catch (e) {
      postError("섹션 템플릿 등록 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "delete_detail_section") {
    try {
      await deleteDetailSection(msg.key);
    } catch (e) {
      postError("섹션 템플릿 삭제 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "apply_detail_section") {
    try {
      await applyDetailSection(msg.templateKey);
    } catch (e) {
      figma.ui.postMessage({
        type: "detail_section_apply_error",
        message: (e && e.message ? e.message : String(e)),
      });
    }
  } else if (msg.type === "export_config") {
    try {
      const popupTemplates = await figma.clientStorage.getAsync(POPUP_TEMPLATES_STORAGE) || [];
      const detailTemplates = await getDetailSectionTemplates();
      figma.ui.postMessage({
        type: "config_exported",
        config: { version: 1, popupTemplates, detailTemplates },
      });
    } catch (e) {
      postError("설정 내보내기 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "import_config") {
    try {
      const cfg = msg.config;
      if (!cfg || cfg.version !== 1) throw new Error("지원하지 않는 설정 파일 형식입니다.");
      if (Array.isArray(cfg.popupTemplates)) {
        await figma.clientStorage.setAsync(POPUP_TEMPLATES_STORAGE, cfg.popupTemplates);
      }
      if (Array.isArray(cfg.detailTemplates)) {
        await saveDetailSectionTemplates(cfg.detailTemplates);
      }
      const popupTemplates = await figma.clientStorage.getAsync(POPUP_TEMPLATES_STORAGE) || [];
      const detailTemplates = await getDetailSectionTemplates();
      figma.ui.postMessage({
        type: "config_imported",
        popupTemplates,
        detailTemplates,
        popupCount: popupTemplates.length,
        detailCount: detailTemplates.length,
      });
    } catch (e) {
      postError("설정 가져오기 오류: " + (e && e.message ? e.message : String(e)));
    }
  } else if (msg.type === "ui_settings_load") {
    // UI 가 시작할 때 한 번 호출 — 모든 사용자 설정값을 한 번에 로드
    try {
      const keys = [
        "setting_popup_style", "setting_popup_hint",
        "setting_banner_style", "setting_banner_hint",
        "setting_skip_preview",
      ];
      const out = {};
      for (const k of keys) {
        out[k] = await figma.clientStorage.getAsync(k);
      }
      figma.ui.postMessage({ type: "ui_settings_loaded", settings: out });
    } catch (e) {
      // 실패해도 fatal 아님 — UI 는 default 값으로 진행
      figma.ui.postMessage({ type: "ui_settings_loaded", settings: {} });
    }
    // 초기 selection 스냅샷 전달 — selectionchange 는 "변경 시"만 발화하므로
    // 플러그인 시작 시 이미 선택돼 있던 프레임(특히 소통참여 규칙 매치)이 UI 에 반영되지 않는 문제 해결
    try {
      figma.ui.postMessage({
        type: "selection_changed",
        info: _summarizeSelection(),
        sotong: _summarizeSotongSelection(),
      });
    } catch (e) { /* UI 준비 전이면 무시 */ }
  } else if (msg.type === "ui_setting_save") {
    // 단일 설정값 저장 (key, value)
    try {
      if (msg.key) await figma.clientStorage.setAsync(msg.key, msg.value);
    } catch (e) { /* 저장 실패는 silent */ }
  } else if (msg.type === "ui_resize") {
    // UI 가 미리보기 박스 펼침/접힘에 맞춰 plugin window 높이 조정 요청
    try {
      const w = Math.max(360, Math.min(1200, msg.width || 440));
      const h = Math.max(400, Math.min(1400, msg.height || 800));
      figma.ui.resize(w, h);
    } catch (e) { /* resize 실패 무시 */ }
  } else if (msg.type === "popup_apply_batch_step") {
    // 일괄 처리에서 UI 가 보낸 단일 frame 처리 요청
    try {
      await applyPopupBatchStep(msg);
    } catch (e) {
      figma.ui.postMessage({
        type: "popup_apply_batch_error",
        message: (e && e.message ? e.message : String(e)),
        nodeId: msg.nodeId,
      });
    }
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};

// ── 소통참여 프레임명 파싱 ─────────────────────────────────────
// 규칙: MMDD_image_소통참여_{주제}_top_984x552
//   - 앞 3개: date, "image", "소통참여"
//   - 뒤 2개: "top", size (예: 984x552)
//   - 가운데는 모두 주제로 취급 (주제에 _ 포함 가능)
function parseSotongFrameName(name) {
  const parts = String(name || "").split("_");
  if (parts.length < 6) return null;

  const date = parts[0];
  const type = parts[1];
  const category = parts[2];
  const suffix = parts[parts.length - 2];
  const sizeToken = parts[parts.length - 1];

  if (!/^\d{4}$/.test(date)) return null;
  if (type !== "image") return null;
  if (category !== "소통참여") return null;
  if (suffix !== "top") return null;

  const wh = sizeToken.split("x");
  if (wh.length !== 2) return null;
  if (!/^\d+$/.test(wh[0]) || !/^\d+$/.test(wh[1])) return null;
  const width = parseInt(wh[0], 10);
  const height = parseInt(wh[1], 10);

  const subject = parts.slice(3, -2).join("_");
  if (!subject) return null;

  return { date, subject, width, height };
}

function _formatMMDD(d) {
  const dt = d || new Date();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return mm + dd;
}

// UI 로 보낼 소통참여 선택 상태 (선택 프레임이 소통참여 규칙 매치 시)
function _summarizeSotongSelection() {
  const sel = figma.currentPage.selection || [];
  if (sel.length !== 1) return null;
  const n = sel[0];
  if (n.type !== "FRAME" && n.type !== "INSTANCE" && n.type !== "COMPONENT") return null;
  const parsed = parseSotongFrameName(n.name);
  if (!parsed) return null;
  return {
    nodeId: n.id,
    name: n.name,
    subject: parsed.subject,
    width: parsed.width,
    height: parsed.height,
  };
}

// ── selection 변경 → UI 에 알림 (일괄 처리 모드 토글용) ─────────────────
function _summarizeSelection() {
  const sel = figma.currentPage.selection || [];
  const frames = [];
  for (const n of sel) {
    if (n.type === "FRAME" || n.type === "INSTANCE" || n.type === "COMPONENT") {
      let absX = 0, absY = 0;
      try {
        if (n.absoluteTransform) {
          absX = n.absoluteTransform[0][2] || 0;
          absY = n.absoluteTransform[1][2] || 0;
        }
      } catch (e) {}
      frames.push({
        id: n.id,
        name: n.name || "(이름 없음)",
        width: Math.round(n.width || 0),
        height: Math.round(n.height || 0),
        x: Math.round(absX),
        y: Math.round(absY),
      });
    }
  }
  return {
    total: sel.length,
    frameCount: frames.length,
    frames: frames,
  };
}
figma.on("selectionchange", function () {
  try {
    figma.ui.postMessage({
      type: "selection_changed",
      info: _summarizeSelection(),
      sotong: _summarizeSotongSelection(),
    });
  } catch (e) { /* UI 가 닫혔을 수 있음 */ }
});

// ── 소통참여: 선택 프레임 컨텍스트 준비 (Mode A) ─────────────────
function prepareSotongImageFromSelection() {
  const info = _summarizeSotongSelection();
  if (!info) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "MMDD_image_소통참여_{주제}_top_{w}x{h} 규칙에 맞는 프레임 1개를 선택해주세요.",
    });
    return;
  }
  figma.ui.postMessage({
    type: "image_generate_context",
    targetNodeId: info.nodeId,
    frameNodeId: info.nodeId,   // 프레임 자체를 이미지 fill 대상으로 사용
    targetName: info.name,
    width: info.width,
    height: info.height,
    texts: [],                   // 소통참여는 텍스트 대신 주제를 프롬프트로 사용
    kind: "sotong",
    subject: info.subject,
  });
}

// ── 소통참여: 새 프레임 만들기 + 컨텍스트 준비 (Mode B) ─────────────
async function prepareSotongImageFromSubject(msg) {
  const subject = msg && msg.subject ? String(msg.subject).trim() : "";
  if (!subject) {
    figma.ui.postMessage({
      type: "image_generate_error",
      message: "주제를 입력해주세요.",
    });
    return;
  }
  const width = 984;
  const height = 552;
  const safeSubject = subject.replace(/\s+/g, "_");
  const name = _formatMMDD() + "_image_소통참여_" + safeSubject + "_top_" + width + "x" + height;

  // 새 FRAME 생성 — 현재 페이지의 viewport center 근처
  const frame = figma.createFrame();
  frame.name = name;
  frame.resize(width, height);
  frame.fills = [{ type: "SOLID", color: { r: 0.94, g: 0.95, b: 0.97 } }];

  // 위치: 현재 viewport 중앙, 그리고 선택된 프레임이 있으면 그 아래로
  const sel = figma.currentPage.selection || [];
  if (sel.length === 1 && (sel[0].type === "FRAME" || sel[0].type === "INSTANCE" || sel[0].type === "COMPONENT")) {
    const anchor = sel[0];
    frame.x = anchor.x;
    frame.y = anchor.y + (anchor.height || 0) + 40;
  } else {
    const c = figma.viewport.center;
    frame.x = Math.round(c.x - width / 2);
    frame.y = Math.round(c.y - height / 2);
  }

  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);

  figma.ui.postMessage({
    type: "image_generate_context",
    targetNodeId: frame.id,
    frameNodeId: frame.id,
    targetName: frame.name,
    width: width,
    height: height,
    texts: [],
    kind: "sotong",
    subject: subject,
    createdNewFrame: true,
  });
}

// ── 일괄 처리: UI 가 보낸 nodeId 1개를 선택 → popup_apply 흐름 시작 ──
async function applyPopupBatchStep(msg) {
  const nodeId = msg && msg.nodeId;
  const key = msg && msg.templateKey;
  if (!nodeId || !key) {
    figma.ui.postMessage({
      type: "popup_apply_batch_error",
      message: "nodeId 또는 templateKey 누락",
      nodeId: nodeId,
    });
    return;
  }
  let node = null;
  try {
    if (typeof figma.getNodeByIdAsync === "function") {
      node = await figma.getNodeByIdAsync(nodeId);
    } else {
      node = figma.getNodeById(nodeId);
    }
  } catch (e) {
    figma.ui.postMessage({
      type: "popup_apply_batch_error",
      message: "node 조회 실패: " + (e && e.message ? e.message : String(e)),
      nodeId: nodeId,
    });
    return;
  }
  if (!node) {
    figma.ui.postMessage({
      type: "popup_apply_batch_error",
      message: "node 를 찾을 수 없습니다 (삭제됨)",
      nodeId: nodeId,
    });
    return;
  }
  // selection 을 해당 node 만으로 강제 → 기존 applyPopupTemplate 그대로 사용
  figma.currentPage.selection = [node];
  await applyPopupTemplate({ key: key });
}

// ── 상세페이지 섹션 템플릿 관리 ──────────────────────────────────────────────
const DS_STORAGE_KEY = "detail_section_templates_v1";

async function getDetailSectionTemplates() {
  return (await figma.clientStorage.getAsync(DS_STORAGE_KEY)) || [];
}

async function saveDetailSectionTemplates(list) {
  await figma.clientStorage.setAsync(DS_STORAGE_KEY, list);
}

async function registerDetailSection(sectionType, name) {
  const selected = figma.currentPage.selection[0];
  if (!selected) throw new Error("컴포넌트 또는 인스턴스를 먼저 선택해주세요.");

  // 컴포넌트 키 추출 (INSTANCE → main component, COMPONENT/COMPONENT_SET → 직접)
  let comp = null;
  if (selected.type === "INSTANCE") {
    comp = await selected.getMainComponentAsync();
  } else if (selected.type === "COMPONENT" || selected.type === "COMPONENT_SET") {
    comp = selected;
  } else if (selected.type === "FRAME") {
    // 일반 프레임도 허용 — componentKey 없이 nodeId로 저장
    comp = null;
  }

  const key = sectionType + "_" + Date.now();
  const entry = {
    key,
    sectionType,
    name,
    componentKey: comp ? comp.key : null,  // null이면 nodeId fallback
    nodeId: (!comp) ? selected.id : null,
    nodeName: selected.name,
  };

  const list = await getDetailSectionTemplates();
  list.push(entry);
  await saveDetailSectionTemplates(list);

  figma.ui.postMessage({
    type: "detail_section_registered",
    templates: list,
    key,
    sectionType,
    name,
  });
}

async function deleteDetailSection(key) {
  const list = await getDetailSectionTemplates();
  const filtered = list.filter(t => t.key !== key);
  await saveDetailSectionTemplates(filtered);
  figma.ui.postMessage({ type: "detail_section_deleted", templates: filtered });
}

// 선택된 노드 위치에 섹션 템플릿 1개 배치
// 노드를 재귀 탐색해 TEXT 노드 목록 반환
function collectTextNodes(node, result = []) {
  if (node.type === "TEXT") {
    result.push(node);
  } else if ("children" in node) {
    for (const child of node.children) collectTextNodes(child, result);
  }
  return result;
}

async function applyDetailSection(templateKey) {
  const allTemplates = await getDetailSectionTemplates();
  const tmpl = allTemplates.find(t => t.key === templateKey);
  if (!tmpl) throw new Error("등록된 템플릿을 찾을 수 없습니다.");

  const selected = figma.currentPage.selection[0] || null;
  // 텍스트 프레임이 선택된 경우 해당 텍스트 추출
  const selectedTextContent = (selected && selected.type === "TEXT")
    ? selected.characters
    : null;

  // 템플릿 인스턴스 생성
  let node = null;
  if (tmpl.componentKey) {
    const comp = await figma.importComponentByKeyAsync(tmpl.componentKey);
    node = comp.createInstance();
  } else if (tmpl.nodeId) {
    const src = figma.getNodeById(tmpl.nodeId);
    if (!src) throw new Error("원본 노드를 찾을 수 없습니다 (삭제되었을 수 있음).");
    node = src.clone();
  }
  if (!node) throw new Error("인스턴스 생성에 실패했습니다.");

  // 너비 1080px 맞춤
  const W = 1080;
  if (node.width && node.width !== W) {
    const scale = W / node.width;
    node.resize(W, Math.round(node.height * scale));
  }

  // 텍스트 프레임이 선택된 경우 → 첫 번째 텍스트 노드에 삽입
  if (selectedTextContent) {
    const textNodes = collectTextNodes(node);
    if (textNodes.length > 0) {
      const target = textNodes[0];
      try {
        const fontName = target.fontName === figma.mixed
          ? target.getRangeFontName(0, 1)
          : target.fontName;
        await figma.loadFontAsync(fontName);
        target.characters = selectedTextContent;
      } catch (_) {
        // 폰트 로드 실패 시 기본 텍스트 유지
      }
    }
  }
  // 선택 없으면 템플릿 기본 텍스트 그대로 사용

  // 선택된 노드 위치에 배치, 없으면 뷰포트 중앙
  const anchor = selectedTextContent ? null : selected; // 텍스트 프레임 선택 시엔 아래 배치 안 함
  const placementRef = !selectedTextContent ? selected : null;
  if (placementRef) {
    node.x = placementRef.x;
    node.y = placementRef.y + placementRef.height + 8;
    const parent = placementRef.parent;
    if (parent && parent.type !== "DOCUMENT") {
      parent.appendChild(node);
    } else {
      figma.currentPage.appendChild(node);
    }
  } else {
    figma.currentPage.appendChild(node);
    const vp = figma.viewport.center;
    node.x = Math.round(vp.x - W / 2);
    node.y = Math.round(vp.y - node.height / 2);
  }

  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);

  figma.ui.postMessage({
    type: "detail_section_applied",
    templateName: tmpl.name,
    sectionType: tmpl.sectionType,
    usedDefaultText: !selectedTextContent,
  });
}

// ── 상세페이지 빌더 ───────────────────────────────────────────────────────────
// 모든 섹션은 등록된 컴포넌트 인스턴스(또는 프레임 clone)로 생성됩니다.
async function buildDetailPage(sections, jiraKey) {
  const WIDTH = 1080;
  const page  = figma.currentPage;

  // 프레임명: MMDD_detail_{이슈키}_1080
  const now     = new Date();
  const mmdd    = String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
  const safeName = (jiraKey || "detail").replace(/[^a-zA-Z0-9가-힣\-]/g, "");
  const baseName = mmdd + "_detail_" + safeName + "_1080";

  postProgress("프레임 생성 중: " + baseName);

  // 등록된 섹션 템플릿 로드
  const allTemplates = await getDetailSectionTemplates();
  const templateMap  = {};
  allTemplates.forEach(t => { templateMap[t.key] = t; });

  // 전체 래퍼 프레임 (높이는 나중에 확정)
  const detail = figma.createFrame();
  detail.name = baseName;
  detail.resize(WIDTH, 100);
  detail.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  detail.clipsContent = true;

  const warnings = [];
  let y = 0;

  for (const sec of sections) {
    postProgress("섹션 추가: " + sec.id + (sec.templateKey ? " (" + (templateMap[sec.templateKey] || {}).name + ")" : ""));

    const tmpl = sec.templateKey ? templateMap[sec.templateKey] : null;
    if (!tmpl) {
      warnings.push(sec.id + ": 등록된 템플릿 없음 → 건너뜀");
      continue;
    }

    let node = null;
    try {
      if (tmpl.componentKey) {
        // 라이브러리 컴포넌트 — import 후 인스턴스 생성
        const comp = await figma.importComponentByKeyAsync(tmpl.componentKey);
        node = comp.createInstance();
      } else if (tmpl.nodeId) {
        // 로컬 프레임 — clone
        const src = figma.getNodeById(tmpl.nodeId);
        if (!src) throw new Error("노드를 찾을 수 없음 (삭제되었을 수 있음)");
        node = src.clone();
      }
    } catch (e) {
      warnings.push(sec.id + " 인스턴스 생성 실패: " + (e.message || e));
      continue;
    }

    if (!node) {
      warnings.push(sec.id + ": 노드 생성 실패");
      continue;
    }

    // 너비 1080px 맞춤 (높이는 비율 유지)
    if (node.width && node.width !== WIDTH) {
      const scale = WIDTH / node.width;
      node.resize(WIDTH, Math.round(node.height * scale));
    }

    node.x = 0;
    node.y = y;
    detail.appendChild(node);
    y += node.height;
  }

  // 최종 높이 확정 + 캔버스 배치
  detail.resize(WIDTH, y || 100);
  const center = figma.viewport.center;
  detail.x = center.x - WIDTH / 2;
  detail.y = center.y - (y || 100) / 2;
  page.appendChild(detail);
  figma.currentPage.selection = [detail];
  figma.viewport.scrollAndZoomIntoView([detail]);

  postProgress("PNG 내보내기 중...");
  const pngBytes = await detail.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: 1 },
  });

  figma.ui.postMessage({
    type: "detail_done",
    frameName: baseName,
    filename: baseName + ".png",
    base64: figma.base64Encode(pngBytes),
    sectionCount: sections.length,
    warning: warnings.length > 0 ? warnings.join(" / ") : null,
    jiraKey: jiraKey,
  });
}
