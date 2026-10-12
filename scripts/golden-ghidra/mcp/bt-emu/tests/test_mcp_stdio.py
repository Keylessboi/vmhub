"""Spawns the server as a subprocess over stdio and talks to it with the MCP client."""

import json
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

EXPECTED = {
    "list_profiles", "load_profile", "lab_create", "lab_reset", "device_create", "device_remove", "list_devices",
    "adv_start", "adv_stop", "adv_set_data", "gatt_read", "gatt_write", "gatt_notify", "gatt_dump",
    "central_scan", "central_connect", "central_discover", "central_read", "central_write", "central_subscribe",
    "central_notifications", "a2dp_status", "hci_log_start", "hci_log_stop", "send_scripted_notifications",
}


def payload(result):
    if result.structuredContent:
        return result.structuredContent.get("result", result.structuredContent)
    return json.loads(result.content[0].text)


async def test_stdio_lists_tools_and_runs_a_flow():
    params = StdioServerParameters(command=sys.executable, args=["-m", "bt_emu_mcp", "--transport", "stdio"])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = {t.name: t for t in (await session.list_tools()).tools}
            assert EXPECTED <= set(tools)
            assert all(t.description for t in tools.values())

            profiles = payload(await session.call_tool("list_profiles", {}))
            assert {p["name"] for p in profiles["profiles"]} == {"generic-earbud", "pixel-buds-pro-2", "soundcore-q30"}

            bud = payload(await session.call_tool("device_create", {"profile": "generic-earbud"}))
            assert bud["ok"], bud
            err = payload(await session.call_tool("adv_start", {"device_id": "missing"}))
            assert err["ok"] is False and "Traceback" not in err["error"]


async def test_streamable_http_transport():
    import asyncio
    import socket

    from mcp.client.streamable_http import streamablehttp_client

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "bt_emu_mcp", "--host", "127.0.0.1", "--port", str(port),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        for _ in range(50):
            try:
                _, w = await asyncio.open_connection("127.0.0.1", port)
                w.close()
                break
            except OSError:
                await asyncio.sleep(0.1)
        async with streamablehttp_client(f"http://127.0.0.1:{port}/mcp") as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                names = {t.name for t in (await session.list_tools()).tools}
                assert EXPECTED <= names
    finally:
        proc.terminate()
        await proc.wait()
