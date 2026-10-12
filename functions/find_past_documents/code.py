#input_type_name: FindPastDocumentsInput
#output_type_name: FindPastDocumentsResult

#function_name: find_past_documents

import base64
import re
from datetime import datetime, timezone
from email.utils import parseaddr
from io import BytesIO

from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod

# Finds documents the person has already sent — invoices, offer letters, proposals,
# agreements — and files a copy under /me/reference/ so the next one can be written the
# same way. Read-only on the mailbox: it searches sent mail and saves attachments into
# the person's own private folder. It never sends, replies or changes a message.
#
# The order is the point. A document for someone who has had one before should look
# like the last one they got, so the search goes: same recipient, then anyone at their
# company, then the same kind of document sent to anybody. It stops at the first rung
# that finds something, and says which rung that was.
#
# Once a file is saved the pod converts it, so the caller reads
# <path>/document.md for the words and <path>/pages/page_0001.jpg for the look.

MAX_BYTES = 12 * 1024 * 1024
KEEP = (".pdf", ".docx", ".doc", ".xlsx", ".odt", ".rtf")
# Addresses at these domains say nothing about which company someone is at.
PERSONAL = {"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
            "yahoo.com", "yahoo.co.in", "icloud.com", "me.com", "proton.me",
            "protonmail.com", "rediffmail.com", "aol.com"}


class FindPastDocumentsInput(BaseModel):
    # What kind of document, in the words that would appear in its file name or subject:
    # "invoice", "offer letter", "proposal", "LOI", "NDA".
    kind: str
    # Who the new document is for. Empty searches for the kind sent to anyone.
    recipient_email: str = ""
    max_documents: int = 3
    account_id: str | None = None      # which mailbox, when the person has more than one


class PastDocument(BaseModel):
    path: str = ""                     # where the copy is filed
    file_name: str = ""
    sent_on: str = ""                  # YYYY-MM-DD
    sent_to: list[str] = Field(default_factory=list)
    subject: str = ""
    match: str = ""                    # same_recipient | same_company | same_kind
    already_filed: bool = False


class FindPastDocumentsResult(BaseModel):
    documents: list[PastDocument] = Field(default_factory=list)
    match: str = ""                    # the rung that found them; empty when none
    note: str = ""
    errors: list[str] = Field(default_factory=list)


def _dig(o, key):
    if isinstance(o, dict):
        if key in o and o[key]:
            return o[key]
        for v in o.values():
            r = _dig(v, key)
            if r:
                return r
    return None


def _slug(text: str, limit: int = 60) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:limit] or "file"


def _date(ts) -> str:
    s = str(ts or "")
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%fZ"):
        try:
            return datetime.strptime(s, fmt).astimezone(timezone.utc).strftime("%Y-%m-%d")
        except ValueError:
            pass
    if s.isdigit():
        return datetime.fromtimestamp(int(s) / 1000, timezone.utc).strftime("%Y-%m-%d")
    return s[:10]


def _addrs(raw: str) -> list[str]:
    return [a for a in (parseaddr(x)[1].lower() for x in re.split(r"[,;]", raw or "")) if a]


def _is_kind(text: str, kind: str) -> bool:
    flat = re.sub(r"[^a-z0-9]+", " ", (text or "").lower())
    return all(w in flat for w in re.sub(r"[^a-z0-9]+", " ", kind.lower()).split())


def _search(pod, query: str, use: dict, limit: int) -> list[dict]:
    resp = pod.connectors.execute("gmail", "GMAIL_FETCH_EMAILS", {
        "query": query, "max_results": limit, "verbose": True, "include_spam_trash": False,
    }, **use)
    resp = resp.to_dict() if hasattr(resp, "to_dict") else resp
    r = resp.get("result", resp) if isinstance(resp, dict) else {}
    body = r.get("data", r) if isinstance(r, dict) else {}
    return (body.get("messages") if isinstance(body, dict) else None) or r.get("messages") or []


async def find_past_documents(ctx: FunctionContext, data: FindPastDocumentsInput) -> FindPastDocumentsResult:
    pod = Pod.from_env()
    res = FindPastDocumentsResult()
    kind = " ".join((data.kind or "").split())
    if not kind:
        res.note = "say what kind of document to look for"
        return res
    use = {"account_id": data.account_id} if (data.account_id or "").strip() else {}
    want = max(1, min(data.max_documents, 5))

    try:
        st = pod.connectors.status()
        on = {str(a.get("connector_id") or "").lower()
              for a in (st.get("connected_accounts") or st.get("accounts") or [])
              if isinstance(a, dict) and a.get("status") == "CONNECTED"}
        if "gmail" not in on and "outlook" in on:
            res.note = ("Earlier documents can only be looked up in Gmail for now. Use the "
                        "details file and ask the person for an example to copy.")
            return res
    except Exception:
        pass

    # The kind, as a phrase or as a file name: "offer letter" also matches offer-letter.pdf
    words = f'("{kind}" OR filename:{_slug(kind)} OR filename:{kind.split()[0]})'
    base = f"in:sent has:attachment {words}"
    to = (data.recipient_email or "").strip().lower()
    domain = to.split("@")[-1] if "@" in to else ""

    rungs: list[tuple[str, str]] = []
    if to:
        rungs.append(("same_recipient", f"{base} {{to:{to} cc:{to}}}"))
    if domain and domain not in PERSONAL:
        rungs.append(("same_company", f"{base} {{to:{domain} cc:{domain}}}"))
    rungs.append(("same_kind", base))

    kind_slug = _slug(kind, 30)
    for match, query in rungs:
        try:
            msgs = _search(pod, query, use, 15)
        except Exception as exc:
            res.errors.append(f"Gmail search failed: {str(exc)[:160]}")
            break
        # newest first: the latest one sent is the one the format should follow
        msgs.sort(key=lambda m: str(m.get("messageTimestamp") or m.get("internalDate") or ""), reverse=True)
        for m in msgs:
            if len(res.documents) >= want:
                break
            mid = str(m.get("messageId") or m.get("id") or "")
            sent_on = _date(m.get("messageTimestamp") or m.get("internalDate"))
            sent_to = _addrs(m.get("to") or "")
            subject_hit = _is_kind(m.get("subject") or "", kind)
            files = [a for a in (m.get("attachmentList") or [])
                     if mid and a.get("attachmentId") and (a.get("filename") or "").lower().endswith(KEEP)]
            named = [a for a in files if _is_kind(a.get("filename") or "", kind)]
            # A mail that mentions an invoice can carry an agreement. Take the files named
            # for the kind; take an unnamed one only when the subject itself says the kind.
            for a in (named or (files if subject_hit else [])):
                name = a.get("filename") or ""
                if len(res.documents) >= want:
                    break
                stem, dot, ext = name.rpartition(".")
                who = _slug((sent_to[0] if sent_to else "unknown").split("@")[0], 24)
                path = f"/me/reference/{kind_slug}/{sent_on}-{who}-{_slug(stem, 40)}.{ext.lower()}"
                doc = PastDocument(path=path, file_name=name, sent_on=sent_on, sent_to=sent_to,
                                   subject=(m.get("subject") or "").strip(), match=match)
                try:
                    pod.files.get(path)
                    doc.already_filed = True
                    res.documents.append(doc)
                    continue
                except Exception:
                    pass
                try:
                    out = pod.connectors.execute("gmail", "GMAIL_GET_ATTACHMENT", {
                        "message_id": mid, "attachment_id": a["attachmentId"], "file_name": name,
                    }, **use)
                    out = out.to_dict() if hasattr(out, "to_dict") else out
                    b64 = _dig(out, "content_base64") or _dig(out, "contentBytes") or ""
                    if not b64:
                        res.errors.append(f"{name}: Gmail returned no file")
                        continue
                    raw = base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)) if re.search(r"[-_]", b64) \
                        else base64.b64decode(b64)
                    if len(raw) > MAX_BYTES:
                        res.errors.append(f"{name}: too large to file")
                        continue
                    directory, _, fname = path.rpartition("/")
                    pod.files.upload_file(BytesIO(raw), path=path, filename=fname,
                                          directory_path=directory, search_enabled=True)
                    res.documents.append(doc)
                except Exception as exc:
                    res.errors.append(f"{name}: {str(exc)[:160]}")
        if res.documents:
            res.match = match
            break

    if not res.documents:
        res.note = (f"No earlier {kind} found in sent mail. Write it in the normal shape of "
                    "that document, taking official details only from /me/business.md.")
    elif res.match == "same_recipient":
        res.note = "Sent to this person before. Follow the newest one exactly."
    elif res.match == "same_company":
        res.note = "Sent to someone else at their company. Follow it, and check the addressee."
    else:
        res.note = ("None sent to this person or company. These are the same kind of document "
                    "sent to others: follow the layout, and take nothing about the recipient from them.")
    return res
