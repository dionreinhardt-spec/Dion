"""Strict, bounded Anchor event reader driven by pinned official IDL schemas."""
import base64
import hashlib
import json
import re
from pathlib import Path
import base58


class DecodeError(ValueError):
    pass


class Reader:
    def __init__(self, data: bytes, types: dict):
        self.data, self.offset, self.types = data, 0, types

    def take(self, count: int) -> bytes:
        if count < 0 or self.offset + count > len(self.data):
            raise DecodeError("Truncated event")
        result = self.data[self.offset:self.offset + count]
        self.offset += count
        return result

    def read(self, spec):
        if isinstance(spec, str):
            if spec == "pubkey":
                return base58.b58encode(self.take(32)).decode()
            if spec == "bool":
                v = self.take(1)[0]
                if v > 1:
                    raise DecodeError("Invalid bool")
                return bool(v)
            if spec == "string":
                size = self.read("u32")
                if size > 20000:
                    raise DecodeError("Oversized string")
                return self.take(size).decode("utf-8")
            if re.fullmatch(r"[ui](8|16|32|64|128)", spec):
                return int.from_bytes(self.take(int(spec[1:]) // 8), "little", signed=spec[0] == "i")
            raise DecodeError("Unsupported primitive")
        if "defined" in spec:
            n = spec["defined"]
            return self.read(self.types[n if isinstance(n, str) else n["name"]])
        if "vec" in spec:
            count = self.read("u32")
            if count > 1024:
                raise DecodeError("Oversized vector")
            return [self.read(spec["vec"]) for _ in range(count)]
        if "array" in spec:
            t, count = spec["array"]
            return [self.read(t) for _ in range(count)]
        if "option" in spec:
            return self.read(spec["option"]) if self.read("bool") else None
        if spec.get("kind") == "struct":
            return {f["name"]: self.read(f["type"]) for f in spec["fields"]}
        raise DecodeError("Unsupported schema type")


class AnchorSchema:
    def __init__(self, name: str, allow_unknown_tail: bool = False):
        self.allow_unknown_tail = allow_unknown_tail
        self.schema = json.loads(Path(__file__).with_name(f"{name}_schema.json").read_text())
        self.program = self.schema["address"]
        self.types = {t["name"]: t["type"] for t in self.schema["types"]}
        self.events = {bytes(e["discriminator"]): e["name"] for e in self.schema["events"]}

    def decode(self, data: bytes):
        name = self.events.get(data[:8])
        if name is None:
            return None
        reader = Reader(data[8:], self.types)
        value = reader.read(self.types[name])
        if reader.offset != len(reader.data):
            if not self.allow_unknown_tail or len(reader.data) - reader.offset > 256:
                raise DecodeError("IDL drift: unexpected trailing event data")
            value["_unverified_tail_bytes"] = len(reader.data) - reader.offset
        return name, value

    def account(self, name: str, data: bytes):
        if data[:8] != hashlib.sha256(f"account:{name}".encode()).digest()[:8]:
            raise DecodeError("Wrong account discriminator")
        return Reader(data[8:], self.types).read(self.types[name])


def program_events(logs: list[str], schemas: dict[str, AnchorSchema]):
    """Only promote events after the emitting CPI and every ancestor succeed.

    A caller can catch a failed CPI and still commit its own transaction. Logs
    from the failed CPI are evidence of rolled-back state, not completed trades.
    """
    stack: list[dict] = []
    for index, line in enumerate(logs):
        m = re.fullmatch(r"Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]", line)
        if m:
            if int(m[2]) != len(stack) + 1:
                raise DecodeError("Incomplete invocation stack")
            stack.append({"program": m[1], "pending": []})
            continue
        end = re.fullmatch(r"Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed: .*)", line)
        if end:
            if not stack or stack[-1]["program"] != end[1]:
                raise DecodeError("Mismatched invocation stack")
            frame = stack.pop()
            if end[2] != "success":
                continue
            if stack:
                stack[-1]["pending"].extend(frame["pending"])
            else:
                for item in frame["pending"]:
                    if isinstance(item, Exception):
                        raise item
                    yield item
            continue
        if line.startswith("Program data: ") and stack and stack[-1]["program"] in schemas:
            try:
                item = schemas[stack[-1]["program"]].decode(base64.b64decode(line[14:], validate=True))
                if item:
                    stack[-1]["pending"].append((index, stack[-1]["program"], item[0], item[1]))
            except (ValueError, UnicodeError):
                stack[-1]["pending"].append(DecodeError("Unsupported or malformed on-chain event"))
    if stack:
        raise DecodeError("Truncated runtime logs")
