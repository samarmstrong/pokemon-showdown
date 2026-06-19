"""Small client for Pokemon Showdown's public replay API."""

from __future__ import annotations

import json
import time
from collections.abc import Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

RETRYABLE_HTTP = frozenset({429, 500, 502, 503, 504})

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

    def __init__(
        self,
        *,
        base_url: str = REPLAY_BASE_URL,
        timeout_seconds: float = 30.0,
        retries: int = 3,
        retry_backoff: float = 1.5,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        self.retry_backoff = retry_backoff

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

    def iter_full(
        self,
        format_id: str,
        *,
        before: int | None = None,
        max_pages: int | None = None,
        delay_seconds: float = 0.2,
    ) -> Iterator[ReplaySummary]:
        """Yield every search result back to the format's launch, deduped by id.

        Unlike `iter_search`, this keeps all 51 results per page and paginates on the
        oldest one, so it does not drop a replay per page. Use it to build a complete
        corpus index (rating is not a server-side filter, so a full scan is required to
        find every replay at a given rating tier).
        """
        seen_ids: set[str] = set()
        pages = 0
        next_before = before
        while max_pages is None or pages < max_pages:
            page = self.search_page(format_id, before=next_before)
            if not page:
                return
            new_in_page = 0
            for summary in page:
                if summary.id in seen_ids:
                    continue
                seen_ids.add(summary.id)
                new_in_page += 1
                yield summary
            pages += 1
            if len(page) <= 50 or new_in_page == 0:
                return
            next_before = page[-1].uploadtime
            if delay_seconds > 0:
                time.sleep(delay_seconds)

    def fetch_replay(self, replay_id: str) -> dict[str, Any]:
        raw = self._get_json(f"/{replay_id}.json")
        if not isinstance(raw, dict):
            raise ReplayApiError(f"Expected replay object for {replay_id}, got {type(raw).__name__}")
        return raw

    def _get_json(self, path: str) -> Any:
        url = f"{self.base_url}{path}"
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            request = Request(url, headers={"User-Agent": USER_AGENT})
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    payload = response.read().decode("utf-8")
                return json.loads(payload)
            except HTTPError as err:
                last_error = err
                if err.code not in RETRYABLE_HTTP or attempt == self.retries:
                    raise ReplayApiError(f"HTTP {err.code} for {path}") from err
            except (URLError, TimeoutError) as err:
                last_error = err
                if attempt == self.retries:
                    raise ReplayApiError(f"Could not fetch {path}: {err}") from err
            except json.JSONDecodeError as err:
                raise ReplayApiError(f"Invalid JSON for {path}") from err
            time.sleep(self.retry_backoff**attempt)
        raise ReplayApiError(f"Exhausted retries for {path}: {last_error}")


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


@dataclass(frozen=True)
class EnumerationStats:
    total: int = 0
    pages: int = 0
    private_or_pw: int = 0
    unrated: int = 0
    ge_1500: int = 0
    ge_1630: int = 0
    ge_1760: int = 0
    max_rating: int | None = None
    oldest_uploadtime: int | None = None
    newest_uploadtime: int | None = None
    elapsed_seconds: float = 0.0


def enumerate_format(
    *,
    client: ShowdownReplayClient,
    format_id: str,
    index_path: Path,
    before: int | None = None,
    max_pages: int | None = None,
    delay_seconds: float = 0.2,
    log_every_pages: int = 50,
    progress: bool = True,
) -> EnumerationStats:
    """Write a lossless JSONL summary index of the whole public corpus for a format.

    One `ReplaySummary` per line. This is the re-sliceable artifact: any rating tier or
    time window can be selected from it later without re-crawling.
    """
    index_path.parent.mkdir(parents=True, exist_ok=True)
    total = pages = private = unrated = ge1500 = ge1630 = ge1760 = 0
    max_rating: int | None = None
    oldest = newest = None
    start = time.monotonic()
    last_uploadtime = before

    with index_path.open("w", encoding="utf-8") as out:
        for summary in client.iter_full(
            format_id, before=before, max_pages=max_pages, delay_seconds=delay_seconds
        ):
            out.write(json.dumps(summary.to_json(), sort_keys=True) + "\n")
            total += 1
            if summary.private or summary.password:
                private += 1
            if summary.rating is None:
                unrated += 1
            else:
                r = summary.rating
                ge1500 += r >= 1500
                ge1630 += r >= 1630
                ge1760 += r >= 1760
                max_rating = r if max_rating is None else max(max_rating, r)
            ut = summary.uploadtime
            oldest = ut if oldest is None else min(oldest, ut)
            newest = ut if newest is None else max(newest, ut)
            last_uploadtime = ut
            if progress and total % (log_every_pages * 51) == 0:
                print(
                    f"... enumerated {total} replays "
                    f"(>=1630={ge1630} >=1760={ge1760}, oldest_ut={last_uploadtime})",
                    flush=True,
                )
            pages = total // 51 + 1

    return EnumerationStats(
        total=total,
        pages=pages,
        private_or_pw=private,
        unrated=unrated,
        ge_1500=ge1500,
        ge_1630=ge1630,
        ge_1760=ge1760,
        max_rating=max_rating,
        oldest_uploadtime=oldest,
        newest_uploadtime=newest,
        elapsed_seconds=round(time.monotonic() - start, 1),
    )


def load_index(index_path: Path) -> Iterator[ReplaySummary]:
    """Yield `ReplaySummary` rows from a JSONL index written by `enumerate_format`."""
    with index_path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield ReplaySummary.from_json(json.loads(line))


def select_summaries(
    summaries: Iterable[ReplaySummary],
    *,
    min_rating: int | None = None,
    include_unrated: bool = False,
    include_private: bool = False,
) -> list[ReplaySummary]:
    """Filter an index down to a download set."""
    chosen: list[ReplaySummary] = []
    for s in summaries:
        if (s.private or s.password) and not include_private:
            continue
        if s.rating is None:
            if include_unrated:
                chosen.append(s)
            continue
        if min_rating is None or s.rating >= min_rating:
            chosen.append(s)
    return chosen


def _fetch_one(
    client: ShowdownReplayClient, summary: ReplaySummary, out_dir: Path, delay_seconds: float
) -> ReplaySummary:
    replay = client.fetch_replay(summary.id)
    path = out_dir / f"{summary.id}.json"
    path.write_text(json.dumps(replay, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    if delay_seconds > 0:
        time.sleep(delay_seconds)
    return summary


def download_summaries(
    *,
    client: ShowdownReplayClient,
    summaries: list[ReplaySummary],
    out_dir: Path,
    max_workers: int = 4,
    delay_seconds: float = 0.2,
    overwrite: bool = False,
    progress_every: int = 500,
    progress: bool = True,
) -> CrawlStats:
    """Concurrently download full replay JSON for a pre-selected set of summaries.

    Each worker sleeps `delay_seconds` after its request, so the aggregate request rate
    is roughly `max_workers / (request_time + delay_seconds)`. Keep it polite.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.jsonl"

    todo: list[ReplaySummary] = []
    skipped_existing = 0
    for s in summaries:
        if (out_dir / f"{s.id}.json").exists() and not overwrite:
            skipped_existing += 1
            continue
        todo.append(s)

    fetched = failed = 0
    with (
        manifest_path.open("a", encoding="utf-8") as manifest,
        ThreadPoolExecutor(max_workers=max_workers) as pool,
    ):
        futures = {pool.submit(_fetch_one, client, s, out_dir, delay_seconds): s for s in todo}
        for future in as_completed(futures):
            summary = futures[future]
            try:
                future.result()
            except Exception as err:
                failed += 1
                if progress:
                    print(f"  ! failed {summary.id}: {err}", flush=True)
                continue
            manifest.write(
                json.dumps({"summary": summary.to_json(), "path": str(out_dir / f"{summary.id}.json")}, sort_keys=True)
                + "\n"
            )
            fetched += 1
            if progress and fetched % progress_every == 0:
                print(f"... downloaded {fetched}/{len(todo)} (failed={failed})", flush=True)

    return CrawlStats(seen=len(summaries), fetched=fetched, skipped_existing=skipped_existing)
