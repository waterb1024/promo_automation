"""
프레임명 파서.

규칙 (모두 밑줄 _ 로 구분):
  배너: MMDD_banner_{promotion}_{w}x{h}     예) 0518_banner_summersale_984x264
  팝업: MMDD_popup_{promotion}_{w}x{h}      예) 0518_popup_summersale_960x1140
  랜딩: MMDD_landing_{promotion}_{w}        예) 0518_landing_summersale_1080

프로모션명에 밑줄이 포함될 수 있어 "맨 앞 2개 + 맨 뒤 1개"를 고정 위치로 처리.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

VALID_TYPES = ("banner", "popup", "landing")


@dataclass(frozen=True)
class ParsedFrameName:
    date: str            # MMDD
    type: str            # banner | popup | landing
    promotion: str
    intended_width: int
    intended_height: Optional[int]  # 랜딩은 None
    original: str

    @property
    def has_explicit_height(self) -> bool:
        return self.intended_height is not None


def parse_frame_name(name: str) -> Optional[ParsedFrameName]:
    """이름이 규칙에 안 맞으면 None. 호출부에서 경고 처리."""
    if not name:
        return None

    parts = name.split("_")
    if len(parts) < 4:
        return None

    date = parts[0]
    type_ = parts[1]
    size_token = parts[-1]
    promotion = "_".join(parts[2:-1])

    if not (len(date) == 4 and date.isdigit()):
        return None
    if type_ not in VALID_TYPES:
        return None
    if not promotion:
        return None

    intended_width: int
    intended_height: Optional[int] = None

    if "x" in size_token:
        wh = size_token.split("x")
        if len(wh) != 2:
            return None
        if not (wh[0].isdigit() and wh[1].isdigit()):
            return None
        intended_width = int(wh[0])
        intended_height = int(wh[1])
    else:
        if not size_token.isdigit():
            return None
        intended_width = int(size_token)

    return ParsedFrameName(
        date=date,
        type=type_,
        promotion=promotion,
        intended_width=intended_width,
        intended_height=intended_height,
        original=name,
    )


def compute_scale(parsed: ParsedFrameName, actual_width: float) -> float:
    """
    Figma REST images 엔드포인트의 scale 파라미터 계산.
    실제 frame width 가 의도된 width 의 N 배면 scale = 1/N.

    안전장치: 비정상 비율은 1.0으로 떨어뜨림 (이후 export 단계에서 경고).
    """
    if actual_width is None or actual_width <= 0:
        return 1.0
    s = parsed.intended_width / float(actual_width)
    if s <= 0 or not _is_finite(s):
        return 1.0
    return s


def _is_finite(x: float) -> bool:
    return x == x and x not in (float("inf"), float("-inf"))


# 자체 테스트 (python -m scripts.frame_parser)
if __name__ == "__main__":
    cases = [
        ("0518_banner_summersale_984x264", True),
        ("0518_popup_summersale_960x1140", True),
        ("0518_landing_summersale_1080", True),
        ("0518_banner_summer_big_sale_984x264", True),   # 밑줄 포함 프로모션
        ("0518_landing_summer_big_sale_1080", True),
        ("0518_xxx_summersale_984x264", False),          # 타입 오타
        ("banner_0518_summersale_984x264", False),       # 순서 뒤바뀜
        ("0518_banner__984x264", False),                 # promotion 비어있음
        ("0518_banner_summersale_984264", False),        # 'x' 없는 배너
        ("0518_banner_summersale", False),               # 4토큰 미만
    ]
    for name, should_parse in cases:
        p = parse_frame_name(name)
        ok = (p is not None) == should_parse
        print(("OK " if ok else "FAIL "), name, "→", p)

    # 스케일 테스트
    p = parse_frame_name("0518_banner_summersale_984x264")
    assert p is not None
    assert abs(compute_scale(p, 984) - 1.0) < 1e-9
    assert abs(compute_scale(p, 2952) - (1 / 3)) < 1e-6
    assert compute_scale(p, 0) == 1.0
    print("scale tests passed")
