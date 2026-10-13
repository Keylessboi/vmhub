"""FastMCP server wiring, optional bearer-token middleware, CLI entry point."""

from __future__ import annotations

import argparse
import hmac
import json
import os

from mcp.server.fastmcp import FastMCP

from .tools import ALL_TOOLS

INSTRUCTIONS = (
    "Windows reverse-engineering toolbox running inside a disposable lab VM. Tools wrap "
    "Sysinternals (sigcheck, strings, handle, listdlls, procdump, autorunsc, procmon), "
    "Detect It Easy, capa, FLOSS, ilspycmd, tshark and pefile. File paths must be under "
    "C:\\Users\\vmhub, C:\\Users\\Public, C:\\Tools\\re-samples, C:\\Windows\\Temp or RE_TOOLBOX_ROOTS. "
    "Results are dicts with exit_code/stdout/stderr/truncated/duration_s; failures come back as an "
    "'error' key (and 'missing_binary' if a tool is not installed). Start with tool_versions."
)


def build_server(host: str = "0.0.0.0", port: int = 8086) -> FastMCP:
    mcp = FastMCP("winre-toolbox", instructions=INSTRUCTIONS, host=host, port=port)
    for fn in ALL_TOOLS:
        mcp.add_tool(fn)
    return mcp


class BearerAuthMiddleware:
    """Pure-ASGI check of `Authorization: Bearer <token>` on HTTP requests."""

    def __init__(self, app, token: str):
        self.app = app
        self.token = token.encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        supplied = b""
        for k, v in scope.get("headers", []):
            if k == b"authorization":
                supplied = v
                break
        prefix = b"bearer "
        ok = supplied[:7].lower() == prefix and hmac.compare_digest(supplied[7:].strip(), self.token)
        if ok:
            await self.app(scope, receive, send)
            return
        body = json.dumps({"error": "unauthorized"}).encode()
        await send({"type": "http.response.start", "status": 401, "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"www-authenticate", b"Bearer"),
        ]})
        await send({"type": "http.response.body", "body": body})


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="winre_toolbox_mcp", description="Windows RE toolbox MCP server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8086)
    ap.add_argument("--transport", choices=["streamable-http", "stdio"], default="streamable-http")
    args = ap.parse_args(argv)

    mcp = build_server(args.host, args.port)
    if args.transport == "stdio":
        mcp.run(transport="stdio")
        return
    token = os.environ.get("RE_TOOLBOX_TOKEN")
    if not token:
        mcp.run(transport="streamable-http")
        return
    import uvicorn

    app = BearerAuthMiddleware(mcp.streamable_http_app(), token)
    uvicorn.run(app, host=args.host, port=args.port, log_level=mcp.settings.log_level.lower())


if __name__ == "__main__":
    main()
