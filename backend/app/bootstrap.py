from sqlalchemy import func, select

from app.config import settings
from app.database import SessionLocal
from app.models import PlatformOperator, Store, TenantStatus, User, UserRole
from app.security import hash_password


def bootstrap_accounts() -> None:
    with SessionLocal.begin() as db:
        if settings.bootstrap_platform_email and settings.bootstrap_platform_password:
            operator_email = str(settings.bootstrap_platform_email).lower()
            operator = db.scalar(
                select(PlatformOperator).where(func.lower(PlatformOperator.email) == operator_email)
            )
            if operator is None:
                operator_password = settings.bootstrap_platform_password.get_secret_value()
                if len(operator_password) < 14:
                    raise RuntimeError(
                        "The platform operator password must be at least 14 characters."
                    )
                db.add(
                    PlatformOperator(
                        name=settings.bootstrap_platform_name,
                        email=operator_email,
                        password_hash=hash_password(operator_password),
                    )
                )
            else:
                operator.name = settings.bootstrap_platform_name.strip()

        if settings.bootstrap_admin_email and settings.bootstrap_admin_password:
            if settings.environment == "production":
                raise RuntimeError(
                    "Do not create a tenant administrator through global bootstrap in production; "
                    "provision each pharmacy through the platform console."
                )
            if db.scalar(select(User.id).limit(1)) is None:
                password = settings.bootstrap_admin_password.get_secret_value()
                if len(password) < 12:
                    raise RuntimeError(
                        "The bootstrap administrator password must be at least 12 characters."
                    )
                store = Store(
                    name=settings.bootstrap_store_name,
                    tenant_status=TenantStatus.ACTIVE,
                )
                db.add(store)
                db.flush()
                db.add(
                    User(
                        store_id=store.id,
                        name=settings.bootstrap_admin_name,
                        email=str(settings.bootstrap_admin_email).lower(),
                        password_hash=hash_password(password),
                        role=UserRole.OWNER,
                    )
                )
    if settings.bootstrap_platform_email and settings.bootstrap_platform_password:
        print("Ensured the initial platform operator account exists.")
    if settings.bootstrap_admin_email and settings.bootstrap_admin_password:
        print("Ensured the initial development store administrator account exists.")


if __name__ == "__main__":
    bootstrap_accounts()
