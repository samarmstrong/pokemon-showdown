"""Small client for Pokemon Showdown's public replay API."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

REPLAY_BASE_URL = "https://replay.pokemonshowdown.com"
USER_AGENT = "psrl-replay-dataset/0.1"


class ReplayApiError(RuntimeError):
    """Raised when the replay API cannot return usable JSON."""


@dataclass(frozen=True)
class ReplaySummary:
    id: str
    uploadtime: int
    format: str
    players: tuple[str, ...]
    rating: int | None
    private: bool
    password: str | None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ReplaySummary:
        rating = data.get("rating")
        return cls(
            id=str(data["id"]),
            uploadtime=int(data["uploadtime"]),
            format=str(data.get("format", "")),
            players=tuple(str(player) for player in data.get("players", ())),
            rating=int(rating) if rating is not None else None,
            private=bool(data.get("private", 0)),
            password=str(data["password"]) if data.get("password") is not None else None,
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "uploadtime": self.uploadtime,
            "format": self.format,
            "players": list(self.players),
            "rating": self.rating,
            "private": self.private,
            "password": self.password,
        }


@dataclass(frozen=True)
class CrawlStats:
    seen: int = 0
    fetched: int = 0
    skipped_existing: int = 0
    skipped_private: int = 0
    skipped_unrated: int = 0
    skipped_rating: int = 0


class ShowdownReplayClient:
    """HTTP wrapper around replay search and replay JSON endpoints."""

    def __init__(self, *, base_url: str = REPLAY_BASE_URL, timeout_seconds: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def search_page(self, format_id: str, *, before: int | None = None) -> list[ReplaySummary]:
        params: dict[str, str | int] = {"format": format_id}
        if before is not None:
            params["before"] = before
        raw = self._get_json(f"/search.json?{urlencode(params)}")
        if not isinstance(raw, list):
            raise ReplayApiError(f"Expected replay search list, got {type(raw).__name__}")
        return [ReplaySummary.from_json(item) for item in raw]

    def iter_search(
        self,
        format_id: str,
        *,
        before: int | None = None,
        max_pages: int | None = None,
        delay_seconds: float = 0.25,
    ) -> Iterator[ReplaySummary]:
        """Yield search results, following Showdown's 51-result pagination."""
        pages = 0
        next_before = before
        while max_pages is None or pages < max_pages:
            page = self.search_page(format_id, before=next_before)
            if not page:
                return
            results = page[:50]
            yield from results
            pages += 1
            if len(page) <= 50:
                return
            next_before = page[49].uploadtime
            if delay_seconds > 0:
                time.sleep(delay_seconds)

    def fetch_replay(self, replay_id: str) -> dict[str, Any]:
        raw = self._get_json(f"/{replay_id}.json")
        if not isinstance(raw, dict):
            raise ReplayApiError(f"Expected replay object for {replay_id}, got {type(raw).__name__}")
        return raw

    def _get_json(self, path: str) -> Any:
        request = Request(f"{self.base_url}{path}", headers={"User-Agent": USER_AGENT})
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as err:
            raise ReplayApiError(f"HTTP {err.code} for {path}") from err
        except URLError as err:
            raise ReplayApiError(f"Could not fetch {path}: {err.reason}") from err
        try:
            return json.loads(payload)
        except json.JSONDecodeError as err:
            raise ReplayApiError(f"Invalid JSON for {path}") from err


def download_replays(
    *,
    client: ShowdownReplayClient,
    format_id: str,
    out_dir: Path,
    max_replays: int,
    min_rating: int | None = None,
    before: int | None = None,
    max_pages: int | None = None,
    include_unrated: bool = False,
    overwrite: bool = False,
    delay_seconds: float = 0.25,
) -> CrawlStats:
    """Download raw replay JSON files and a crawl manifest."""
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.jsonl"
    stats = CrawlStats()

    with manifest_path.open("a", encoding="utf-8") as manifest:
        for summary in client.iter_search(
            format_id,
            before=before,
            max_pages=max_pages,
            delay_seconds=delay_seconds,
        ):
            if stats.fetched >= max_replays:
                break
            stats = CrawlStats(**{**stats.__dict__, "seen": stats.seen + 1})
            if summary.private or summary.password:
                stats = CrawlStats(**{**stats.__dict__, "skipped_private": stats.skipped_private + 1})
                continue
            if summary.rating is None and not include_unrated:
                stats = CrawlStats(**{**stats.__dict__, "skipped_unrated": stats.skipped_unrated + 1})
                continue
            if min_rating is not None and (summary.rating is None or summary.rating < min_rating):
                stats = CrawlStats(**{**stats.__dict__, "skipped_rating": stats.skipped_rating + 1})
                continue

            replay_path = out_dir / f"{summary.id}.json"
            if replay_path.exists() and not overwrite:
                stats = CrawlStats(**{**stats.__dict__, "skipped_existing": stats.skipped_existing + 1})
                continue

            replay = client.fetch_replay(summary.id)
            replay_path.write_text(json.dumps(replay, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
            manifest.write(json.dumps({"summary": summary.to_json(), "path": str(replay_path)}, sort_keys=True) + "\n")
            manifest.flush()
            stats = CrawlStats(**{**stats.__dict__, "fetched": stats.fetched + 1})
            if delay_seconds > 0:
                time.sleep(delay_seconds)

    return stats
