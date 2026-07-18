"""
IMAP email-alert ingestor. Reads job/grant alert emails (LinkedIn, Indeed,
Grants.gov saved-search digests, etc.) from a mailbox and extracts postings
by pulling links + surrounding text out of the HTML body. This never invents
data: if a field can't be found in the email body, it's left blank.

MANUAL SETUP REQUIRED:
  1. Use an app password, not your real email password (Gmail: Google
     Account -> Security -> App passwords; Outlook: similar).
  2. Store the mailbox username/password as environment variables -- do NOT
     put credentials directly in the `ingestion_sources.config` JSON, which
     is stored in plaintext in the DB. Reference them by env var name:

        {
          "imap_host": "imap.gmail.com",
          "imap_port": 993,
          "username_env": "JUSTTECH_ALERT_EMAIL_USERNAME",
          "password_env": "JUSTTECH_ALERT_EMAIL_APP_PASSWORD",
          "mailbox": "INBOX",
          "sender_filter": "jobalerts-noreply@linkedin.com",
          "since_days": 1
        }

  3. Set JUSTTECH_ALERT_EMAIL_USERNAME and JUSTTECH_ALERT_EMAIL_APP_PASSWORD
     in your .env file (see /.env.example).
"""
import asyncio
import email
import imaplib
import logging
import os
import re
from datetime import datetime, timedelta
from email.header import decode_header
from html import unescape

from app.schemas.opportunity import OpportunityIngest
from app.services import extraction
from app.services.ingestion.base import Ingestor

logger = logging.getLogger(__name__)

LINK_PATTERN = re.compile(r'href="(https?://[^"]+)"')
TAG_STRIP_PATTERN = re.compile(r"<[^>]+>")


class EmailAlertIngestor(Ingestor):
    def __init__(self, *, name: str, config: dict, opportunity_type: str):
        super().__init__(name=name, config=config)
        self.opportunity_type = opportunity_type
        self.host = config.get("imap_host")
        self.port = int(config.get("imap_port", 993))
        self.username = os.environ.get(config.get("username_env", ""), "")
        self.password = os.environ.get(config.get("password_env", ""), "")
        self.mailbox = config.get("mailbox", "INBOX")
        self.sender_filter = config.get("sender_filter")
        self.since_days = int(config.get("since_days", 1))

        if not self.host:
            raise ValueError(f"Email ingestor '{name}' is missing config.imap_host")
        if not self.username or not self.password:
            raise ValueError(
                f"Email ingestor '{name}' could not resolve credentials from "
                f"env vars '{config.get('username_env')}' / '{config.get('password_env')}'. "
                "Set them in your .env file."
            )

    async def fetch(self) -> list[OpportunityIngest]:
        return await asyncio.to_thread(self._fetch_sync)

    def _fetch_sync(self) -> list[OpportunityIngest]:
        results: list[OpportunityIngest] = []
        try:
            conn = imaplib.IMAP4_SSL(self.host, self.port)
            conn.login(self.username, self.password)
            conn.select(self.mailbox)

            since_date = (datetime.now() - timedelta(days=self.since_days)).strftime("%d-%b-%Y")
            criteria = f'(SINCE "{since_date}")'
            if self.sender_filter:
                criteria = f'(SINCE "{since_date}" FROM "{self.sender_filter}")'

            status, msg_ids = conn.search(None, criteria)
            if status != "OK":
                logger.warning("IMAP search failed for source '%s'", self.name)
                return []

            for msg_id in msg_ids[0].split():
                status, msg_data = conn.fetch(msg_id, "(RFC822)")
                if status != "OK" or not msg_data or not msg_data[0]:
                    continue
                raw_email = msg_data[0][1]
                message = email.message_from_bytes(raw_email)
                try:
                    results.extend(self._parse_message(message))
                except Exception:
                    logger.exception("Skipping malformed email in '%s'", self.name)
                    continue

            conn.close()
            conn.logout()
        except imaplib.IMAP4.error:
            logger.exception("IMAP connection/auth failed for source '%s'", self.name)
            return []
        return results

    def _parse_message(self, message) -> list[OpportunityIngest]:
        subject = self._decode_subject(message.get("Subject", ""))
        html_body = self._extract_html_body(message)
        if not html_body:
            return []

        links = LINK_PATTERN.findall(html_body)
        text = unescape(TAG_STRIP_PATTERN.sub(" ", html_body))
        text = re.sub(r"\s+", " ", text).strip()

        if not links:
            return []

        # Alert digest emails usually contain one posting title per tracked
        # link; we can't reliably split per-posting text without a
        # site-specific parser, so we record the digest as a single
        # low-confidence opportunity per unique destination link and flag it
        # for human review via missing_fields.
        seen_links = list(dict.fromkeys(links))[:20]  # de-dupe, cap per digest
        results = []
        for link in seen_links:
            results.append(
                OpportunityIngest(
                    type=self.opportunity_type,
                    source=f"email:{self.name}",
                    source_url=link,
                    title=subject or "(untitled email alert)",
                    description=text[:2000],
                    deadline=extraction.extract_deadline(text),
                    required_documents=extraction.extract_required_documents(text),
                    application_questions=[],
                    raw_data={"email_subject": subject, "note": "parsed from email digest -- verify details manually"},
                )
            )
        return results

    @staticmethod
    def _decode_subject(raw_subject: str) -> str:
        parts = decode_header(raw_subject)
        decoded = ""
        for part, encoding in parts:
            if isinstance(part, bytes):
                decoded += part.decode(encoding or "utf-8", errors="replace")
            else:
                decoded += part
        return decoded.strip()

    @staticmethod
    def _extract_html_body(message) -> str:
        if message.is_multipart():
            for part in message.walk():
                if part.get_content_type() == "text/html":
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        return payload.decode(charset, errors="replace")
        else:
            if message.get_content_type() == "text/html":
                payload = message.get_payload(decode=True)
                if payload:
                    charset = message.get_content_charset() or "utf-8"
                    return payload.decode(charset, errors="replace")
        return ""
