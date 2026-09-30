from uuid import UUID

from sqlalchemy.orm import Session

from app.models import AuditLog, User


def record_audit(
    db: Session,
    user: User,
    action: str,
    entity_type: str,
    entity_id: UUID | str,
    details: str,
) -> None:
    db.add(
        AuditLog(
            store_id=user.store_id,
            user_id=user.id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            details=details,
        )
    )
