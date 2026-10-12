import pytest_asyncio

from bt_emu_mcp.lab import LAB


@pytest_asyncio.fixture(autouse=True)
async def clean_lab():
    await LAB.reset("local-link")
    yield
    await LAB.reset("local-link")
