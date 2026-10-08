#input_type_name: SourcesInput
#output_type_name: SourcesResult
#function_name: sources_status

# What the Settings and onboarding screens show: every source this product can read,
# whether it is installed for the org, and whether *you* have connected it.
#
# Being unconnected is a normal state, not an error. Every source is optional and
# skippable — someone with no Granola still gets a working product from mail alone.

from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod

# app id -> (label, why it matters, leaned on heavily, shown during onboarding)
#
# Order is the order they appear. The first three are the onboarding set, and Gmail
# is deliberately first: it is the one source that makes the product work on its own.
# Anything added later lands below them and stays out of onboarding, which should
# never grow into a list somebody has to read.
KNOWN = [
    ("gmail", "Gmail", "Threads, who spoke last, and what was asked of you.", True, True),
    ("google_calendar", "Google Calendar", "Who you are meeting, and what was agreed but never booked.", True, True),
    # Microsoft 365: mail and calendar in one sign-in. Either this or Gmail is enough.
    ("outlook", "Outlook", "Mail and calendar, for work that lives in Microsoft 365.", True, True),
    ("granola", "Granola", "Meeting notes and action items — where a promise made out loud gets written down. Sign in with your own Granola account; the free plan is enough.", False, True),
    ("googlemeet", "Google Meet", "Call transcripts, where Meet recorded one.", False, False),
    ("slack", "Slack", "The channels you invited the app to, where the day's asks land.", False, False),
]


class SourcesInput(BaseModel):
    pass


class SourceOut(BaseModel):
    app: str
    label: str
    why: str
    important: bool
    # Shown on the first-run screen. Everything else lives in Settings.
    onboarding: bool = False
    # Position within its group, so the client never has to know the order.
    order: int = 0
    installed: bool = False
    self_installable: bool = False
    connected: bool = False
    account_label: str | None = None
    # every account of mine for this source: [{id, email, default}]
    accounts: list[dict] = Field(default_factory=list)


class SourcesResult(BaseModel):
    sources: list[SourceOut] = Field(default_factory=list)
    connected_count: int = 0
    onboarding_connected_count: int = 0
    errors: list[str] = Field(default_factory=list)


# Sources `connect_source` can install by itself, so a freshly cloned pod never
# sends anybody to an admin console. Kept in step with INSTALL over there.
SELF_INSTALLABLE = {"gmail", "google_calendar", "outlook", "googlemeet", "granola"}


async def sources_status(ctx: FunctionContext, data: SourcesInput) -> SourcesResult:
    pod = Pod.from_env()
    res = SourcesResult()

    # Accounts belong to the organisation. Only MY accounts count: a teammate's Gmail
    # must never make me look connected, nor be the mailbox my runs read.
    uid = str(getattr(ctx, "user_id", "") or "")
    installed: set[str] = set()
    mine: dict[str, list[dict]] = {}
    try:
        cfgs = pod.connectors.auth_configs.list().to_dict()
        cfg_items = cfgs.get("items", cfgs) if isinstance(cfgs, dict) else cfgs
        # An MCP install is named by its auth config, not its connector id: Granola and
        # any other MCP server all report connector_id "mcp".
        by_cfg_id = {str(c.get("id")): str(c.get("name", "")).lower() for c in cfg_items}
        for c in cfg_items:
            for k in ("connector_id", "name"):
                if c.get(k):
                    installed.add(str(c.get(k)).lower())

        accts = pod.connectors.accounts.list().to_dict()
        acct_items = accts.get("items", accts) if isinstance(accts, dict) else accts
        for a in acct_items:
            if a.get("status") != "CONNECTED":
                continue
            if uid and str(a.get("user_id") or "") != uid:
                continue
            entry = {"id": str(a.get("id")), "email": a.get("email") or a.get("display_name") or "",
                     "default": bool(a.get("is_default"))}
            for key in {str(a.get("connector_id") or "").lower(), by_cfg_id.get(str(a.get("auth_config_id")), "")}:
                if key:
                    mine.setdefault(key, []).append(entry)
    except Exception as exc:
        res.errors.append(f"accounts unavailable: {str(exc)[:160]}")
    accounts = {k: (v[0]["email"] if v else "") for k, v in mine.items()}

    for i, (app, label, why, important, onboarding) in enumerate(KNOWN):
        connected = app in accounts
        res.sources.append(SourceOut(
            app=app, label=label, why=why, important=important,
            onboarding=onboarding, order=i,
            # "Installed" means the organisation has it. Not being installed is
            # normal and not a blocker: connect_source sets it up on the way past.
            installed=app in installed or connected,
            self_installable=app in SELF_INSTALLABLE,
            connected=connected,
            account_label=accounts.get(app) or None,
            accounts=sorted(mine.get(app, []), key=lambda a: not a["default"]),
        ))
    res.connected_count = sum(1 for s in res.sources if s.connected)
    res.onboarding_connected_count = sum(
        1 for s in res.sources if s.connected and s.onboarding)
    return res
