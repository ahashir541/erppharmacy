from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException


def get_store_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Timezone must be a valid IANA timezone.") from error


def local_date_bounds(
    start_date: date,
    end_date: date,
    zone: ZoneInfo,
) -> tuple[datetime, datetime]:
    start = datetime.combine(start_date, time.min, zone).astimezone(timezone.utc)
    end = datetime.combine(end_date + timedelta(days=1), time.min, zone).astimezone(timezone.utc)
    return start, end


def local_date(value: datetime, zone: ZoneInfo) -> date:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(zone).date()
