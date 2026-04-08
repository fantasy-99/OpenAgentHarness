from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse


LOG = logging.getLogger("mkdocs.hooks.copy_localized_sitemaps")
ALTERNATE_LINK_RE = re.compile(r'<link\s+rel="alternate"\s+href="([^"]+)"\s+hreflang="[^"]+"')


def _normalize_site_root(site_url: str | None) -> str:
    if not site_url:
        return "/"

    path = urlparse(site_url).path or "/"
    return f"{path.rstrip('/')}/" if path != "/" else "/"


def _iter_alternate_paths(index_html: Path) -> list[str]:
    if not index_html.exists():
        return []

    content = index_html.read_text(encoding="utf-8")
    return [urlparse(href).path or "/" for href in ALTERNATE_LINK_RE.findall(content)]


def on_post_build(config, **kwargs) -> None:
    site_dir = Path(config["site_dir"])
    sitemap_files = [
        site_dir / "sitemap.xml",
        site_dir / "sitemap.xml.gz",
    ]

    if not (site_dir / "sitemap.xml").exists():
        return

    site_root = _normalize_site_root(config.get("site_url"))
    alternate_paths = _iter_alternate_paths(site_dir / "index.html")

    for path in alternate_paths:
        if path == "/" or path == site_root:
            continue

        relative = path
        if site_root != "/" and relative.startswith(site_root):
            relative = relative[len(site_root) :]

        relative = relative.strip("/")
        if not relative:
            continue

        target_dir = site_dir / relative
        if not target_dir.is_dir():
            continue

        for source in sitemap_files:
            if source.exists():
                shutil.copy2(source, target_dir / source.name)

        LOG.info("Copied sitemap files into localized directory: %s", target_dir)
