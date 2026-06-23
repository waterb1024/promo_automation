"""
수정본 판별 + zip 파일명 생성.

옵션 B (자동): Jira 이슈의 기존 첨부를 보고 첫 업로드 vs 수정본을 판단.

규칙:
  - 같은 날짜(date)·같은 프로모션의 zip이 이미 있다 → 수정본
      - 첫 수정 → "{date}_{promotion}_수정.zip"
      - 추가 수정 → "..._수정2.zip", "..._수정3.zip", ...
  - 같은 프로모션의 zip이 있지만 날짜가 다르다 → 새 작업 ("{새date}_{promotion}.zip")
  - 아예 없다 → 첫 업로드 ("{date}_{promotion}.zip")

베이스 매칭은 "{date}_{promotion}" 접두로만 한다(엄격하게).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List


@dataclass
class RevisionDecision:
    zip_filename: str
    is_revision: bool
    revision_index: int   # 0 = 첫업로드/날짜다름, 1 = 수정, 2 = 수정2, ...


_SUFFIX_RE = re.compile(r"^_수정(\d*)$")


def decide(
    today_mmdd: str,
    promotion: str,
    existing_filenames: List[str],
) -> RevisionDecision:
    base_today = f"{today_mmdd}_{promotion}"
    promo_suffix = f"_{promotion}"

    # 1) 같은 프로모션의 zip 모으기
    same_promo_zips = []
    for name in existing_filenames:
        if not name.lower().endswith(".zip"):
            continue
        stem = name[:-4]
        # stem에서 date 추출 시도
        m = re.match(r"^(\d{4})_(.+)$", stem)
        if not m:
            continue
        date_part, rest = m.group(1), m.group(2)
        # rest 가 "{promotion}" 또는 "{promotion}_수정[N]" 인지
        if rest == promotion:
            same_promo_zips.append((date_part, ""))
        elif rest.startswith(promotion):
            tail = rest[len(promotion):]
            sm = _SUFFIX_RE.match(tail)
            if sm:
                same_promo_zips.append((date_part, tail))

    if not same_promo_zips:
        # 첫 업로드
        return RevisionDecision(
            zip_filename=f"{base_today}.zip",
            is_revision=False,
            revision_index=0,
        )

    # 2) 오늘 날짜와 같은 zip이 있는지
    same_date_tails = [tail for (d, tail) in same_promo_zips if d == today_mmdd]
    if not same_date_tails:
        # 같은 프로모션의 다른 날짜 zip만 있음 → 새 날짜로 첫 업로드
        return RevisionDecision(
            zip_filename=f"{base_today}.zip",
            is_revision=False,
            revision_index=0,
        )

    # 3) 같은 날짜의 zip이 있다 → 수정본. 다음 번호 채번.
    used_indices = set()
    for tail in same_date_tails:
        if tail == "":
            used_indices.add(0)  # 최초 zip
        else:
            m = _SUFFIX_RE.match(tail)
            if m:
                n = m.group(1)
                used_indices.add(int(n) if n else 1)

    # 다음 idx: 1, 2, 3, ... 중 비어있는 가장 작은 값 (단 0 제외)
    next_idx = 1
    while next_idx in used_indices:
        next_idx += 1

    suffix = "_수정" if next_idx == 1 else f"_수정{next_idx}"
    return RevisionDecision(
        zip_filename=f"{base_today}{suffix}.zip",
        is_revision=True,
        revision_index=next_idx,
    )


# 자체 테스트 (python -m scripts.revision)
if __name__ == "__main__":
    def show(label, *args):
        print(label, decide(*args))

    show("first upload",      "0518", "summersale", [])
    show("after first",       "0518", "summersale", ["0518_summersale.zip"])
    show("after 수정",         "0518", "summersale", ["0518_summersale.zip", "0518_summersale_수정.zip"])
    show("after 수정 + 수정2", "0518", "summersale",
         ["0518_summersale.zip", "0518_summersale_수정.zip", "0518_summersale_수정2.zip"])
    show("new date",          "0519", "summersale", ["0518_summersale.zip", "0518_summersale_수정.zip"])
    show("unrelated zip",     "0518", "summersale", ["0517_winterfair.zip"])
