"""UTF-8 호환 zip 빌더. Mac ↔ Windows 한글 파일명 깨짐 방지."""
from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Iterable, Tuple


def write_utf8_zip(zip_path: Path, entries: Iterable[Tuple[str, bytes]]) -> int:
    """
    entries: (filename, bytes) 시퀀스.
    UTF-8 플래그(0x800)를 명시적으로 켜서 Windows Explorer/Mac Archive Utility 양쪽 호환.
    반환: 압축 전 총 바이트 합계.
    """
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename, data in entries:
            zi = zipfile.ZipInfo(filename)
            zi.flag_bits |= 0x800
            zi.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(zi, data)
            total += len(data)
    return total
