"""Loaders for packed team strings shipped with the package."""

from __future__ import annotations

from importlib import resources


def load_packed(format_key: str, name: str) -> str:
    """Load a packed team string.

    Example: ``load_packed("vgc2026_regma", "goodstuff_01")``.
    """
    pkg = f"psrl.data.teams.{format_key}"
    with resources.files(pkg).joinpath(f"{name}.packed").open("r", encoding="utf-8") as f:
        return f.read().strip()
