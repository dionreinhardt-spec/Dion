import asyncio
import hmac
import logging
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect, Depends
from fastapi.middleware.cors import CORSMiddleware
from .config import Settings
from .engine import Engine
from .models import PaperRequest, CloseRequest, WatchRequest
from .paper import RiskRejected


def create_app(settings: Settings | None = None):
    settings = settings or Settings()
    engine = Engine(settings)

    @asynccontextmanager
    async def lifespan(app):
        await engine.start()
        yield
        await engine.stop()

    app = FastAPI(title="Axiom Intelligence · Paper Only", version="0.1.0", lifespan=lifespan)
    app.state.engine = engine
    app.add_middleware(CORSMiddleware, allow_origins=settings.origins, allow_methods=["GET", "POST"],
                       allow_headers=["Authorization", "Content-Type"], allow_credentials=False)

    def check_auth(header: str | None):
        if settings.api_token and not hmac.compare_digest(header or "", "Bearer " + settings.api_token.get_secret_value()):
            raise HTTPException(401, "Authentication required")

    async def auth(request: Request):
        check_auth(request.headers.get("authorization"))
        origin = request.headers.get("origin")
        if origin and origin not in settings.origins:
            raise HTTPException(403, "Origin not allowed")

    @app.get("/health/live")
    async def live():
        return {"alive": engine.running, "mode": settings.mode, "live_execution": False}

    @app.get("/health/ready")
    async def ready():
        try:
            await engine.store.ping()
        except Exception:
            raise HTTPException(503, "Database unavailable") from None
        if engine.last_tick is None or time.time() - engine.last_tick > 5:
            raise HTTPException(503, "Evaluation loop stalled")
        if settings.mode == "live" and not engine.status["connected"]:
            raise HTTPException(503, "Solana stream disconnected")
        return {"ready": True, "mode": settings.mode, "market_data_ready": engine.status["connected"]}

    @app.get("/api/snapshot", dependencies=[Depends(auth)])
    async def snapshot():
        return engine.payload()

    @app.get("/api/token/{token}", dependencies=[Depends(auth)])
    async def token_detail(token: str):
        if token not in engine.snapshots:
            raise HTTPException(404, "Token not observed")
        return engine.snapshots[token]

    @app.post("/api/watch", dependencies=[Depends(auth)])
    async def watch(req: WatchRequest):
        try:
            await engine.watch(req.token)
            return {"watching": req.token}
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None

    @app.post("/api/paper/buy", dependencies=[Depends(auth)])
    async def paper_buy(req: PaperRequest):
        # Re-evaluate at request time; a cached browser score cannot authorize a fill.
        await engine.evaluate()
        snap = engine.snapshots.get(req.token)
        if not snap:
            raise HTTPException(404, "Token not observed")
        try:
            return await engine.broker.open(req, snap, engine.snapshots)
        except RiskRejected as exc:
            raise HTTPException(409, str(exc)) from None

    @app.post("/api/paper/{token}/close", dependencies=[Depends(auth)])
    async def paper_close(token: str, req: CloseRequest):
        await engine.evaluate()
        try:
            return await engine.broker.close(token, req.fraction, req.idempotency_key, engine.snapshots.get(token, {}))
        except RiskRejected as exc:
            raise HTTPException(409, str(exc)) from None

    @app.post("/api/risk/kill", dependencies=[Depends(auth)])
    async def kill(active: bool = True):
        await engine.broker.set_kill(active)
        return {"kill_switch": active, "scope": "paper entries and automatic exits"}

    @app.get("/metrics", dependencies=[Depends(auth)])
    async def metrics():
        from fastapi.responses import PlainTextResponse
        values = {"axiom_queue_depth": engine.queue.qsize(), "axiom_dropped_events": engine.status["dropped"],
                  "axiom_scanned_tokens": len(engine.snapshots), "axiom_ws_connected": int(engine.status["connected"]),
                  "axiom_evaluation_ms": engine.last_tick_ms or 0,
                  "axiom_decode_errors": engine.status["decode_errors"]}
        return PlainTextResponse("\n".join(f"{k} {v}" for k, v in values.items()) + "\n")

    @app.websocket("/ws")
    async def stream(ws: WebSocket):
        origin = ws.headers.get("origin")
        if origin and origin not in settings.origins:
            await ws.close(code=1008)
            return
        await ws.accept()
        try:
            # Authentication is the first frame, never a URL query/session cookie.
            if settings.api_token:
                first = await asyncio.wait_for(ws.receive_json(), timeout=5)
                try:
                    check_auth("Bearer " + str(first.get("token", "")))
                except HTTPException:
                    await ws.close(code=1008)
                    return
            while True:
                await ws.send_json(engine.payload())
                await asyncio.sleep(1)
        except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError):
            pass

    return app


app = create_app()
