from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_authenticated_user, get_current_user
from app.models import AuditLog, Store, User
from app.schemas import LoginRequest, PasswordChange, TokenResponse, UserRead
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["authentication"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.scalar(
        select(User).where(func.lower(User.email) == str(payload.email).lower())
    )
    if user is None or not user.is_active or not verify_password(
        payload.password, user.password_hash
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Email or password is incorrect.",
        )
    store = db.get(Store, user.store_id)
    if store is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This pharmacy account is unavailable.",
        )
    db.add(
        AuditLog(
            store_id=user.store_id,
            user_id=user.id,
            action="login",
            entity_type="user",
            entity_id=str(user.id),
            details="Successful sign-in",
        )
    )
    db.commit()
    return TokenResponse(
        access_token=create_access_token(user.id, auth_version=user.auth_version),
        user=UserRead.model_validate(user),
    )


@router.get("/me", response_model=UserRead)
def read_current_user(
    user: User = Depends(get_authenticated_user),
) -> UserRead:
    return UserRead.model_validate(user)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChange,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect.",
        )
    user.password_hash = hash_password(payload.new_password)
    user.auth_version += 1
    db.add(
        AuditLog(
            store_id=user.store_id,
            user_id=user.id,
            action="password.changed",
            entity_type="user",
            entity_id=str(user.id),
            details="Password changed; all existing sessions revoked.",
        )
    )
    db.commit()
