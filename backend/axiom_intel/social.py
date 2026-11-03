"""Opt-in official sources; exact contract matching. No scraping or ticker joins."""
import asyncio
import re
import time
from collections import Counter
from datetime import datetime, timezone
from .models import SocialPost, solana_address

ADDRESS = re.compile(r"(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])")
CATEGORIES = {"AI Memes": {"ai", "agent", "robot", "llm"}, "Tiere": {"cat", "dog", "frog", "pepe", "animal"},
              "Politik": {"election", "president", "vote", "politics"}, "Gaming": {"game", "gaming", "gamer"},
              "Internet Culture": {"meme", "viral", "tiktok", "brainrot"},
              "Blockchain": {"solana", "ethereum", "robinhood", "base"}}


def contracts_in(text: str) -> list[str]:
    result = set()
    for a in ADDRESS.findall(text):
        try:
            result.add(solana_address(a))
        except ValueError:
            pass
    return sorted(result)


class SocialEngine:
    def __init__(self, settings, store, providers):
        self.settings, self.store, self.providers = settings, store, providers
        self.posts: list[SocialPost] = []
        self.status = {"x": "disabled", "telegram": "disabled", "reddit": "disabled", "tiktok": "not-available", "last_error": None}

    async def start(self):
        self.posts = [SocialPost.model_validate(p) for p in await self.store.load_events(time.time() - 3600, "social", 10000)]

    async def ingest(self, post: SocialPost):
        post.contracts = contracts_in(post.text)
        if await self.store.insert_event("social", "", post.timestamp, post.model_dump()):
            self.posts.append(post)
            cutoff = time.time() - 3600
            self.posts = [p for p in self.posts[-10000:] if p.timestamp >= cutoff]

    def token_signal(self, token: str, now: float) -> dict:
        recent = [p for p in self.posts if token in p.contracts and now - 600 < p.timestamp <= now]
        authors = {f"{p.platform}:{p.author}" for p in recent}
        normalized = Counter(re.sub(r"\W+", " ", p.text.lower()).strip() for p in recent)
        duplicates = max(normalized.values(), default=0) / len(recent) if recent else 0
        return {"posts_10m": len(recent), "distinct_accounts": len(authors), "duplicate_text_share": duplicates,
                "eligible": len(authors) >= 4 and duplicates < .5,
                "score": min(1, len(authors) / 15) * (1 - duplicates),
                "account_independence_verified": False,
                "note": "Keine bezahlte Promotion oder Bot-Freiheit nachgewiesen"}

    def trends(self, now: float) -> list[dict]:
        out = []
        for category, terms in CATEGORIES.items():
            recent, previous = [], []
            for post in self.posts:
                words = set(re.findall(r"\w+", post.text.lower()))
                if words & terms:
                    if now - 600 < post.timestamp <= now:
                        recent.append(post)
                    elif now - 1200 < post.timestamp <= now - 600:
                        previous.append(post)
            if recent:
                authors = len({(p.platform, p.author) for p in recent})
                out.append({"category": category, "mentions_10m": len(recent), "distinct_accounts": authors,
                            "growth_ratio": len(recent) / len(previous) if previous else None,
                            "contracts": sorted({c for p in recent for c in p.contracts}),
                            "method": "lexical-baseline", "independence_verified": False})
        return sorted(out, key=lambda x: x["distinct_accounts"], reverse=True)

    async def run_x(self):
        import httpx
        s = self.settings
        if not s.x_bearer_token or not s.x_query:
            return
        self.status["x"] = "configured"
        state = await self.store.get("x-budget", {"day": "", "resources": 0, "since_id": None})
        async with httpx.AsyncClient(timeout=20) as client:
            while True:
                today = datetime.now(timezone.utc).date().isoformat()
                if state["day"] != today:
                    state.update(day=today, resources=0)
                remaining = s.x_max_posts_per_day - state["resources"]
                if remaining < 10:
                    self.status["x"] = "daily-budget-paused"
                    await asyncio.sleep(30)
                    continue
                params = {"query": s.x_query, "max_results": min(100, remaining),
                          "tweet.fields": "author_id,created_at,public_metrics"}
                if state.get("since_id"):
                    params["since_id"] = state["since_id"]
                try:
                    r = await client.get("https://api.x.com/2/tweets/search/recent", params=params,
                                         headers={"Authorization": "Bearer " + s.x_bearer_token.get_secret_value()})
                    if r.status_code == 429:
                        reset = float(r.headers.get("x-rate-limit-reset", time.time() + 900))
                        self.status["x"] = "rate-limited"
                        await asyncio.sleep(max(s.x_poll_s, reset - time.time()))
                        continue
                    r.raise_for_status()
                    data = r.json()
                    rows = data.get("data", [])
                    # Charge resources even when subsequent persistence/processing fails.
                    state["resources"] += len(rows)
                    await self.store.set("x-budget", state)
                    for p in rows:
                        metrics = p.get("public_metrics", {})
                        await self.ingest(SocialPost(id="x:" + p["id"], platform="x", author=p["author_id"], text=p["text"],
                                                     timestamp=datetime.fromisoformat(p["created_at"].replace("Z", "+00:00")).timestamp(),
                                                     received_at=time.time(), url=f"https://x.com/i/web/status/{p['id']}",
                                                     likes=metrics.get("like_count", 0), reposts=metrics.get("retweet_count", 0)))
                    if rows:
                        state["since_id"] = str(max(int(p["id"]) for p in rows))
                    await self.store.set("x-budget", state)
                    self.status["x"] = "connected"
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.status.update(x="degraded", last_error=type(exc).__name__)
                await asyncio.sleep(s.x_poll_s)

    async def run_telegram(self):
        import httpx
        s = self.settings
        channels = {x.strip() for x in s.telegram_read_channels.split(",") if x.strip()}
        if not s.telegram_bot_token or not channels:
            return
        self.status["telegram"] = "configured"
        state = await self.store.get("telegram-cursor", {"offset": 0})
        async with httpx.AsyncClient(timeout=40) as client:
            while True:
                try:
                    # Bot must be legitimately admitted to the listed channels.
                    r = await client.get("https://api.telegram.org/bot" + s.telegram_bot_token.get_secret_value() + "/getUpdates",
                                         params={"offset": state["offset"], "timeout": 25, "allowed_updates": '["channel_post"]'})
                    r.raise_for_status()
                    data = r.json()
                    if not data.get("ok"):
                        raise ValueError("Telegram rejected request")
                    for update in data.get("result", []):
                        p = update.get("channel_post", {})
                        if str(p.get("chat", {}).get("id")) in channels and (p.get("text") or p.get("caption")):
                            await self.ingest(SocialPost(id=f"telegram:{p['chat']['id']}:{p['message_id']}", platform="telegram",
                                                         author=str(p["chat"]["id"]), text=p.get("text") or p["caption"],
                                                         timestamp=p["date"], received_at=time.time()))
                        state["offset"] = update["update_id"] + 1
                        await self.store.set("telegram-cursor", state)
                    self.status["telegram"] = "connected"
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.status.update(telegram="degraded", last_error=type(exc).__name__)
                    await asyncio.sleep(15)

    async def notify(self, snapshot: dict):
        import httpx
        s = self.settings
        if not s.telegram_alerts_enabled or not s.telegram_bot_token or not s.telegram_alert_chat_id:
            return
        text = (f"PAPER-SIGNAL {snapshot['symbol']} · {snapshot['status']}\n{snapshot['token']}\n"
                f"Score {snapshot['score']}/100 (Heuristik) · Inflow 30s ${snapshot['windows']['30']['net_flow_usd'] or 0:,.0f}\n"
                "Manuell prüfen: https://axiom.trade/pulse")
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post("https://api.telegram.org/bot" + s.telegram_bot_token.get_secret_value() + "/sendMessage",
                                  json={"chat_id": s.telegram_alert_chat_id, "text": text, "disable_web_page_preview": True})
            r.raise_for_status()

    async def run_reddit(self):
        """Read public subreddit posts via approved Reddit OAuth credentials only."""
        import httpx
        s = self.settings
        if not s.reddit_client_id or not s.reddit_client_secret or not s.reddit_subreddits:
            return
        names = [n.strip().removeprefix("r/") for n in s.reddit_subreddits.split(",") if n.strip()]
        if not names or any(not re.fullmatch(r"[A-Za-z0-9_]{2,21}", n) for n in names):
            self.status["reddit"] = "invalid-configuration"
            return
        self.status["reddit"] = "configured"
        auth = (s.reddit_client_id.get_secret_value(), s.reddit_client_secret.get_secret_value())
        headers = {"User-Agent": s.reddit_user_agent}
        async with httpx.AsyncClient(timeout=25, headers=headers) as client:
            while True:
                try:
                    token_response = await client.post(
                        "https://www.reddit.com/api/v1/access_token",
                        auth=auth, data={"grant_type": "client_credentials"})
                    token_response.raise_for_status()
                    access_token = token_response.json()["access_token"]
                    for name in names:
                        response = await client.get(
                            f"https://oauth.reddit.com/r/{name}/new",
                            headers={"Authorization": f"Bearer {access_token}"},
                            params={"limit": 50, "raw_json": 1})
                        response.raise_for_status()
                        for item in response.json().get("data", {}).get("children", []):
                            p = item.get("data", {})
                            if not p.get("id") or not p.get("created_utc"):
                                continue
                            text = (p.get("title") or "") + "\n" + (p.get("selftext") or "")
                            await self.ingest(SocialPost(
                                id="reddit:" + p["id"], platform="reddit",
                                author=p.get("author") or "[deleted]", text=text,
                                timestamp=float(p["created_utc"]), received_at=time.time(),
                                url="https://www.reddit.com" + p.get("permalink", ""),
                                likes=max(0, int(p.get("score") or 0))))
                    self.status["reddit"] = "connected"
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.status.update(reddit="degraded", last_error=type(exc).__name__)
                await asyncio.sleep(s.reddit_poll_s)
