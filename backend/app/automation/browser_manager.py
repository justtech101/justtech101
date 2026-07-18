"""
Thin wrapper around Playwright. This is the ONLY module that imports
`playwright` directly -- form_filler.py and everything above it talks to
this interface, so an alternative driver (Browser Use, Stagehand, etc.) can
be swapped in later by re-implementing this same surface
(open/goto/fill_field/upload_file/screenshot/close) without touching the
orchestration logic in form_filler.py.

MANUAL SETUP REQUIRED:
  After `pip install -r requirements.txt`, install the browser binary once:
    playwright install chromium
  (On the Surface Pro / ARM client this is a one-time ~150MB download.)
"""
import logging
from pathlib import Path

from playwright.async_api import Browser, BrowserContext, Page, async_playwright

logger = logging.getLogger(__name__)

# Common CAPTCHA widget markers. If any of these selectors are found on the
# page, we stop immediately -- this tool never attempts to solve a CAPTCHA.
CAPTCHA_SELECTORS = [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "div.g-recaptcha",
    "div.h-captcha",
    "iframe[title*='challenge']",
    "#cf-challenge-running",  # Cloudflare Turnstile challenge page
]

# Network paths that look like a final form submission. When running in
# dry_run mode these requests are intercepted and aborted -- a second,
# independent safety net on top of "we never click submit".
SUBMIT_URL_HINTS = ["/submit", "/apply", "/application", "/save", "/checkout"]


class CaptchaEncounteredError(RuntimeError):
    pass


class BrowserManager:
    def __init__(self, *, dry_run: bool, screenshot_dir: Path, headless: bool = True):
        self.dry_run = dry_run
        self.screenshot_dir = screenshot_dir
        self.headless = headless
        self._playwright = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self.page: Page | None = None

    async def start(self) -> None:
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(headless=self.headless)
        self._context = await self._browser.new_context()
        self.page = await self._context.new_page()

        if self.dry_run:
            # Block any request that looks like a real submission. This is a
            # defense-in-depth measure -- form_filler.py never clicks a
            # submit button in the first place.
            await self.page.route("**/*", self._maybe_block_submit)

    async def _maybe_block_submit(self, route, request) -> None:
        if request.method in ("POST", "PUT") and any(hint in request.url.lower() for hint in SUBMIT_URL_HINTS):
            logger.warning("[DRY RUN] Blocked outbound submit-like request: %s %s", request.method, request.url)
            await route.abort()
            return
        await route.continue_()

    async def goto(self, url: str) -> None:
        assert self.page is not None, "call start() first"
        await self.page.goto(url, wait_until="domcontentloaded")
        await self.check_for_captcha()

    async def check_for_captcha(self) -> None:
        assert self.page is not None
        for selector in CAPTCHA_SELECTORS:
            locator = self.page.locator(selector)
            if await locator.count() > 0:
                raise CaptchaEncounteredError(
                    f"CAPTCHA widget detected ({selector}) on {self.page.url}. "
                    "Stopping -- this tool never attempts to solve CAPTCHAs. "
                    "Complete this step manually, then resume."
                )

    async def fill_field(self, selector: str, value: str) -> None:
        assert self.page is not None
        await self.page.locator(selector).fill(value)

    async def select_option(self, selector: str, value: str) -> None:
        assert self.page is not None
        await self.page.locator(selector).select_option(value)

    async def check_checkbox(self, selector: str, checked: bool = True) -> None:
        assert self.page is not None
        locator = self.page.locator(selector)
        if checked:
            await locator.check()
        else:
            await locator.uncheck()

    async def upload_file(self, selector: str, file_path: str) -> None:
        assert self.page is not None
        resolved = Path(file_path)
        if not resolved.exists():
            raise FileNotFoundError(f"Upload file not found: {file_path}")
        await self.page.locator(selector).set_input_files(str(resolved))

    async def screenshot(self, *, application_id: str, step: str) -> Path:
        assert self.page is not None
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        safe_step = "".join(c if c.isalnum() or c in "-_." else "_" for c in step)
        out_path = self.screenshot_dir / f"{application_id}__{safe_step}.png"
        await self.page.screenshot(path=str(out_path), full_page=True)
        return out_path

    async def close(self) -> None:
        if self._context:
            await self._context.close()
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
