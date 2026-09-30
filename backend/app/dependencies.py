from collections.abc import Callable
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import PlatformOperator, Store, TenantStatus, User, UserRole
from app.security import decode_access_token

bearer_scheme = HTTPBearer(auto_error=False)


def get_authenticated_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in to continue.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = decode_access_token(credentials.credentials)
    user = db.get(User, token.user_id) if token else None
    if user is None or not user.is_active or token.auth_version != user.auth_version:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your session is invalid or expired. Sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if db.get(Store, user.store_id) is None:
        raise HTTPException(status_code=403, detail="This pharmacy account is unavailable.")
    return user


def get_current_user(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> User:
    store = db.get(Store, user.store_id)
    if store is None:
        raise HTTPException(status_code=403, detail="This pharmacy account is unavailable.")
    if store.tenant_status in {TenantStatus.SUSPENDED, TenantStatus.CANCELLED}:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="This pharmacy account is inactive. Contact your MedFlow account manager.",
        )
    if store.tenant_status == TenantStatus.TRIAL:
        expires = store.trial_ends_at
        if expires is None:
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail="This pharmacy trial has ended. Contact your MedFlow account manager.",
            )
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= datetime.now(timezone.utc):
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail="This pharmacy trial has ended. Contact your MedFlow account manager.",
            )
    if store.subscription_expires_at:
        subscription_end = store.subscription_expires_at
        if subscription_end.tzinfo is None:
            subscription_end = subscription_end.replace(tzinfo=timezone.utc)
        if subscription_end <= datetime.now(timezone.utc):
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail="This pharmacy subscription has expired. Visit billing to submit payment.",
            )
    return user


def get_current_platform_operator(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> PlatformOperator:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Platform operator sign-in is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = decode_access_token(credentials.credentials, token_type="platform")
    operator = db.get(PlatformOperator, token.user_id) if token else None
    if (
        operator is None
        or not operator.is_active
        or not settings.bootstrap_platform_email
        or operator.email.lower() != str(settings.bootstrap_platform_email).lower()
        or token.auth_version != operator.auth_version
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Platform operator session is invalid or expired.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return operator


def require_roles(*roles: UserRole) -> Callable:
    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have permission to perform this action.",
            )
        return user

    return dependency
