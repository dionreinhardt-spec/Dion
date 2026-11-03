"""Durable inbox, snapshots and paper ledger. Works on SQLite and PostgreSQL."""
import time
import os
import fcntl
from sqlalchemy import String, Float, JSON, select, delete
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.exc import IntegrityError


class Base(DeclarativeBase):
    pass


class EventRow(Base):
    __tablename__ = "events"
    id: Mapped[str] = mapped_column(String(256), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    token: Mapped[str] = mapped_column(String(128), index=True)
    timestamp: Mapped[float] = mapped_column(Float, index=True)
    payload: Mapped[dict] = mapped_column(JSON)


class StateRow(Base):
    __tablename__ = "state"
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSON)


class Store:
    def __init__(self, url: str):
        self.engine = create_async_engine(url, pool_pre_ping=True)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)
        self.lock_file = None
        self.leader_connection = None

    async def start(self):
        if self.engine.dialect.name == "sqlite" and self.engine.url.database not in (None, ":memory:"):
            self.lock_file = os.open(self.engine.url.database + ".collector.lock", os.O_CREAT | os.O_RDWR, 0o600)
            try:
                fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(self.lock_file)
                self.lock_file = None
                raise RuntimeError("Another collector owns this database; run one backend worker") from None
        elif self.engine.dialect.name == "postgresql":
            self.leader_connection = await self.engine.connect()
            got = await self.leader_connection.exec_driver_sql("SELECT pg_try_advisory_lock(731591821)")
            if not got.scalar():
                await self.leader_connection.close()
                self.leader_connection = None
                raise RuntimeError("Another collector owns this PostgreSQL database")
            await self.leader_connection.commit()
        async with self.engine.begin() as conn:
            if self.engine.dialect.name == "sqlite":
                await conn.exec_driver_sql("PRAGMA journal_mode=WAL")
            await conn.run_sync(Base.metadata.create_all)
        await self.set("schema", {"version": 1})

    async def insert_event(self, kind: str, token: str, timestamp: float, payload: dict) -> bool:
        async with self.session() as s:
            s.add(EventRow(id=payload["id"], kind=kind, token=token, timestamp=timestamp, payload=payload))
            try:
                await s.commit()
                return True
            except IntegrityError:
                await s.rollback()
                return False

    async def load_events(self, since: float, kind: str = "trade", limit: int = 200000) -> list[dict]:
        async with self.session() as s:
            rows = await s.scalars(select(EventRow).where(EventRow.kind == kind, EventRow.timestamp >= since)
                                   .order_by(EventRow.timestamp.desc()).limit(limit))
            return [r.payload for r in reversed(list(rows))]

    async def get(self, key: str, default=None):
        async with self.session() as s:
            row = await s.get(StateRow, key)
            return row.payload if row else default

    async def set(self, key: str, payload: dict):
        async with self.session() as s:
            await s.merge(StateRow(key=key, payload=payload))
            await s.commit()

    async def ping(self):
        async with self.engine.connect() as c:
            await c.exec_driver_sql("SELECT 1")

    async def prune(self, days: int = 30):
        async with self.session() as s:
            await s.execute(delete(EventRow).where(EventRow.timestamp < time.time() - days * 86400))
            await s.commit()

    async def close(self):
        if self.leader_connection is not None:
            await self.leader_connection.exec_driver_sql("SELECT pg_advisory_unlock(731591821)")
            await self.leader_connection.close()
        if self.lock_file is not None:
            fcntl.flock(self.lock_file, fcntl.LOCK_UN)
            os.close(self.lock_file)
        await self.engine.dispose()
