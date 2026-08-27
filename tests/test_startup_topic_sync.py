"""The service must subscribe to known uplink topics when it starts.

_sync_topics() used to be reachable only from the device import and create
routes, so restarting the process left the MQTT listener subscribed to nothing
and every uplink was silently dropped until a device was added again.
"""

import ast
from pathlib import Path

APP_PY = Path(__file__).resolve().parent.parent / "app.py"


def _module_level_calls(source: str) -> set[str]:
    tree = ast.parse(source)
    calls = set()
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            func = node.value.func
            if isinstance(func, ast.Name):
                calls.add(func.id)
    return calls


def test_topics_are_synced_at_import_time():
    calls = _module_level_calls(APP_PY.read_text(encoding="utf-8"))
    assert "_sync_topics_at_startup" in calls, (
        "app.py must sync uplink topics at startup, or a restart ingests nothing"
    )


def test_startup_sync_swallows_errors():
    """A broker or credential problem must not stop the app from serving."""
    source = APP_PY.read_text(encoding="utf-8")
    tree = ast.parse(source)
    fn = next(
        n for n in tree.body
        if isinstance(n, ast.FunctionDef) and n.name == "_sync_topics_at_startup"
    )
    assert any(isinstance(n, ast.Try) for n in ast.walk(fn)), (
        "_sync_topics_at_startup must guard against exceptions"
    )
