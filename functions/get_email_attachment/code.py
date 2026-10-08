#input_type_name: GetAttachmentInput
#output_type_name: GetAttachmentResult

#function_name: get_email_attachment

import re

from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod

# One attachment from a Gmail message, so the thread beside the Feed can open it.
# Read-only. Returns the bytes as base64; the app turns them into a file to open.

MAX_BYTES = 12 * 1024 * 1024


class GetAttachmentInput(BaseModel):
    message_id: str
    attachment_id: str
    file_name: str = "attachment"
    account_id: str | None = None      # which mailbox, when the person has more than one


class GetAttachmentResult(BaseModel):
    content_base64: str = ""
    mime: str = ""
    file_name: str = ""
    error: str = ""


def _dig(o, key):
    if isinstance(o, dict):
        if key in o and o[key]:
            return o[key]
        for v in o.values():
            r = _dig(v, key)
            if r:
                return r
    return None


async def get_email_attachment(ctx: FunctionContext, data: GetAttachmentInput) -> GetAttachmentResult:
    pod = Pod.from_env()
    res = GetAttachmentResult(file_name=data.file_name)
    # Gmail message ids are short hex; anything else here is an Outlook message id
    outlook = not re.fullmatch(r"[0-9a-f]{10,24}", (data.message_id or "").strip())
    where = "Outlook" if outlook else "Gmail"
    use = {"account_id": data.account_id} if (data.account_id or "").strip() else {}
    try:
        if outlook:
            out = pod.connectors.execute("outlook", "OUTLOOK_GET_USER_MESSAGES_ATTACHMENTS", {
                "message_id": data.message_id, "attachment_id": data.attachment_id, "user_id": "me",
            }, **use)
        else:
            out = pod.connectors.execute("gmail", "GMAIL_GET_ATTACHMENT", {
                "message_id": data.message_id, "attachment_id": data.attachment_id, "file_name": data.file_name,
            }, **use)
        out = out.to_dict() if hasattr(out, "to_dict") else out
    except Exception as exc:
        res.error = f"{where} would not open it: {str(exc)[:160]}"
        return res
    # Graph hands the bytes back as `contentBytes`, already base64
    b64 = _dig(out, "content_base64") or _dig(out, "contentBytes") or ""
    if not b64:
        res.error = f"{where} returned no file."
        return res
    if len(b64) * 3 // 4 > MAX_BYTES:
        res.error = f"Too large to open here — open it in {where}."
        return res
    res.content_base64 = b64
    res.mime = _dig(out, "mimetype") or _dig(out, "mime_type") or _dig(out, "contentType") or ""
    return res
