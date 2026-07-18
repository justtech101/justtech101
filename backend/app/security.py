"""
Symmetric encryption for credentials at rest.

MANUAL SETUP REQUIRED:
  Generate a key once and put it in your .env as JUSTTECH_ENCRYPTION_KEY:

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

  This key is NOT derived from anything else and is NOT stored in the
  database. If it is lost, every row in the `credentials` table becomes
  permanently undecryptable -- back it up somewhere safe (a password
  manager, not the git repo).
"""
from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class EncryptionNotConfiguredError(RuntimeError):
    pass


def _fernet() -> Fernet:
    settings = get_settings()
    if not settings.JUSTTECH_ENCRYPTION_KEY:
        raise EncryptionNotConfiguredError(
            "JUSTTECH_ENCRYPTION_KEY is not set. Generate one with: "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\" "
            "and add it to your .env file."
        )
    return Fernet(settings.JUSTTECH_ENCRYPTION_KEY.encode())


def encrypt_value(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_value(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise EncryptionNotConfiguredError(
            "Could not decrypt credential -- JUSTTECH_ENCRYPTION_KEY does not match "
            "the key used to encrypt this value."
        ) from exc
