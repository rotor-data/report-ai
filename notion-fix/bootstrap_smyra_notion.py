#!/usr/bin/env python3
"""
Bootstrap a Notion setup for Smyra sprint planning.

Creates:
1. Smyra Sprintar
2. Smyra Sprintdelar
3. Smyra Ideer & Todos

Then adds a starter page "Sprintmall - duplicera mig" in Sprintar.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional


NOTION_BASE_URL = "https://api.notion.com/v1"


def title_text(content: str) -> List[Dict[str, Any]]:
    return [{"type": "text", "text": {"content": content}}]


class NotionClient:
    def __init__(self, token: str, notion_version: str) -> None:
        self.token = token
        self.notion_version = notion_version

    def request(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{NOTION_BASE_URL}{path}"
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")

        req = urllib.request.Request(
            url=url,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Notion-Version": self.notion_version,
            },
        )

        try:
            with urllib.request.urlopen(req) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body)
                message = parsed.get("message", body)
            except json.JSONDecodeError:
                message = body
            raise RuntimeError(f"Notion API error ({exc.code}): {message}") from exc

    def create_database(self, parent_page_id: str, title: str, properties: Dict[str, Any]) -> Dict[str, Any]:
        payload = {
            "parent": {"type": "page_id", "page_id": parent_page_id},
            "title": title_text(title),
            "properties": properties,
        }
        return self.request("POST", "/databases", payload)

    def create_page(
        self,
        parent_database_id: str,
        properties: Dict[str, Any],
        children: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "parent": {"database_id": parent_database_id},
            "properties": properties,
        }
        if children:
            payload["children"] = children
        return self.request("POST", "/pages", payload)


def sprintar_properties() -> Dict[str, Any]:
    return {
        "Sprint": {"title": {}},
        "Status": {
            "select": {
                "options": [
                    {"name": "Planerad", "color": "default"},
                    {"name": "Aktiv", "color": "blue"},
                    {"name": "Klar", "color": "green"},
                ]
            }
        },
        "Startdatum": {"date": {}},
        "Slutdatum": {"date": {}},
        "Sprintmal": {"rich_text": {}},
        "Ansvarig": {"people": {}},
        "Kapacitet": {"number": {"format": "number"}},
    }


def sprintdelar_properties(sprintar_database_id: str) -> Dict[str, Any]:
    return {
        "Delnamn": {"title": {}},
        "Sprint": {"relation": {"database_id": sprintar_database_id, "single_property": {}}},
        "Status": {
            "select": {
                "options": [
                    {"name": "Planerad", "color": "default"},
                    {"name": "Pagar", "color": "blue"},
                    {"name": "Klar", "color": "green"},
                ]
            }
        },
        "Mal": {"rich_text": {}},
        "Ansvarig": {"people": {}},
        "Ordning": {"number": {"format": "number"}},
    }


def todos_properties(sprintar_database_id: str, sprintdelar_database_id: str) -> Dict[str, Any]:
    return {
        "Titel": {"title": {}},
        "Typ": {
            "select": {
                "options": [
                    {"name": "Ide", "color": "gray"},
                    {"name": "Todo", "color": "default"},
                    {"name": "Bug", "color": "red"},
                    {"name": "Forbattring", "color": "blue"},
                ]
            }
        },
        "Status": {
            "select": {
                "options": [
                    {"name": "Inbox", "color": "gray"},
                    {"name": "Todo", "color": "default"},
                    {"name": "Pagar", "color": "blue"},
                    {"name": "Klar", "color": "green"},
                    {"name": "Parkerad", "color": "yellow"},
                ]
            }
        },
        "Prioritet": {
            "select": {
                "options": [
                    {"name": "Lag", "color": "gray"},
                    {"name": "Medel", "color": "yellow"},
                    {"name": "Hog", "color": "orange"},
                    {"name": "Kritisk", "color": "red"},
                ]
            }
        },
        "Sprint": {"relation": {"database_id": sprintar_database_id, "single_property": {}}},
        "Sprintdel": {"relation": {"database_id": sprintdelar_database_id, "single_property": {}}},
        "Agare": {"people": {}},
        "Estimat": {
            "select": {
                "options": [
                    {"name": "S", "color": "green"},
                    {"name": "M", "color": "yellow"},
                    {"name": "L", "color": "orange"},
                ]
            }
        },
        "Deadline": {"date": {}},
        "Notering": {"rich_text": {}},
    }


def sprint_template_blocks() -> List[Dict[str, Any]]:
    return [
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {"rich_text": title_text("Sprintmal")},
        },
        {
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": title_text("Beskriv sprintens viktigaste leverans.")},
        },
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {"rich_text": title_text("Definition of Done")},
        },
        {
            "object": "block",
            "type": "to_do",
            "to_do": {"rich_text": title_text("Krav uppfyllda"), "checked": False},
        },
        {
            "object": "block",
            "type": "to_do",
            "to_do": {"rich_text": title_text("Testat"), "checked": False},
        },
        {
            "object": "block",
            "type": "to_do",
            "to_do": {"rich_text": title_text("Dokumenterat"), "checked": False},
        },
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {"rich_text": title_text("Fokus denna sprint")},
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {"rich_text": title_text("Fokus 1")},
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {"rich_text": title_text("Fokus 2")},
        },
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {"rich_text": title_text("Risker / Blockers")},
        },
        {
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": title_text("Lista beroenden, blockerare och risker.")},
        },
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {"rich_text": title_text("Foreslagna sprintdelar")},
        },
        {
            "object": "block",
            "type": "numbered_list_item",
            "numbered_list_item": {"rich_text": title_text("Research")},
        },
        {
            "object": "block",
            "type": "numbered_list_item",
            "numbered_list_item": {"rich_text": title_text("Bygg")},
        },
        {
            "object": "block",
            "type": "numbered_list_item",
            "numbered_list_item": {"rich_text": title_text("Test och lansering")},
        },
        {
            "object": "block",
            "type": "callout",
            "callout": {
                "icon": {"emoji": "🧭"},
                "rich_text": title_text(
                    "Skapa lankade vyer manuellt: 1) Sprintdelar i denna sprint 2) Todos i denna sprint."
                ),
            },
        },
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create Smyra sprint setup in Notion.")
    parser.add_argument("--token", default=os.getenv("NOTION_TOKEN"), help="Notion integration token.")
    parser.add_argument(
        "--parent-page-id",
        default=os.getenv("NOTION_PARENT_PAGE_ID"),
        help="Notion page ID where databases will be created.",
    )
    parser.add_argument(
        "--notion-version",
        default=os.getenv("NOTION_VERSION", "2022-06-28"),
        help="Notion-Version header value.",
    )
    return parser.parse_args()


def require(value: Optional[str], name: str) -> str:
    if value:
        return value.strip()
    raise SystemExit(f"Missing required value: {name}")


def main() -> int:
    args = parse_args()
    token = require(args.token, "--token or NOTION_TOKEN")
    parent_page_id = require(args.parent_page_id, "--parent-page-id or NOTION_PARENT_PAGE_ID")
    notion = NotionClient(token=token, notion_version=args.notion_version)

    print("Creating database: Smyra Sprintar")
    sprintar_db = notion.create_database(
        parent_page_id=parent_page_id,
        title="Smyra Sprintar",
        properties=sprintar_properties(),
    )
    sprintar_id = sprintar_db["id"]
    print(f"  OK: {sprintar_id}")

    print("Creating database: Smyra Sprintdelar")
    sprintdelar_db = notion.create_database(
        parent_page_id=parent_page_id,
        title="Smyra Sprintdelar",
        properties=sprintdelar_properties(sprintar_id),
    )
    sprintdelar_id = sprintdelar_db["id"]
    print(f"  OK: {sprintdelar_id}")

    print("Creating database: Smyra Ideer & Todos")
    todos_db = notion.create_database(
        parent_page_id=parent_page_id,
        title="Smyra Ideer & Todos",
        properties=todos_properties(sprintar_id, sprintdelar_id),
    )
    todos_id = todos_db["id"]
    print(f"  OK: {todos_id}")

    print("Creating page: Sprintmall - duplicera mig")
    notion.create_page(
        parent_database_id=sprintar_id,
        properties={"Sprint": {"title": title_text("Sprintmall - duplicera mig")}},
        children=sprint_template_blocks(),
    )
    print("  OK")

    print("\nDone.")
    print("Next: open the Sprintmall page and add 2 linked views manually.")
    print("1) Sprintdelar i denna sprint: filter Sprint = Current page")
    print("2) Todos i denna sprint: filter Sprintdel -> Sprint = Current page")
    print(f"\nSprintar DB URL: {sprintar_db.get('url')}")
    print(f"Sprintdelar DB URL: {sprintdelar_db.get('url')}")
    print(f"Todos DB URL: {todos_db.get('url')}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as err:
        print(str(err), file=sys.stderr)
        raise SystemExit(1)
