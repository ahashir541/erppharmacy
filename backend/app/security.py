from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from jose import JWTError, jwt
from pwdlib import PasswordHash

from app.config import settings

ALGORITHM = "HS256"
password_hash = PasswordHash.recommended()


@dataclass(frozen=True)
class AccessToken:
    user_id: UUID
    token_type: str
    auth_version: int


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    return password_hash.verify(password, hashed_password)


def create_access_token(
    user_id: UUID,
    *,
    token_type: str = "tenant",
    auth_version: int = 0,
) -> str:
    expires = datetime.now(timezone.utc) + timedelta(
        minutes=settings.access_token_minutes
    )
    return jwt.encode(
        {
            "sub": str(user_id),
            "type": token_type,
            "ver": auth_version,
            "exp": expires,
        },
        settings.jwt_secret_key.get_secret_value(),
        algorithm=ALGORITHM,
    )


def decode_access_token(token: str, *, token_type: str = "tenant") -> AccessToken | None:
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key.get_secret_value(),
            algorithms=[ALGORITHM],
        )
        if payload.get("type") != token_type:
            return None
        return AccessToken(
            user_id=UUID(payload["sub"]),
            token_type=token_type,
            auth_version=int(payload.get("ver", 0)),
        )
    except (JWTError, KeyError, ValueError):
        return None
