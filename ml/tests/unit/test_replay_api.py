from __future__ import annotations

from typing import Any

from psrl.replays.api import ShowdownReplayClient


class FakeClient(ShowdownReplayClient):
    def __init__(self, pages: list[list[dict[str, Any]]]) -> None:
        super().__init__()
        self.pages = pages
        self.paths: list[str] = []

    def _get_json(self, path: str) -> Any:
        self.paths.append(path)
        return self.pages.pop(0)


def test_iter_search_uses_51st_result_for_pagination_signal() -> None:
    first_page = [
        {
            "id": f"gen9championsvgc2026regma-{i}",
            "uploadtime": 1000 - i,
            "format": "[Gen 9 Champions] VGC 2026 Reg M-A",
            "players": ["p1", "p2"],
            "rating": 1800,
            "private": 0,
            "password": None,
        }
        for i in range(51)
    ]
    second_page = [
        {
            "id": "gen9championsvgc2026regma-final",
            "uploadtime": 1,
            "format": "[Gen 9 Champions] VGC 2026 Reg M-A",
            "players": ["p1", "p2"],
            "rating": 1800,
            "private": 0,
            "password": None,
        }
    ]
    client = FakeClient([first_page, second_page])

    results = list(client.iter_search("gen9championsvgc2026regma", delay_seconds=0))

    assert len(results) == 51
    assert results[0].id == "gen9championsvgc2026regma-0"
    assert results[-1].id == "gen9championsvgc2026regma-final"
    assert client.paths == [
        "/search.json?format=gen9championsvgc2026regma",
        "/search.json?format=gen9championsvgc2026regma&before=951",
    ]
