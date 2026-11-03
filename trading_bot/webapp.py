from __future__ import annotations

import json
import threading
import traceback
import webbrowser
from dataclasses import asdict
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import pandas as pd

from .charting import render_strategy_charts
from .config import AppConfig
from .data import MarketDataError
from .engine import AnalysisResult, analyze_market
from .paper import PaperPortfolio


STATIC_DIR = Path(__file__).with_name("web_static")


class AnalysisBusy(RuntimeError):
    pass


class DashboardState:
    def __init__(self, config: AppConfig, demo: bool, data_dir: str | Path) -> None:
        self.config = config
        self.demo = demo
        self.data_dir = Path(data_dir)
        self.charts_dir = self.data_dir / "charts"
        self.ledger_path = self.data_dir / "paper_portfolio.json"
        self.snapshot_path = self.data_dir / "latest_dashboard.json"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.charts_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.last_payload: dict[str, Any] | None = self._load_snapshot()

    def _load_snapshot(self) -> dict[str, Any] | None:
        if not self.snapshot_path.exists():
            return None
        try:
            payload = json.loads(self.snapshot_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or bool(payload.get("demo")) != self.demo:
                return None
            return payload
        except (OSError, json.JSONDecodeError):
            return None

    def _prioritized_plans(self, result: AnalysisResult) -> list:
        return sorted(
            result.plans,
            key=lambda plan: (plan.action == "PAPER_BUY", plan.probability_up),
            reverse=True,
        )[: self.config.risk.max_positions]

    def _render_charts(self, result: AnalysisResult) -> list[Path]:
        return render_strategy_charts(
            result.panel,
            self._prioritized_plans(result),
            result.backtest_periods,
            self.charts_dir,
            self.config.strategy.chart_lookback_days,
        )

    def _portfolio_payload(self, portfolio: PaperPortfolio, prices: dict[str, float], messages: list[str]) -> dict[str, Any]:
        positions = []
        for asset_id, position in portfolio.positions.items():
            current_price = float(prices.get(asset_id, position.entry_price))
            positions.append(
                {
                    **asdict(position),
                    "current_price": current_price,
                    "market_value": position.quantity * current_price,
                    "unrealized_return": current_price / position.entry_price - 1,
                }
            )
        return {
            "cash": portfolio.cash,
            "equity": portfolio.equity(prices),
            "position_count": len(positions),
            "positions": positions,
            "recent_transactions": portfolio.transactions[-20:],
            "messages": messages,
        }

    def _serialize(
        self,
        result: AnalysisResult,
        chart_paths: list[Path],
        portfolio: PaperPortfolio,
        prices: dict[str, float],
        messages: list[str],
        mode: str,
    ) -> dict[str, Any]:
        version = int(datetime.now(UTC).timestamp())
        charts = [
            {
                "name": path.stem.replace("_", " "),
                "kind": "backtest" if path.name == "walk_forward_equity.png" else "strategy",
                "url": f"/charts/{path.name}?v={version}",
            }
            for path in chart_paths
        ]
        return {
            "status": "ready",
            "mode": mode,
            "generated_at": datetime.now(UTC).isoformat(),
            "data_as_of": pd.Timestamp(result.scored["date"].max()).isoformat(),
            "source": result.source_label,
            "demo": self.demo,
            "currency": self.config.market.vs_currency.upper(),
            "universe_size": len(result.plans),
            "diagnostics": result.diagnostics.to_dict(),
            "backtest": result.backtest.to_dict(),
            "plans": [plan.to_dict() for plan in result.plans],
            "charts": charts,
            "portfolio": self._portfolio_payload(portfolio, prices, messages),
            "guardrails": {
                "paper_only": True,
                "max_positions": self.config.risk.max_positions,
                "max_portfolio_exposure": self.config.risk.max_portfolio_exposure,
                "risk_per_trade": self.config.risk.risk_per_trade,
                "probability_threshold": self.config.model.probability_threshold,
                "minimum_backtest_trades": self.config.strategy.minimum_backtest_trades,
            },
        }

    def analyze(self, mode: str) -> dict[str, Any]:
        if mode not in {"scan", "paper"}:
            raise ValueError("mode must be 'scan' or 'paper'")
        if not self.lock.acquire(blocking=False):
            raise AnalysisBusy("An analysis is already running")
        try:
            portfolio = PaperPortfolio.load(self.ledger_path, self.config.risk.starting_cash)
            result = analyze_market(self.config, demo=self.demo, equity=portfolio.equity({}))
            prices = {str(row.asset_id): float(row.close) for row in result.scored.itertuples(index=False)}
            messages: list[str] = []
            if mode == "paper":
                messages.extend(portfolio.mark_and_exit(prices, self.config.risk))
                if result.diagnostics.quality_pass and result.backtest.quality_pass:
                    messages.extend(portfolio.execute_plans(result.plans, self.config.risk, prices))
                else:
                    messages.append("Keine neuen Positionen: mindestens ein Qualitäts-Gate blockiert.")
                portfolio.save(self.ledger_path)
            chart_paths = self._render_charts(result)
            payload = self._serialize(result, chart_paths, portfolio, prices, messages, mode)
            self.snapshot_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            self.last_payload = payload
            return payload
        finally:
            self.lock.release()


def _handler_for(state: DashboardState) -> type[BaseHTTPRequestHandler]:
    class DashboardHandler(BaseHTTPRequestHandler):
        server_version = "AIPaperTrader/1.1"

        def _headers(self, content_type: str, status: int, length: int) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'",
            )
            self.end_headers()

        def _send_bytes(self, body: bytes, content_type: str, status: int = HTTPStatus.OK) -> None:
            self._headers(content_type, int(status), len(body))
            self.wfile.write(body)

        def _send_json(self, payload: object, status: int = HTTPStatus.OK) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send_bytes(body, "application/json; charset=utf-8", status)

        def _send_file(self, path: Path, content_type: str) -> None:
            if not path.is_file():
                self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
                return
            self._send_bytes(path.read_bytes(), content_type)

        def do_GET(self) -> None:  # noqa: N802
            route = urlparse(self.path).path
            static_routes = {
                "/": (STATIC_DIR / "index.html", "text/html; charset=utf-8"),
                "/app.js": (STATIC_DIR / "app.js", "text/javascript; charset=utf-8"),
                "/styles.css": (STATIC_DIR / "styles.css", "text/css; charset=utf-8"),
            }
            if route in static_routes:
                path, content_type = static_routes[route]
                self._send_file(path, content_type)
                return
            if route == "/api/health":
                self._send_json(
                    {
                        "status": "ok",
                        "demo": state.demo,
                        "source_mode": "synthetic demo" if state.demo else "CoinGecko live",
                        "paper_only": True,
                    }
                )
                return
            if route == "/api/result":
                if state.last_payload is None:
                    self._send_json({"status": "empty"})
                else:
                    self._send_json(state.last_payload)
                return
            if route.startswith("/charts/"):
                name = unquote(route.removeprefix("/charts/"))
                if not name or Path(name).name != name or not name.lower().endswith(".png"):
                    self._send_json({"error": "Invalid chart path"}, HTTPStatus.BAD_REQUEST)
                    return
                self._send_file(state.charts_dir / name, "image/png")
                return
            self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

        def do_POST(self) -> None:  # noqa: N802
            route = urlparse(self.path).path
            if route != "/api/analyze":
                self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > 16_384:
                    self._send_json({"error": "Request too large"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                    return
                raw = self.rfile.read(length) if length else b"{}"
                request = json.loads(raw.decode("utf-8"))
                if not isinstance(request, dict):
                    raise ValueError("Request body must be a JSON object")
                mode = str(request.get("mode", "scan"))
                self._send_json(state.analyze(mode))
            except AnalysisBusy as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
            except (ValueError, MarketDataError, OSError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            except Exception:
                traceback.print_exc()
                self._send_json({"error": "Unerwarteter Analysefehler. Details stehen im Server-Terminal."}, HTTPStatus.INTERNAL_SERVER_ERROR)

        def log_message(self, format: str, *args: object) -> None:
            print(f"APP {self.address_string()} — {format % args}")

    return DashboardHandler


def serve_app(
    config: AppConfig,
    demo: bool,
    host: str = "127.0.0.1",
    port: int = 8765,
    data_dir: str | Path = ".paper_trader_app",
    open_browser: bool = True,
) -> int:
    if not 1 <= port <= 65_535:
        raise ValueError("port must be between 1 and 65535")
    state = DashboardState(config, demo, data_dir)
    server = ThreadingHTTPServer((host, port), _handler_for(state))
    server.daemon_threads = True
    url_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{url_host}:{server.server_address[1]}"
    print(f"AI Paper Trader App: {url}")
    print("Paper-Trading only. Stop with Ctrl+C.")
    if host not in {"127.0.0.1", "localhost", "::1"}:
        print("WARNING: The app has no login. Bind to 127.0.0.1 unless you secure the network boundary.")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print("App stopped.")
    finally:
        server.server_close()
    return 0
