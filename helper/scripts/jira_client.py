"""
Way (Jira Server/Data Center) 클라이언트.

인증 우선순위:
  1) PAT (있으면) → Authorization: Bearer
  2) Basic (username + password) → Authorization: Basic
  3) Basic 으로 401 받으면 세션 로그인 자동 시도
       POST /rest/auth/1/session → JSESSIONID cookie 획득
       이후 호출은 Cookie 헤더로 진행

reporter 멘션 형식 (Server/DC): [~{username}]
"""
from __future__ import annotations

import base64
import json
import mimetypes
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import urllib.error
import urllib.request


class JiraError(RuntimeError):
    pass


@dataclass
class JiraAttachment:
    id: str
    filename: str
    size: int
    created: str
    author: str  # username
    content_url: str  # 다운로드용 절대 URL


@dataclass
class JiraIssue:
    key: str
    reporter_username: str
    reporter_display: str
    attachments: List[JiraAttachment]
    summary: str = ""
    description: str = ""  # Server/DC: wiki markup 또는 plain text
    assignee_username: str = ""
    assignee_display: str = ""


class JiraClient:
    def __init__(
        self,
        base_api_url: str,
        session_login_url: Optional[str] = None,
        pat: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
        timeout: int = 60,
    ):
        if not (pat or (username and password)):
            raise JiraError("Jira 인증 정보 없음 (pat 또는 username+password 필요).")
        self.base = base_api_url.rstrip("/")
        self.session_login_url = session_login_url
        self.pat = pat
        self.username = username
        self.password = password
        self.timeout = timeout
        # 세션 로그인이 성공하면 이후 호출은 Cookie 사용
        self._session_cookie: Optional[str] = None

    # ---------- Public API ----------

    def get_issue(self, key: str) -> JiraIssue:
        body = self._send(
            "GET",
            f"/issue/{key}?fields=reporter,attachment,summary,description,assignee",
        )
        data = json.loads(body.decode("utf-8"))
        fields = data.get("fields") or {}

        reporter = fields.get("reporter") or {}
        assignee = fields.get("assignee") or {}
        atts_raw = fields.get("attachment") or []
        atts = [
            JiraAttachment(
                id=str(a.get("id", "")),
                filename=a.get("filename", ""),
                size=int(a.get("size") or 0),
                created=a.get("created", ""),
                author=((a.get("author") or {}).get("name") or ""),
                content_url=a.get("content", ""),
            )
            for a in atts_raw
        ]
        return JiraIssue(
            key=data.get("key", key),
            reporter_username=reporter.get("name") or "",
            reporter_display=reporter.get("displayName") or "",
            attachments=atts,
            summary=fields.get("summary") or "",
            description=fields.get("description") or "",
            assignee_username=assignee.get("name") or "",
            assignee_display=assignee.get("displayName") or "",
        )

    def download_attachment(self, content_url: str) -> bytes:
        """첨부 파일의 절대 URL 로부터 raw bytes 다운로드. 인증 헤더 자동 첨부 + 401 폴백."""
        if not content_url:
            raise JiraError("content_url 이 비어있습니다.")

        for attempt in range(2):
            req = urllib.request.Request(content_url, method="GET")
            req.add_header("Accept", "*/*")
            for k, v in self._auth_headers().items():
                req.add_header(k, v)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout * 2) as resp:
                    return resp.read()
            except urllib.error.HTTPError as e:
                fallback_eligible = (
                    attempt == 0
                    and e.code in (401, 403)
                    and not self._session_cookie
                    and not self.pat
                    and self.username
                    and self.password
                    and self.session_login_url
                )
                if fallback_eligible:
                    self._do_session_login()
                    continue
                detail = e.read().decode("utf-8", errors="replace")
                raise JiraError(
                    f"첨부 다운로드 실패 HTTP {e.code}: {detail[:300]}"
                ) from e
            except urllib.error.URLError as e:
                raise JiraError(f"첨부 다운로드 연결 실패 {content_url}: {e}") from e

        raise JiraError("첨부 다운로드 재시도 한도 초과")

    def upload_attachment(self, key: str, file_path: Path) -> List[dict]:
        boundary = "----promo-export-" + uuid.uuid4().hex
        body, content_type = _build_multipart(file_path, boundary)
        extra = {
            "Content-Type": content_type,
            "X-Atlassian-Token": "no-check",  # XSRF 우회 (Atlassian 공식)
        }
        resp = self._send(
            "POST",
            f"/issue/{key}/attachments",
            data=body,
            extra_headers=extra,
            json_body=False,
        )
        return json.loads(resp.decode("utf-8"))

    def add_comment(self, key: str, body_text: str) -> dict:
        payload = json.dumps({"body": body_text}).encode("utf-8")
        resp = self._send("POST", f"/issue/{key}/comment", data=payload)
        return json.loads(resp.decode("utf-8"))

    # ---------- 내부 ----------

    def _auth_headers(self) -> dict:
        """현재 상태에 따른 인증 헤더."""
        if self._session_cookie:
            return {"Cookie": self._session_cookie}
        if self.pat:
            return {"Authorization": f"Bearer {self.pat}"}
        if self.username and self.password:
            raw = f"{self.username}:{self.password}".encode("utf-8")
            return {"Authorization": "Basic " + base64.b64encode(raw).decode("ascii")}
        raise JiraError("사용 가능한 인증 정보가 없습니다.")

    def _do_session_login(self) -> None:
        """Basic이 막혀있을 때 호출. 성공 시 self._session_cookie 채움."""
        if not (self.session_login_url and self.username and self.password):
            raise JiraError("세션 로그인에 필요한 정보가 부족합니다.")
        payload = json.dumps({
            "username": self.username,
            "password": self.password,
        }).encode("utf-8")
        req = urllib.request.Request(self.session_login_url, data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise JiraError(
                f"Way 세션 로그인 실패 HTTP {e.code}: {detail[:300]}"
            ) from e
        except urllib.error.URLError as e:
            raise JiraError(f"Way 세션 로그인 연결 실패: {e}") from e

        sess = body.get("session") or {}
        name = sess.get("name") or "JSESSIONID"
        value = sess.get("value")
        if not value:
            raise JiraError(f"세션 응답에 cookie value 없음: {body}")
        self._session_cookie = f"{name}={value}"

    def _send(
        self,
        method: str,
        path: str,
        data: Optional[bytes] = None,
        extra_headers: Optional[dict] = None,
        json_body: bool = True,
    ) -> bytes:
        """단일 요청. 401/403 발생 시 자동으로 세션 로그인 폴백 후 1회 재시도."""
        url = self.base + path
        for attempt in range(2):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Accept", "application/json")
            if data is not None and json_body and "Content-Type" not in (extra_headers or {}):
                req.add_header("Content-Type", "application/json")
            for k, v in self._auth_headers().items():
                req.add_header(k, v)
            for k, v in (extra_headers or {}).items():
                req.add_header(k, v)

            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return resp.read()
            except urllib.error.HTTPError as e:
                # Basic 으로 시도했다가 401/403이고 세션 정보가 있으면 한 번만 폴백
                fallback_eligible = (
                    attempt == 0
                    and e.code in (401, 403)
                    and not self._session_cookie
                    and not self.pat
                    and self.username
                    and self.password
                    and self.session_login_url
                )
                if fallback_eligible:
                    self._do_session_login()
                    continue
                detail = e.read().decode("utf-8", errors="replace")
                raise JiraError(
                    f"Jira {method} {path} → HTTP {e.code}: {detail[:400]}"
                ) from e
            except urllib.error.URLError as e:
                raise JiraError(f"Jira 연결 실패 {url}: {e}") from e

        raise JiraError("Jira 요청 재시도 한도 초과")


# ---------- multipart 빌더 (의존성 없이) ----------

def _build_multipart(file_path: Path, boundary: str) -> tuple[bytes, str]:
    """
    Jira Server/DC 호환 multipart/form-data 빌더.
    한글 파일명 호환을 위해 Content-Disposition 에 다음 두 형식을 같이 보낸다:
      - filename="<UTF-8 raw>"               (modern Jira 가 UTF-8 그대로 해석)
      - filename*=UTF-8''<percent-encoded>   (RFC 5987 fallback)
    구버전 Jira 가 RFC 5987 만 못 받는 경우를 대비.
    """
    from urllib.parse import quote

    filename = file_path.name
    mime, _ = mimetypes.guess_type(filename)
    mime = mime or "application/octet-stream"

    file_bytes = file_path.read_bytes()
    fn_encoded = quote(filename, safe="")
    # filename="..." 안에는 " 와 \ 를 이스케이프해야 안전
    safe_inline = filename.replace("\\", "\\\\").replace('"', '\\"')

    # Content-Disposition 라인은 UTF-8 바이트로 직접 인코딩.
    # 단, 헤더 라인이 UTF-8 raw 를 포함해도 multipart 본문 안이라 latin-1 제약은 없음.
    disposition = (
        f'Content-Disposition: form-data; name="file"; '
        f'filename="{safe_inline}"; '
        f"filename*=UTF-8''{fn_encoded}\r\n"
    ).encode("utf-8")

    parts: list[bytes] = []
    parts.append(f"--{boundary}\r\n".encode("utf-8"))
    parts.append(disposition)
    parts.append(f"Content-Type: {mime}\r\n\r\n".encode("utf-8"))
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))

    body = b"".join(parts)
    content_type = f"multipart/form-data; boundary={boundary}"
    return body, content_type
