// Promotion Automation - Figma plugin main thread (Phase 1)
// 선택 프레임 → PNG 추출 → UI 로 base64 전달 → UI 가 Helper 호출
//
// 프레임명 규칙 (모두 _ 로 구분):
//   배너 : MMDD_banner_{promotion}_{w}x{h}
//   팝업 : MMDD_popup_{promotion}_{w}x{h}
//   랜딩 : MMDD_landing_{promotion}_{w}
// 프로모션명에 _ 가 포함될 수 있어 "앞 2개(date,type) + 뒤 1개(size) 고정,
// 가운데 모두 promotion" 으로 파싱.

figma.showUI(__html__, { width: 440, height: 800 });

const TYPES = ["banner", "popup", "landing"];

function parseFrameName(name) {
  const parts = name.split("_");
  if (parts.length < 4) return null;

  const date = parts[0];
  const type = parts[1];
  const sizeToken = parts[parts.length - 1];
  const promotion = parts.slice(2, -1).join("_");

  if (!/^\d{4}$/.test(date)) return null;
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
  const counts = { banner: 0, popup: 0, landing: 0 };
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
    metadata: { date: date, promotion: promotion, counts: counts },
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

  const target = _pickPrimaryImageHolder(root);
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
    width: Math.max(64, Math.round(target.width)),
    height: Math.max(64, Math.round(target.height)),
    texts: texts,
    kind: opts.kind || "popup",
    extraHint: opts.extraHint || null,
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
    node.fills = [{
      type: "IMAGE",
      scaleMode: "FILL",
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
  let frameBgApplied = null;
  const frameNodeId = msg && msg.frameNodeId;
  const bgHex = msg && msg.backgroundColor;
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
        if (frameNode && "fills" in frameNode) {
          frameNode.fills = [{ type: "SOLID", color: rgb }];
          frameBgApplied = bgHex;
        }
      } catch (e) {
        // 배경 적용 실패는 치명적 아니므로 done 메시지에 경고만 실어 보냄
        frameBgApplied = "ERROR: " + (e && e.message ? e.message : String(e));
      }
    }
  }

  figma.ui.postMessage({
    type: "image_generate_done",
    targetName: node.name || "(이름 없음)",
    prompt: msg.prompt || null,
    frameBgApplied: frameBgApplied,
  });
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
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};

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
