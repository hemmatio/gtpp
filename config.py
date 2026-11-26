"""Configuration constants and time helpers for GOTracker++."""

from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "gotracker.db"
VAPID_PATH = DATA_DIR / "vapid.json"
STATIC_DIR = BASE_DIR / "static"

DEFAULT_PORT = 29843
GOTRACKER_BASE = "https://www.gotracker.ca/gotracker/mobile/proxy/web"
TORONTO_TZ = ZoneInfo("America/Toronto")

POLL_INTERVAL_ACTIVE = 20
POLL_INTERVAL_IDLE = 45
CATALOG_REFRESH_SEC = 6 * 3600
STATION_MSG_REFRESH_SEC = 300
SNAPSHOT_HEARTBEAT_SEC = 120

MINOR_DELAY_SEC = 180
MAJOR_DELAY_SEC = 600
SERVICE_GUARANTEE_SEC = 900

PINS_NAME_MAPPING = {
    "OS": "DC Oshawa",
    "AD": "Allandale",
    "GL": "Guelph",
    "HA": "Hamilton",
    "DW": "Downsview Park",
    "MO": "Mount Pleasant",
    "NI": "Niagara",
    "SCTH": "St. Catharines",
    "LN": "London",
    "SF": "Stratford",
    "SM": "St. Marys",
}

UNION_COORDS = {
    "code": "UN",
    "name": "Union Station",
    "latitude": 43.645195,
    "longitude": -79.380600,
}


def now_toronto() -> datetime:
    """Return the current timezone-aware datetime in America/Toronto."""
    return datetime.now(TORONTO_TZ)


def today_service_date(dt: datetime | None = None) -> str:
    """Return the GO Transit operational service date (YYYY-MM-DD, rolls over at 04:00)."""
    current = dt.astimezone(TORONTO_TZ) if dt else now_toronto()
    if current.hour < 4:
        current = current - timedelta(days=1)
    return current.strftime("%Y-%m-%d")
