import asyncio
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from re_toolbox_mcp.server import BearerAuthMiddleware, build_server
from re_toolbox_mcp.tools import ALL_TOOLS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPECTED = {
    "strace_run", "ltrace_run", "valgrind_run", "binwalk_scan", "yara_scan", "upx_info",
    "upx_unpack", "file_info", "qemu_user_run", "angr_cfg", "angr_find",
    "mitm_capture_start", "mitm_capture_stop", "mitm_flows", "tool_versions",
}


def test_stdio_lists_and_calls_tools():
    async def go():
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "re_toolbox_mcp", "--transport", "stdio"],
            env={**os.environ, "PYTHONPATH": ROOT},
        )
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                listed = await s.list_tools()
                names = {t.name for t in listed.tools}
                assert all(t.description for t in listed.tools)
                res = await s.call_tool("tool_versions", {})
                assert not res.isError
                bad = await s.call_tool("file_info", {"path": "/etc/shadow"})
                assert "outside allowed roots" in bad.content[0].text
                return names

    assert asyncio.run(go()) == EXPECTED


def test_all_tools_registered_with_docstrings():
    assert {f.__name__ for f in ALL_TOOLS} == EXPECTED
    assert all(f.__doc__ for f in ALL_TOOLS)
    build_server()


def test_bearer_middleware():
    sent = []

    async def app(scope, receive, send):
        sent.append("app")

    async def run(headers):
        out = []

        async def send(m):
            out.append(m)

        await BearerAuthMiddleware(app, "s3cret")({"type": "http", "headers": headers}, None, send)
        return out

    assert asyncio.run(run([]))[0]["status"] == 401
    assert asyncio.run(run([(b"authorization", b"Bearer nope")]))[0]["status"] == 401
    assert sent == []
    asyncio.run(run([(b"authorization", b"Bearer s3cret")]))
    assert sent == ["app"]
